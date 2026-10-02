import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { createRequire } from "node:module";
import { SOLANA } from "../config/chains.js";
import { solanaKeypair } from "../lib/env.js";
import { hexToBuf, type Hex } from "../lib/encoding.js";
import { log } from "../lib/log.js";

const require = createRequire(import.meta.url);
const IDL = {
  mtV2: require("../idl/message_transmitter_v2.json"),
  tmmV2: require("../idl/token_messenger_minter_v2.json"),
  mtV1: require("../idl/message_transmitter_031.json"),
  tmmV1: require("../idl/token_messenger_minter_031.json"),
};

const USDC = new PublicKey(SOLANA.usdcMint);
export const solConnection = () => new Connection(SOLANA.rpc, "confirmed");

function programs(version: 1 | 2) {
  const kp = solanaKeypair();
  const provider = new anchor.AnchorProvider(solConnection(), new anchor.Wallet(kp), { commitment: "confirmed" });
  const mt = new anchor.Program(version === 2 ? IDL.mtV2 : IDL.mtV1, provider) as anchor.Program<any>;
  const tmm = new anchor.Program(version === 2 ? IDL.tmmV2 : IDL.tmmV1, provider) as anchor.Program<any>;
  return { kp, provider, mt, tmm };
}

const pda = (label: string, programId: PublicKey, extra: (string | Buffer | PublicKey)[] = []) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(label), ...extra.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.isBuffer(s) ? s : s.toBuffer()))],
    programId,
  )[0];

export async function solUsdcBalance(owner: string): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(USDC, new PublicKey(owner), true);
  try {
    return (await getAccount(solConnection(), ata)).amount;
  } catch {
    return 0n;
  }
}
export async function solNativeBalance(owner: string): Promise<bigint> {
  return BigInt(await solConnection().getBalance(new PublicKey(owner)));
}

/** Crea (idempotente) la ATA de USDC del owner: requisito para recibir (si no existe, receiveMessage revierte). */
export async function ensureUsdcAta(owner: PublicKey): Promise<PublicKey> {
  const { provider, kp } = programs(2);
  const ata = getAssociatedTokenAddressSync(USDC, owner, true);
  const info = await provider.connection.getAccountInfo(ata);
  if (!info) {
    const tx = new anchor.web3.Transaction().add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, owner, USDC));
    const sig = await provider.sendAndConfirm(tx);
    log.tx("create USDC ATA", `${SOLANA.explorer}/tx/${sig}?cluster=devnet`);
  }
  return ata;
}

export interface SolBurnParams {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex; // bytes32
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: 1000 | 2000;
  hookData?: Hex;
  version: 1 | 2;
}

/** deposit_for_burn en Solana. Devuelve la firma de la tx (= transactionHash para Iris). */
export async function solBurn(p: SolBurnParams): Promise<string> {
  const { kp, mt, tmm } = programs(p.version);
  const owner = kp.publicKey;
  const burnTokenAccount = getAssociatedTokenAddressSync(USDC, owner);
  // Cuenta efímera donde el MessageTransmitter escribe el evento MessageSent.
  // Paga renta (~0.0035 SOL) que se puede recuperar con reclaim_event_account tras 5 días (V2).
  const eventAccount = Keypair.generate();

  const accounts = {
    owner,
    eventRentPayer: owner,
    senderAuthorityPda: pda("sender_authority", tmm.programId),
    burnTokenAccount,
    messageTransmitter: pda("message_transmitter", mt.programId),
    tokenMessenger: pda("token_messenger", tmm.programId),
    remoteTokenMessenger: pda("remote_token_messenger", tmm.programId, [String(p.destinationDomain)]),
    tokenMinter: pda("token_minter", tmm.programId),
    localToken: pda("local_token", tmm.programId, [USDC]),
    burnTokenMint: USDC,
    messageSentEventData: eventAccount.publicKey,
    messageTransmitterProgram: mt.programId,
    tokenMessengerMinterProgram: tmm.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
  const mintRecipient = new PublicKey(hexToBuf(p.mintRecipient));
  let sig: string;
  if (p.version === 2) {
    const args: Record<string, unknown> = {
      amount: new anchor.BN(p.amount.toString()),
      destinationDomain: p.destinationDomain,
      mintRecipient,
      maxFee: new anchor.BN(p.maxFee.toString()),
      minFinalityThreshold: p.minFinalityThreshold,
      destinationCaller: new PublicKey(hexToBuf(p.destinationCaller)),
    };
    const m = p.hookData
      ? tmm.methods.depositForBurnWithHook({ ...args, hookData: hexToBuf(p.hookData) })
      : tmm.methods.depositForBurn(args);
    sig = await m.accountsPartial(accounts).signers([eventAccount]).rpc();
  } else {
    sig = await tmm.methods
      .depositForBurn({ amount: new anchor.BN(p.amount.toString()), destinationDomain: p.destinationDomain, mintRecipient })
      .accountsPartial(accounts)
      .signers([eventAccount])
      .rpc();
  }
  log.tx(`deposit_for_burn (CCTP v${p.version})`, `${SOLANA.explorer}/tx/${sig}?cluster=devnet`);
  log.info(`event account (renta recuperable): ${eventAccount.publicKey.toBase58()}`);
  return sig;
}

/** Extrae campos del mensaje CCTP según versión (offsets del header). */
function parseMessage(messageHex: Hex, version: 1 | 2) {
  const m = hexToBuf(messageHex);
  const sourceDomain = m.readUInt32BE(4);
  if (version === 2) {
    // header V2 = 148 bytes; body: version(4) burnToken(32) mintRecipient(32) ...
    return { sourceDomain, nonce: m.subarray(12, 44), burnToken: m.subarray(152, 184), mintRecipient: m.subarray(184, 216) };
  }
  // header V1 = 116 bytes: version(4) src(4) dst(4) nonce u64(8) sender(32) recipient(32) destinationCaller(32)
  return { sourceDomain, nonce64: m.readBigUInt64BE(12), burnToken: m.subarray(120, 152), mintRecipient: m.subarray(152, 184) };
}

/** receive_message en Solana → mintea USDC en la ATA indicada como mintRecipient. */
export async function solReceive(messageHex: Hex, attestationHex: Hex, version: 1 | 2): Promise<string> {
  const { kp, mt, tmm } = programs(version);
  const parsed = parseMessage(messageHex, version);
  const remoteDomain = String(parsed.sourceDomain);
  const remoteToken = new PublicKey(parsed.burnToken);
  const userTokenAccount = new PublicKey(parsed.mintRecipient);

  // La ATA destino debe existir antes de receive_message.
  const ataInfo = await mt.provider.connection.getAccountInfo(userTokenAccount);
  if (!ataInfo) await ensureUsdcAta(kp.publicKey);

  const tokenMessenger = pda("token_messenger", tmm.programId);
  const remaining: anchor.web3.AccountMeta[] = [
    { pubkey: tokenMessenger, isSigner: false, isWritable: false },
    { pubkey: pda("remote_token_messenger", tmm.programId, [remoteDomain]), isSigner: false, isWritable: false },
    { pubkey: pda("token_minter", tmm.programId), isSigner: false, isWritable: true },
    { pubkey: pda("local_token", tmm.programId, [USDC]), isSigner: false, isWritable: true },
    { pubkey: pda("token_pair", tmm.programId, [remoteDomain, remoteToken]), isSigner: false, isWritable: false },
  ];
  if (version === 2) {
    // V2 añade la cuenta del fee recipient (cobra feeExecuted en transfers Fast)
    const tm = (await (tmm.account as any).tokenMessenger.fetch(tokenMessenger)) as { feeRecipient: PublicKey };
    remaining.push({ pubkey: getAssociatedTokenAddressSync(USDC, tm.feeRecipient, true), isSigner: false, isWritable: true });
  }
  remaining.push(
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pda("custody", tmm.programId, [USDC]), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pda("__event_authority", tmm.programId), isSigner: false, isWritable: false },
    { pubkey: tmm.programId, isSigner: false, isWritable: false },
  );

  const accounts: Record<string, PublicKey> = {
    payer: kp.publicKey,
    caller: kp.publicKey,
    authorityPda: pda("message_transmitter_authority", mt.programId, [tmm.programId]),
    messageTransmitter: pda("message_transmitter", mt.programId),
    receiver: tmm.programId,
    systemProgram: SystemProgram.programId,
  };
  if (version === 2) {
    accounts.usedNonce = pda("used_nonce", mt.programId, [parsed.nonce as Buffer]);
  } else {
    accounts.usedNonces = await mt.methods
      .getNoncePda({ nonce: new anchor.BN(parsed.nonce64!.toString()), sourceDomain: Number(remoteDomain) })
      .accountsPartial({ messageTransmitter: accounts.messageTransmitter })
      .view();
  }
  const sig = await mt.methods
    .receiveMessage({ message: hexToBuf(messageHex), attestation: hexToBuf(attestationHex) })
    .accountsPartial(accounts)
    .remainingAccounts(remaining)
    .rpc();
  log.tx(`receive_message (CCTP v${version})`, `${SOLANA.explorer}/tx/${sig}?cluster=devnet`);
  return sig;
}
