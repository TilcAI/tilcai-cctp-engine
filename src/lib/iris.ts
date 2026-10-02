import { IRIS_API } from "../config/chains.js";
import { log } from "./log.js";

/**
 * Cliente mínimo de la API de atestación de Circle ("Iris").
 * Sandbox (testnet): https://iris-api-sandbox.circle.com — límite 35-40 req/s
 * (exceder → bloqueo de 5 min por IP, por eso hacemos polling cada 5 s).
 */

export interface IrisMessage {
  message: `0x${string}` | string;
  attestation: `0x${string}` | string; // "PENDING" mientras no esté firmado
  eventNonce: string;
  cctpVersion: number;
  status: "pending_confirmations" | "complete" | string;
  decodedMessage?: Record<string, unknown>;
  delayReason?: string | null;
  /** Forwarding Service: estado y tx del mint ejecutado por Circle en destino */
  forwardState?: "PENDING" | "COMPLETE" | "FAILED" | string;
  forwardTxHash?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera la atestación de un burn.
 * `txId`: hash EVM (0x…), firma Solana (base58), digest Sui (base58) o hash Stellar (hex sin 0x).
 */
export async function waitForAttestation(
  sourceDomain: number,
  txId: string,
  { timeoutMs = 40 * 60_000, pollMs = 5_000 } = {},
): Promise<IrisMessage> {
  const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${txId}`;
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(url).catch(() => undefined);
    if (res?.ok) {
      const data = (await res.json()) as { messages?: IrisMessage[] };
      const m = data.messages?.[0];
      if (m) {
        if (m.status === "complete" && m.attestation && m.attestation !== "PENDING") {
          log.ok(`Atestación lista (CCTP v${m.cctpVersion}, nonce ${m.eventNonce}) tras ${Math.round((Date.now() - t0) / 1000)} s`);
          return m;
        }
        const s = `${m.status}${m.delayReason ? ` (${m.delayReason})` : ""}`;
        if (s !== last) log.info(`Iris: ${s}`);
        last = s;
      }
    } else if (res && res.status !== 404) {
      log.warn(`Iris HTTP ${res.status}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`Timeout esperando atestación de ${txId} (domain ${sourceDomain})`);
}

/** Fees de CCTP V2 en basis points por finalityThreshold (1000=Fast, 2000=Standard). */
export async function getFeeBps(srcDomain: number, dstDomain: number): Promise<{ fast: number; standard: number }> {
  const res = await fetch(`${IRIS_API}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`);
  if (!res.ok) throw new Error(`fees ${srcDomain}->${dstDomain}: HTTP ${res.status} ${await res.text()}`);
  const arr = (await res.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
  return {
    fast: arr.find((x) => x.finalityThreshold === 1000)?.minimumFee ?? 0,
    standard: arr.find((x) => x.finalityThreshold === 2000)?.minimumFee ?? 0,
  };
}

/** maxFee (unidades del token origen) = ceil(amount * bps / 10_000), con 10% de margen. */
export function maxFeeFor(amount: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  const scaled = BigInt(Math.ceil(bps * 1.1 * 100)); // bps*100 para conservar 2 decimales
  return (amount * scaled + 1_000_000n - 1n) / 1_000_000n;
}

/** hookData mágico del Forwarding Service: "cctp-forward" en ASCII, right-padded a 32 bytes. */
export const FORWARD_HOOK: `0x${string}` = `0x${Buffer.from("cctp-forward").toString("hex").padEnd(64, "0")}`;

/** Fee del Forwarding Service (unidades de USDC, 6 decimales) — cubre el gas que Circle paga en destino. */
export async function getForwardFee(srcDomain: number, dstDomain: number): Promise<{ low: bigint; med: bigint; high: bigint }> {
  const res = await fetch(`${IRIS_API}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}?forward=true`);
  const body = (await res.json()) as any;
  if (!res.ok || !Array.isArray(body)) throw new Error(`forwarding ${srcDomain}->${dstDomain}: ${JSON.stringify(body)}`);
  const f = body[0].forwardFee;
  return { low: BigInt(f.low), med: BigInt(f.med), high: BigInt(f.high) };
}

/** Espera a que Circle ejecute el mint en destino (forwardState=COMPLETE). */
export async function waitForForward(sourceDomain: number, txId: string, { timeoutMs = 40 * 60_000, pollMs = 5_000 } = {}) {
  const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${txId}`;
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(url).catch(() => undefined);
    if (res?.ok) {
      const m = ((await res.json()) as { messages?: IrisMessage[] }).messages?.[0];
      const s = `${m?.status}/${m?.forwardState ?? "-"}`;
      if (s !== last) log.info(`Iris: status=${m?.status} forwardState=${m?.forwardState ?? "-"}`);
      last = s;
      if (m?.forwardState === "COMPLETE" || m?.forwardState === "CONFIRMED") return m;
      if (m?.forwardState === "FAILED") throw new Error("Forwarding FAILED: el mensaje sigue atestado; se puede hacer receiveMessage manual");
    }
    await sleep(pollMs);
  }
  throw new Error(`Timeout esperando forwarding de ${txId}`);
}
