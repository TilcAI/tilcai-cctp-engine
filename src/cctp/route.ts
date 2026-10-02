import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { cctpVersions, domainOf, familyOf, nameOf, usdcDecimals, type ChainKey } from "../config/chains.js";
import { myAddresses } from "../lib/env.js";
import { mintTargetFor, toUnits, fromUnits, type Hex } from "../lib/encoding.js";
import { FORWARD_HOOK, getFeeBps, getForwardFee, maxFeeFor, waitForAttestation, waitForForward } from "../lib/iris.js";
import { log } from "../lib/log.js";
import { evmBurn, evmReceive, evmSender, type EvmKey } from "./evm.js";
import { solBurn, solReceive, ensureUsdcAta } from "./solana.js";
import { suiBurn, suiReceive } from "./sui.js";
import { stellarBurn, stellarMintAndForward, ensureUsdcTrustline, stellarSender } from "./stellar.js";
import { getBalance } from "../lib/balances.js";

export type CctpPlan =
  | { kind: "direct"; version: 1 | 2 }
  | { kind: "unsupported"; reason: string; suggestedHop?: ChainKey };

/** Decide la versión de CCTP para un par: V2 si ambos la tienen; si no V1; si no, no hay ruta directa. */
export function planCctp(src: ChainKey, dst: ChainKey): CctpPlan {
  if (src === dst) return { kind: "unsupported", reason: "misma chain" };
  const a = cctpVersions(src);
  const b = cctpVersions(dst);
  if (a.includes(2) && b.includes(2)) return { kind: "direct", version: 2 };
  if (a.includes(1) && b.includes(1)) return { kind: "direct", version: 1 };
  return {
    kind: "unsupported",
    reason: `${nameOf(src)} soporta CCTP v${a.join("/")} y ${nameOf(dst)} sólo v${b.join("/")}: los mensajes V1 y V2 no son intercambiables`,
    suggestedHop: "base",
  };
}

export interface TransferResult {
  protocol: "CCTP";
  version: 1 | 2;
  src: ChainKey;
  dst: ChainKey;
  amount: string;
  mode: "fast" | "standard";
  forwarded?: boolean;
  forwardFee?: string;
  recipient: string;
  burnTx?: string;
  mintTx?: string;
  attestationSeconds?: number;
  totalSeconds?: number;
  feeBps?: number;
  maxFee?: string;
  balancesBefore?: Record<string, string>;
  balancesAfter?: Record<string, string>;
  status: "ok" | "error" | "skipped";
  error?: string;
  startedAt: string;
}

/** Cuenta propia en una chain: la del relayer OZ si EXECUTOR=relayer (EVM/Stellar), si no la wallet local. */
export async function ownerOf(chain: ChainKey): Promise<string> {
  if (familyOf(chain) === "evm") return evmSender(chain as EvmKey);
  if (chain === "stellar") return stellarSender();
  const r = myAddresses()[familyOf(chain)];
  if (!r) throw new Error(`No hay wallet/dirección configurada para ${nameOf(chain)}`);
  return r;
}

/**
 * Ejecuta una transferencia CCTP completa src → dst:
 *  1) burn en origen  2) espera atestación Iris  3) mint (receiveMessage) en destino.
 */
export async function cctpTransfer(opts: {
  src: ChainKey;
  dst: ChainKey;
  amount: string; // en USDC, p.ej. "0.1"
  fast?: boolean;
  recipient?: string;
  /** Circle Forwarding Service: Circle ejecuta el mint en destino (no se necesita gas allí). */
  forward?: boolean;
}): Promise<TransferResult> {
  const { src, dst, amount } = opts;
  const t0 = Date.now();
  const plan = planCctp(src, dst);
  const recipient = opts.recipient ?? (await ownerOf(dst));
  const res: TransferResult = {
    protocol: "CCTP",
    version: plan.kind === "direct" ? plan.version : 2,
    src,
    dst,
    amount,
    mode: opts.fast ? "fast" : "standard",
    recipient,
    status: "error",
    startedAt: new Date().toISOString(),
  };
  if (plan.kind !== "direct") {
    res.status = "skipped";
    res.error = plan.reason;
    log.warn(`${nameOf(src)} → ${nameOf(dst)}: ${plan.reason}. Ruta alternativa: ${src} → ${plan.suggestedHop} → ${dst}`);
    return res;
  }
  const version = plan.version;
  const srcDomain = domainOf(src);
  const dstDomain = domainOf(dst);
  // V1 no tiene Fast Transfer ni fees on-chain.
  const finality: 1000 | 2000 = version === 2 && opts.fast ? 1000 : 2000;

  try {
    log.step(0, `CCTP v${version} ${nameOf(src)} (domain ${srcDomain}) → ${nameOf(dst)} (domain ${dstDomain}), ${amount} USDC, ${finality === 1000 ? "FAST" : "STANDARD"}`);
    const srcOwner = await ownerOf(src);
    res.balancesBefore = { [src]: await getBalance(src, srcOwner), [dst]: await getBalance(dst, recipient) };
    log.info(`Saldos antes: ${JSON.stringify(res.balancesBefore)}`);

    // Pre-requisitos del destino
    if (dst === "solana") await ensureUsdcAta(new PublicKey(recipient));
    if (dst === "stellar" && recipient === (await ownerOf("stellar"))) await ensureUsdcTrustline();

    const target = mintTargetFor(dst, recipient);
    // Forwarding Service: sólo V2 y destinos sin hook propio (Stellar usa CctpForwarder).
    let forward = Boolean(opts.forward);
    if (forward && (version !== 2 || target.hookData)) {
      log.warn(`Forwarding Service no disponible para ${nameOf(dst)} (CCTP v${version}); el mint se hará manualmente`);
      forward = false;
    }
    if (forward) {
      target.hookData = FORWARD_HOOK;
      res.forwarded = true;
    }
    log.info(`mintRecipient = ${target.mintRecipient} (${target.note})`);
    log.info(`destinationCaller = ${target.destinationCaller}${target.hookData ? `, hookData = ${target.hookData}` : ""}`);

    // Fees (sólo V2): bps del API → maxFee en unidades locales del origen
    const srcDec = usdcDecimals(src);
    const amountUnits = toUnits(amount, srcDec);
    let maxFee = 0n;
    if (version === 2) {
      const bps = await getFeeBps(srcDomain, dstDomain);
      res.feeBps = finality === 1000 ? bps.fast : bps.standard;
      maxFee = maxFeeFor(amountUnits, res.feeBps);
      if (forward) {
        // forwardFee viene en unidades canónicas (6 dec); se pasa a decimales del origen
        const ff = (await getForwardFee(srcDomain, dstDomain)).high * 10n ** BigInt(srcDec - 6);
        res.forwardFee = fromUnits(ff, srcDec);
        maxFee += ff;
      }
      res.maxFee = fromUnits(maxFee, srcDec);
      log.info(`fee protocolo ${res.feeBps} bps${forward ? ` + forwarding ${res.forwardFee} USDC` : ""} → maxFee ${res.maxFee} USDC`);
    }

    // 1) BURN
    log.step(1, `burn en ${nameOf(src)}`);
    let burnTx: string;
    let messageFromSource: Hex | undefined;
    switch (familyOf(src)) {
      case "evm":
        burnTx = await evmBurn({
          key: src as EvmKey,
          amount: amountUnits,
          destinationDomain: dstDomain,
          mintRecipient: target.mintRecipient,
          destinationCaller: target.destinationCaller,
          maxFee,
          minFinalityThreshold: finality,
          hookData: target.hookData,
          version,
        });
        break;
      case "solana":
        burnTx = await solBurn({
          amount: amountUnits,
          destinationDomain: dstDomain,
          mintRecipient: target.mintRecipient,
          destinationCaller: target.destinationCaller,
          maxFee,
          minFinalityThreshold: finality,
          hookData: target.hookData,
          version,
        });
        break;
      case "sui": {
        const r = await suiBurn({ amount: amountUnits, destinationDomain: dstDomain, mintRecipient: target.mintRecipient });
        burnTx = r.digest;
        messageFromSource = r.message;
        break;
      }
      case "stellar":
        burnTx = await stellarBurn({
          amount7: amountUnits,
          destinationDomain: dstDomain,
          mintRecipient: target.mintRecipient,
          destinationCaller: target.destinationCaller,
          maxFee7: maxFee,
          minFinalityThreshold: finality,
          hookData: target.hookData,
        });
        break;
    }
    res.burnTx = burnTx;
    if (messageFromSource) log.info(`MessageSent (evento on-chain): ${messageFromSource.slice(0, 66)}…`);

    if (forward) {
      log.step(2, "Forwarding Service: Circle atesta y ejecuta receiveMessage en destino");
      const tA = Date.now();
      const m = await waitForForward(srcDomain, burnTx);
      res.attestationSeconds = Math.round((Date.now() - tA) / 1000);
      res.mintTx = m.forwardTxHash;
      log.ok(`mint ejecutado por Circle: ${m.forwardTxHash} (feeExecuted ${(m.decodedMessage as any)?.decodedMessageBody?.feeExecuted})`);
      res.balancesAfter = { [src]: await getBalance(src, srcOwner), [dst]: await getBalance(dst, recipient) };
      log.info(`Saldos después: ${JSON.stringify(res.balancesAfter)}`);
      res.status = "ok";
      res.totalSeconds = Math.round((Date.now() - t0) / 1000);
      saveResult(res);
      return res;
    }

    // 2) ATTESTATION
    log.step(2, `esperando atestación de Circle (Iris) para ${burnTx}`);
    const tA = Date.now();
    const att = await waitForAttestation(srcDomain, burnTx);
    res.attestationSeconds = Math.round((Date.now() - tA) / 1000);
    const message = att.message as Hex;
    const attestation = att.attestation as Hex;

    // 3) MINT
    log.step(3, `mint en ${nameOf(dst)}`);
    res.mintTx = await mintOnDest(dst, version, message, attestation);
    res.balancesAfter = { [src]: await getBalance(src, srcOwner), [dst]: await getBalance(dst, recipient) };
    log.info(`Saldos después: ${JSON.stringify(res.balancesAfter)}`);
    res.status = "ok";
    res.totalSeconds = Math.round((Date.now() - t0) / 1000);
    log.ok(`Transferencia completada en ${res.totalSeconds} s`);
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    log.err(res.error);
  }
  saveResult(res);
  return res;
}

/** Paso 3: mint en destino con el adaptador de su familia. */
export async function mintOnDest(dst: ChainKey, version: 1 | 2, message: Hex, attestation: Hex): Promise<string> {
  switch (familyOf(dst)) {
    case "evm":
      return evmReceive(dst as EvmKey, message, attestation, version);
    case "solana":
      return solReceive(message, attestation, version);
    case "sui":
      return suiReceive(message, attestation);
    case "stellar":
      return stellarMintAndForward(message, attestation);
  }
}

/**
 * Retoma una transferencia cuyo burn ya se hizo (p. ej. el mint falló o se cortó el proceso):
 * obtiene mensaje + atestación de Iris por el hash del burn y ejecuta el mint en destino.
 */
export async function cctpResume(opts: { src: ChainKey; dst: ChainKey; burnTx: string }) {
  const res: Record<string, unknown> = { protocol: "CCTP", resumed: true, src: opts.src, dst: opts.dst, burnTx: opts.burnTx, status: "error", startedAt: new Date().toISOString() };
  try {
    log.step(2, `obteniendo atestación de ${opts.burnTx}`);
    const att = await waitForAttestation(domainOf(opts.src), opts.burnTx);
    log.step(3, `mint en ${nameOf(opts.dst)}`);
    res.version = att.cctpVersion;
    res.mintTx = await mintOnDest(opts.dst, att.cctpVersion === 2 ? 2 : 1, att.message as Hex, att.attestation as Hex);
    res.status = "ok";
    log.ok("mint completado");
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    log.err(String(res.error));
  }
  saveResult(res);
  return res;
}

export function saveResult(r: object) {
  fs.mkdirSync("results", { recursive: true });
  fs.appendFileSync("results/transfers.jsonl", JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}
