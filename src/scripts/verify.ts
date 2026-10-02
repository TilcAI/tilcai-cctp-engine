/**
 * Verificación on-chain de TODAS las direcciones configuradas (no requiere private keys):
 *  - EVM: código en USDC/Router, localDomain() de MessageTransmitter V1 y V2
 *  - Solana: programas CCTP V1/V2 desplegados y ejecutables
 *  - Sui: paquetes CCTP V1 y objetos compartidos existen
 *  - Stellar: contratos Soroban (TMM, MT, Forwarder, USDC SAC) existen; get_local_domain() == 27
 *  - Iris: endpoint de fees responde
 */
import { PublicKey } from "@solana/web3.js";
import { Account, Address, Contract, Keypair, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { EVM, SOLANA, STELLAR, SUI } from "../config/chains.js";
import { evmSelfCheck, type EvmKey } from "../cctp/evm.js";
import { solConnection } from "../cctp/solana.js";
import { suiClient } from "../cctp/sui.js";
import { getFeeBps } from "../lib/iris.js";

const results: Record<string, unknown>[] = [];

for (const k of Object.keys(EVM) as EvmKey[]) {
  results.push(await evmSelfCheck(k).catch((e) => ({ chain: EVM[k].name, error: String(e).slice(0, 80) })));
}
console.log("\nEVM (v2Domain/v1Domain = MessageTransmitter.localDomain()):");
console.table(results);

const conn = solConnection();
const sol: Record<string, unknown>[] = [];
for (const [label, id] of Object.entries({
  "CCTP V2 MessageTransmitter": SOLANA.cctpV2.messageTransmitter,
  "CCTP V2 TokenMessengerMinter": SOLANA.cctpV2.tokenMessengerMinter,
  "CCTP V1 MessageTransmitter": SOLANA.cctpV1.messageTransmitter,
  "CCTP V1 TokenMessengerMinter": SOLANA.cctpV1.tokenMessengerMinter,
  "USDC mint": SOLANA.usdcMint,
})) {
  const info = await conn.getAccountInfo(new PublicKey(id)).catch(() => null);
  sol.push({ label, id, exists: Boolean(info), executable: info?.executable ?? false });
}
console.log("\nSolana Devnet:");
console.table(sol);

const sc = suiClient();
const sui: Record<string, unknown>[] = [];
for (const [label, id] of Object.entries({
  "MessageTransmitter pkg": SUI.cctpV1.messageTransmitterPkg,
  "TokenMessengerMinter pkg": SUI.cctpV1.tokenMessengerMinterPkg,
  "MessageTransmitterState": SUI.cctpV1.messageTransmitterState,
  "TokenMessengerMinterState": SUI.cctpV1.tokenMessengerMinterState,
  "USDC Treasury": SUI.cctpV1.usdcTreasury,
  "USDC pkg": SUI.usdcPackage,
})) {
  const o = await sc.getObject({ objectId: id }).catch((e) => ({ error: String(e) }) as any);
  sui.push({ label, exists: Boolean(o.object), type: o.object?.type?.slice(0, 80) ?? String(o.error).slice(0, 80) });
}
console.log("\nSui Testnet (CCTP V1):");
console.table(sui);

async function stellarRead(contractId: string, method: string, ...args: xdr.ScVal[]) {
  const srv = new rpc.Server(STELLAR.rpc);
  const src = new Account(Keypair.random().publicKey(), "0"); // sólo simulación: no necesita existir
  const tx = new TransactionBuilder(src, { fee: "100", networkPassphrase: STELLAR.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return `ERR ${sim.error.slice(0, 60)}`;
  return scValToNative(sim.result!.retval);
}
const xlm = [
  { label: "MessageTransmitter.get_local_domain()", value: await stellarRead(STELLAR.cctpV2.messageTransmitter, "get_local_domain").catch((e) => String(e).slice(0, 60)) },
  { label: "MessageTransmitter.get_version()", value: await stellarRead(STELLAR.cctpV2.messageTransmitter, "get_version").catch((e) => String(e).slice(0, 60)) },
  { label: "TokenMessengerMinter.get_local_message_transmitter()", value: await stellarRead(STELLAR.cctpV2.tokenMessengerMinter, "get_local_message_transmitter").catch((e) => String(e).slice(0, 60)) },
  { label: "TokenMessengerMinter.get_message_body_version()", value: await stellarRead(STELLAR.cctpV2.tokenMessengerMinter, "get_message_body_version").catch((e) => String(e).slice(0, 60)) },
  { label: "TokenMessengerMinter.get_token_decimal_config(USDC)", value: JSON.stringify(await stellarRead(STELLAR.cctpV2.tokenMessengerMinter, "get_token_decimal_config", new Address(STELLAR.usdcSac).toScVal()).catch((e) => String(e).slice(0, 60))) },
  { label: "TokenMessengerMinter.get_min_fee(USDC)", value: String(await stellarRead(STELLAR.cctpV2.tokenMessengerMinter, "get_min_fee", new Address(STELLAR.usdcSac).toScVal()).catch((e) => String(e).slice(0, 60))) },
  { label: "TokenMessengerMinter.get_max_burn_amount_per_message(USDC)", value: String(await stellarRead(STELLAR.cctpV2.tokenMessengerMinter, "get_max_burn_amount_per_message", new Address(STELLAR.usdcSac).toScVal()).catch((e) => String(e).slice(0, 60))) },
  { label: "CctpForwarder.get_message_transmitter()", value: await stellarRead(STELLAR.cctpV2.cctpForwarder, "get_message_transmitter").catch((e) => String(e).slice(0, 60)) },
  { label: "USDC SAC.decimals()", value: await stellarRead(STELLAR.usdcSac, "decimals").catch((e) => String(e).slice(0, 60)) },
  { label: "USDC SAC.symbol()", value: await stellarRead(STELLAR.usdcSac, "symbol").catch((e) => String(e).slice(0, 60)) },
];
console.log("\nStellar Testnet (CCTP V2 / Soroban):");
console.table(xlm);

console.log("\nIris fees (bps) ejemplos:");
console.table({
  "ETH→BASE": await getFeeBps(0, 6),
  "BASE→SOL": await getFeeBps(6, 5),
  "ARC→XLM": await getFeeBps(26, 27),
  "XLM→AVAX": await getFeeBps(27, 1),
});
process.exit(0);
