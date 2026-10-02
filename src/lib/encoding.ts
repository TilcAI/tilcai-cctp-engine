import bs58 from "bs58";
import { StrKey } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SOLANA, STELLAR, type ChainKey, familyOf } from "../config/chains.js";

/**
 * Conversión de direcciones nativas de cada chain al `bytes32` que usa CCTP
 * (mintRecipient / destinationCaller / sender) y viceversa.
 */

export type Hex = `0x${string}`;
export const ZERO32: Hex = `0x${"00".repeat(32)}`;

export const strip0x = (h: string) => h.replace(/^0x/, "");
export const hexToBuf = (h: string) => Buffer.from(strip0x(h), "hex");
export const bufToHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

/** EVM 20 bytes → left-pad a 32 bytes. */
export const evmToBytes32 = (addr: string): Hex => `0x${"0".repeat(24)}${strip0x(addr).toLowerCase()}`;

/** Solana pubkey base58 (32 bytes) → hex. */
export const solanaToBytes32 = (pubkey: string): Hex => bufToHex(bs58.decode(pubkey));

/** Sui address ya es 32 bytes hex. */
export const suiToBytes32 = (addr: string): Hex => `0x${strip0x(addr).padStart(64, "0")}`;

/** Stellar contract strkey (C...) → 32 bytes. Las cuentas G/M NO se usan como mintRecipient (ver CctpForwarder). */
export const stellarContractToBytes32 = (strkey: string): Hex => {
  if (!StrKey.isValidContract(strkey)) throw new Error(`No es un contract strkey: ${strkey}`);
  return bufToHex(StrKey.decodeContract(strkey));
};

/**
 * hookData para el CctpForwarder de Stellar:
 *   [0..24)  ceros
 *   [24..28) uint32 BE  hook version = 0
 *   [28..32) uint32 BE  longitud del strkey
 *   [32..)   strkey del destinatario final (G..., C... o M...) en UTF-8
 */
export function stellarForwarderHookData(forwardRecipient: string): Hex {
  const ok =
    StrKey.isValidEd25519PublicKey(forwardRecipient) ||
    StrKey.isValidContract(forwardRecipient) ||
    StrKey.isValidMed25519PublicKey(forwardRecipient);
  if (!ok) throw new Error(`forwardRecipient inválido: ${forwardRecipient}`);
  const r = Buffer.from(forwardRecipient, "utf8");
  const out = Buffer.alloc(32 + r.length);
  out.writeUInt32BE(0, 24);
  out.writeUInt32BE(r.length, 28);
  r.copy(out, 32);
  return bufToHex(out);
}

/** ATA de USDC (Solana) del owner — es lo que va como mintRecipient cuando Solana es destino. */
export const solanaUsdcAta = (owner: string) =>
  getAssociatedTokenAddressSync(new PublicKey(SOLANA.usdcMint), new PublicKey(owner), true).toBase58();

export interface MintTarget {
  /** bytes32 que va en el burn como mintRecipient */
  mintRecipient: Hex;
  /** bytes32 destinationCaller (0 = cualquiera puede llamar receiveMessage) */
  destinationCaller: Hex;
  /** hookData (sólo Stellar destino) */
  hookData?: Hex;
  /** descripción humana */
  note: string;
}

/**
 * Calcula mintRecipient/destinationCaller/hookData correctos para un destino.
 * `recipient` está en formato nativo del destino (0x.., base58, 0x..(sui), G...).
 */
export function mintTargetFor(dst: ChainKey, recipient: string): MintTarget {
  switch (familyOf(dst)) {
    case "evm":
      return { mintRecipient: evmToBytes32(recipient), destinationCaller: ZERO32, note: "EVM address left-padded" };
    case "solana": {
      const ata = solanaUsdcAta(recipient);
      return { mintRecipient: solanaToBytes32(ata), destinationCaller: ZERO32, note: `USDC ATA ${ata} del owner ${recipient}` };
    }
    case "sui":
      return { mintRecipient: suiToBytes32(recipient), destinationCaller: ZERO32, note: "Sui address (32 bytes)" };
    case "stellar": {
      const fwd = stellarContractToBytes32(STELLAR.cctpV2.cctpForwarder);
      return {
        mintRecipient: fwd,
        destinationCaller: fwd, // OBLIGATORIO: si no, los fondos quedan atascados
        hookData: stellarForwarderHookData(recipient),
        note: `CctpForwarder ${STELLAR.cctpV2.cctpForwarder} → reenvía a ${recipient}`,
      };
    }
  }
}

/** Escalado de montos: Stellar USDC usa 7 decimales, el resto 6. */
export function toUnits(amountUsdc: string, decimals: number): bigint {
  const [i, f = ""] = amountUsdc.split(".");
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const r = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  return r === "" ? "0" : r;
}
