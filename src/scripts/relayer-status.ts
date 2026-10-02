/**
 * Diagnóstico del OpenZeppelin Relayer.
 *   npm run relayer:status
 * Muestra salud, relayers configurados (red, dirección, saldo nativo y USDC) y el mapeo RELAYER_ID_<CHAIN> sugerido.
 */
import { EVM, STELLAR, type ChainKey } from "../config/chains.js";
import { RELAYER_URL, getBalance as relayerBalance, health, listRelayers, relayerIdFor } from "../relayer/client.js";
import { getBalance } from "../lib/balances.js";

// network del relayer (config.json del relayer) → chain del proyecto
const NETWORK_TO_CHAIN: Record<string, ChainKey> = {
  sepolia: "ethereum",
  "ethereum-sepolia": "ethereum",
  fuji: "avalanche",
  "avalanche-fuji": "avalanche",
  "arbitrum-sepolia": "arbitrum",
  "base-sepolia": "base",
  "arc-testnet": "arc",
  arc: "arc",
  testnet: "stellar",
  "stellar-testnet": "stellar",
};

console.log(`Relayer: ${RELAYER_URL}  health=${await health().catch((e) => `ERR ${e.message}`)}`);
console.log(`EXECUTOR=${process.env.EXECUTOR ?? "local"}`);
const relayers = await listRelayers();
const rows: Array<Record<string, unknown> & { chain: string; id: string }> = [];
for (const r of relayers) {
  const chain = r.network_type === "stellar" ? "stellar" : NETWORK_TO_CHAIN[r.network];
  const native = await relayerBalance(r.id).then((b) => `${b.balance} ${b.unit}`).catch((e) => `ERR ${String(e.message).slice(0, 40)}`);
  const usdc = chain && r.address ? await getBalance(chain, r.address).catch(() => "?") : "-";
  rows.push({ id: r.id, network: `${r.network_type}:${r.network}`, chain: chain ?? "(no usada)", address: r.address, paused: r.paused, nativo: native, USDC: usdc });
}
console.table(rows);

console.log("\nMapeo actual (.env) y sugerido:");
const chains: ChainKey[] = [...(Object.keys(EVM) as ChainKey[]), "stellar"];
console.table(
  chains.map((c) => ({
    chain: c,
    [`RELAYER_ID_${"<CHAIN>"}`]: `RELAYER_ID_${c.toUpperCase()}`,
    actual: relayerIdFor(c) ?? "",
    sugerido: rows.find((r) => r.chain === c)?.id ?? "(no hay relayer para esta red)",
  })),
);
console.log(`Stellar network del relayer debe ser testnet (${STELLAR.passphrase}). Solana y Sui siguen con wallet local.`);
process.exit(0);
