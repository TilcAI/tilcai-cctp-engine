import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { STELLAR } from "../config/chains.js";
import { stellarKeypair } from "../lib/env.js";
import { hexToBuf, type Hex } from "../lib/encoding.js";
import { log } from "../lib/log.js";

/**
 * CCTP V2 en Stellar (domain 27) — contratos Soroban.
 *  - USDC en Stellar tiene 7 decimales; CCTP usa 6 "canónicos". El
 *    TokenMessengerMinter normaliza (quita el "dust" del 7º decimal) al quemar
 *    y multiplica ×10 al mintear.
 *  - Para recibir en una cuenta G.../M... se usa SIEMPRE el CctpForwarder.
 */

const USDC_ASSET = new Asset("USDC", STELLAR.usdcIssuer);
const server = () => new rpc.Server(STELLAR.rpc);
const horizon = () => new Horizon.Server(STELLAR.horizon);

export async function stellarBalances(account: string): Promise<{ usdc: bigint; xlm: bigint; trustline: boolean; exists: boolean }> {
  try {
    const acc = await horizon().loadAccount(account);
    const toUnits = (s: string) => BigInt(s.replace(".", "")); // Horizon devuelve 7 decimales fijos
    const usdc = acc.balances.find((b: any) => b.asset_code === "USDC" && b.asset_issuer === STELLAR.usdcIssuer) as any;
    const xlm = acc.balances.find((b: any) => b.asset_type === "native") as any;
    return { usdc: usdc ? toUnits(usdc.balance) : 0n, xlm: xlm ? toUnits(xlm.balance) : 0n, trustline: Boolean(usdc), exists: true };
  } catch {
    return { usdc: 0n, xlm: 0n, trustline: false, exists: false };
  }
}

/** Fondea la cuenta con Friendbot (10 000 XLM testnet) si no existe. */
export async function stellarFriendbot(account: string) {
  const res = await fetch(`${STELLAR.friendbot}?addr=${encodeURIComponent(account)}`);
  log.info(`friendbot: HTTP ${res.status}`);
  return res.ok;
}

/** Trustline USDC:GBBD… — obligatoria para que una cuenta G… pueda recibir USDC. */
export async function ensureUsdcTrustline() {
  const kp = stellarKeypair();
  const st = await stellarBalances(kp.publicKey());
  if (st.trustline) return;
  const acc = await horizon().loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: STELLAR.passphrase })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const r = await horizon().submitTransaction(tx);
  log.tx("changeTrust USDC", `${STELLAR.explorer}/tx/${r.hash}`);
}

/** Simula → ensambla (footprint + resource fee) → firma → envía → espera. */
async function invoke(contractId: string, method: string, args: xdr.ScVal[]): Promise<string> {
  const kp = stellarKeypair();
  const srv = server();
  const account = await srv.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: STELLAR.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulación ${method} falló: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await srv.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`sendTransaction ${method}: ${JSON.stringify(sent.errorResult)}`);
  let got = await srv.getTransaction(sent.hash);
  while (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 2000));
    got = await srv.getTransaction(sent.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${method} falló on-chain: ${sent.hash}`);
  log.tx(method, `${STELLAR.explorer}/tx/${sent.hash}`);
  return sent.hash;
}

export interface StellarBurnParams {
  amount7: bigint; // 7 decimales (local)
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee7: bigint; // 7 decimales (local)
  minFinalityThreshold: 1000 | 2000;
  hookData?: Hex;
}

/** approve(USDC SAC → TokenMessengerMinter) + deposit_for_burn[_with_hook]. Devuelve el hash (hex) para Iris. */
export async function stellarBurn(p: StellarBurnParams): Promise<string> {
  const kp = stellarKeypair();
  const me = new Address(kp.publicKey()).toScVal();
  const latest = await server().getLatestLedger();
  await invoke(STELLAR.usdcSac, "approve", [
    me,
    new Address(STELLAR.cctpV2.tokenMessengerMinter).toScVal(),
    nativeToScVal(p.amount7, { type: "i128" }),
    nativeToScVal(latest.sequence + 100_000, { type: "u32" }), // expiration_ledger
  ]);
  const args = [
    me,
    nativeToScVal(p.amount7, { type: "i128" }),
    nativeToScVal(p.destinationDomain, { type: "u32" }),
    xdr.ScVal.scvBytes(hexToBuf(p.mintRecipient)),
    new Address(STELLAR.usdcSac).toScVal(),
    xdr.ScVal.scvBytes(hexToBuf(p.destinationCaller)),
    nativeToScVal(p.maxFee7, { type: "i128" }),
    nativeToScVal(p.minFinalityThreshold, { type: "u32" }),
  ];
  if (p.hookData) args.push(xdr.ScVal.scvBytes(hexToBuf(p.hookData)));
  return invoke(STELLAR.cctpV2.tokenMessengerMinter, p.hookData ? "deposit_for_burn_with_hook" : "deposit_for_burn", args);
}

/** Destino Stellar: CctpForwarder.mint_and_forward(message, attestation) — mintea y reenvía atómicamente. */
export async function stellarMintAndForward(messageHex: Hex, attestationHex: Hex): Promise<string> {
  await ensureUsdcTrustline();
  return invoke(STELLAR.cctpV2.cctpForwarder, "mint_and_forward", [
    xdr.ScVal.scvBytes(hexToBuf(messageHex)),
    xdr.ScVal.scvBytes(hexToBuf(attestationHex)),
  ]);
}
