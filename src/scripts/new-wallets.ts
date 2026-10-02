/**
 * Genera wallets de laboratorio (TESTNET) para las familias que falten en .env.
 * Escribe las claves en .env (gitignored) y SÓLO imprime direcciones públicas.
 *   npm run wallets:new
 */
import fs from "node:fs";
import bs58 from "bs58";
import { generatePrivateKey } from "viem/accounts";
import { Keypair as SolKeypair } from "@solana/web3.js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { hasKey, myAddresses } from "../lib/env.js";

const lines: string[] = [];
if (!hasKey("evm")) lines.push(`EVM_PRIVATE_KEY=${generatePrivateKey()}`);
if (!hasKey("solana")) lines.push(`SOLANA_PRIVATE_KEY=${bs58.encode(SolKeypair.generate().secretKey)}`);
if (!hasKey("sui")) lines.push(`SUI_PRIVATE_KEY=${new Ed25519Keypair().getSecretKey()}`);
if (!hasKey("stellar")) lines.push(`STELLAR_SECRET_KEY=${StellarKeypair.random().secret()}`);

if (lines.length) {
  const prefix = fs.existsSync(".env") && !fs.readFileSync(".env", "utf8").endsWith("\n") ? "\n" : "";
  fs.appendFileSync(".env", `${prefix}# --- wallets de laboratorio generadas ${new Date().toISOString()} (sólo testnet) ---\n${lines.join("\n")}\n`, { mode: 0o600 });
  for (const l of lines) process.env[l.split("=")[0]] = l.slice(l.indexOf("=") + 1);
  console.log(`Generadas ${lines.length} wallets nuevas: ${lines.map((l) => l.split("=")[0]).join(", ")}`);
} else console.log("Todas las familias ya tienen wallet en .env");
console.table(myAddresses());
