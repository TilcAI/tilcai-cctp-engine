import "dotenv/config";
import fs from "node:fs";
import bs58 from "bs58";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Keypair as SolKeypair } from "@solana/web3.js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";

/**
 * Carga de wallets desde variables de entorno (.env del proyecto).
 * Ninguna key se imprime nunca; sólo se exponen direcciones públicas.
 */

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta la variable ${name} en .env (ver .env.example)`);
  return v;
}

export function hasKey(family: "evm" | "solana" | "sui" | "stellar"): boolean {
  const k = { evm: "EVM_PRIVATE_KEY", solana: "SOLANA_PRIVATE_KEY", sui: "SUI_PRIVATE_KEY", stellar: "STELLAR_SECRET_KEY" }[family];
  return Boolean(process.env[k]?.trim() || (family === "solana" && process.env.SOLANA_KEYPAIR_PATH));
}

export function evmAccount(): PrivateKeyAccount {
  let pk = req("EVM_PRIVATE_KEY");
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  return privateKeyToAccount(pk as `0x${string}`);
}

/** Acepta base58 (formato Phantom), array JSON de 64 bytes, o ruta a keypair.json. */
export function solanaKeypair(): SolKeypair {
  const path = process.env.SOLANA_KEYPAIR_PATH?.trim();
  const raw = path ? fs.readFileSync(path, "utf8").trim() : req("SOLANA_PRIVATE_KEY");
  if (raw.startsWith("[")) return SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return SolKeypair.fromSecretKey(bs58.decode(raw));
}

/** Acepta `suiprivkey1...` (bech32) o hex de 32 bytes. */
export function suiKeypair(): Ed25519Keypair {
  const raw = req("SUI_PRIVATE_KEY");
  if (raw.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(Buffer.from(raw.replace(/^0x/, ""), "hex"));
}

export function stellarKeypair(): StellarKeypair {
  return StellarKeypair.fromSecret(req("STELLAR_SECRET_KEY"));
}

/** Direcciones públicas propias (o las de *_ADDRESS para modo sólo-lectura). */
export function myAddresses() {
  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    evm: process.env.EVM_ADDRESS || safe(() => evmAccount().address),
    solana: process.env.SOLANA_ADDRESS || safe(() => solanaKeypair().publicKey.toBase58()),
    sui: process.env.SUI_ADDRESS || safe(() => suiKeypair().toSuiAddress()),
    stellar: process.env.STELLAR_ADDRESS || safe(() => stellarKeypair().publicKey()),
  };
}
