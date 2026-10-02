import { SuiGrpcClient } from "@mysten/sui/grpc";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { SUI } from "../config/chains.js";
import { suiKeypair } from "../lib/env.js";
import { bufToHex, hexToBuf, type Hex } from "../lib/encoding.js";
import { log } from "../lib/log.js";

/**
 * CCTP V1 en Sui (domain 8). Sui todavía NO tiene CCTP V2: sólo puede
 * intercambiar mensajes con chains que mantengan contratos V1
 * (Ethereum, Avalanche, Arbitrum, Base, Solana...). V1 entra en
 * deprecación el 2026-10-31 y se pausa el 2026-12-01.
 */

const DENY_LIST = "0x403"; // objeto compartido del sistema (regulated coin deny list)
const { messageTransmitterPkg: MT, tokenMessengerMinterPkg: TMM, messageTransmitterState, tokenMessengerMinterState, usdcTreasury } = SUI.cctpV1;

// Nota: los fullnodes públicos de Sui deprecaron JSON-RPC → se usa gRPC(-web).
let _client: SuiGrpcClient | undefined;
export const suiClient = () => (_client ??= new SuiGrpcClient({ network: "testnet", baseUrl: SUI.rpc }));

export async function suiUsdcBalance(owner: string): Promise<bigint> {
  const b = await suiClient().getBalance({ owner, coinType: SUI.usdcType });
  return BigInt(b.balance.balance);
}
export async function suiNativeBalance(owner: string): Promise<bigint> {
  const b = await suiClient().getBalance({ owner });
  return BigInt(b.balance.balance);
}

async function exec(tx: Transaction) {
  const client = suiClient();
  const signer = suiKeypair();
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true, events: true, balanceChanges: true } });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (res.$kind !== "Transaction" || !t.status.success) throw new Error(`Sui tx falló: ${JSON.stringify(t.status)} (${t.digest})`);
  await client.waitForTransaction({ digest: t.digest });
  return t;
}

/** deposit_for_burn (V1). Devuelve { digest, message } — digest es el "transactionHash" para Iris. */
export async function suiBurn(p: { amount: bigint; destinationDomain: number; mintRecipient: Hex }) {
  const client = suiClient();
  const owner = suiKeypair().toSuiAddress();
  const tx = new Transaction();
  // Junta los Coin<USDC> del owner y separa el monto exacto a quemar.
  const coins = await client.listCoins({ owner, coinType: SUI.usdcType });
  if (!coins.objects.length) throw new Error("Sin USDC en Sui");
  const [primary, ...rest] = coins.objects.map((c) => tx.object(c.objectId));
  if (rest.length) tx.mergeCoins(primary, rest);
  const [coin] = tx.splitCoins(primary, [p.amount]);

  tx.moveCall({
    target: `${TMM}::deposit_for_burn::deposit_for_burn`,
    arguments: [
      coin, // Coin<USDC> que se quema
      tx.pure.u32(p.destinationDomain),
      tx.pure.address(p.mintRecipient), // bytes32 tratado como address de Sui
      tx.object(tokenMessengerMinterState),
      tx.object(messageTransmitterState),
      tx.object(DENY_LIST),
      tx.object(usdcTreasury),
    ],
    typeArguments: [SUI.usdcType],
  });
  const res = await exec(tx);
  // MessageSent { message: vector<u8> } — se decodifica desde BCS (formato estable entre transports)
  const ev = res.events?.find((e) => e.eventType.includes("send_message::MessageSent"));
  const message = ev ? bufToHex(Uint8Array.from(bcs.struct("MessageSent", { message: bcs.vector(bcs.u8()) }).parse(ev.bcs).message)) : undefined;
  log.tx("deposit_for_burn (CCTP v1)", `${SUI.explorer}/tx/${res.digest}`);
  return { digest: res.digest, message };
}

/**
 * Recepción en Sui: un único PTB con 5 llamadas encadenadas (patrón "hot potato"):
 *  1. message_transmitter::receive_message      → Receipt (no se puede guardar ni descartar)
 *  2. token_messenger_minter::handle_receive_message → mintea USDC, devuelve StampReceiptTicketWithBurnMessage
 *  3. deconstruct_stamp_receipt_ticket_with_burn_message → StampReceiptTicket
 *  4. message_transmitter::stamp_receipt         → StampedReceipt (autenticado por el receptor)
 *  5. message_transmitter::complete_receive_message → marca el nonce como usado y emite MessageReceived
 */
export async function suiReceive(messageHex: Hex, attestationHex: Hex): Promise<string> {
  const tx = new Transaction();
  const [receipt] = tx.moveCall({
    target: `${MT}::receive_message::receive_message`,
    arguments: [
      tx.pure.vector("u8", hexToBuf(messageHex)),
      tx.pure.vector("u8", hexToBuf(attestationHex)),
      tx.object(messageTransmitterState),
    ],
  });
  const [ticketWithBurn] = tx.moveCall({
    target: `${TMM}::handle_receive_message::handle_receive_message`,
    arguments: [receipt, tx.object(tokenMessengerMinterState), tx.object(DENY_LIST), tx.object(usdcTreasury)],
    typeArguments: [SUI.usdcType],
  });
  const [ticket] = tx.moveCall({
    target: `${TMM}::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message`,
    arguments: [ticketWithBurn],
  });
  const [stamped] = tx.moveCall({
    target: `${MT}::receive_message::stamp_receipt`,
    arguments: [ticket, tx.object(messageTransmitterState)],
    typeArguments: [`${TMM}::message_transmitter_authenticator::MessageTransmitterAuthenticator`],
  });
  tx.moveCall({
    target: `${MT}::receive_message::complete_receive_message`,
    arguments: [stamped, tx.object(messageTransmitterState)],
  });
  tx.setGasBudget(200_000_000); // 0.2 SUI (el PTB real consume ~0.01–0.03 SUI)
  const res = await exec(tx);
  log.tx("receive_message PTB (CCTP v1)", `${SUI.explorer}/tx/${res.digest}`);
  return res.digest;
}
