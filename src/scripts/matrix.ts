/**
 * Matriz CCTP de las 8 chains (56 pares ordenados).
 *   npm run matrix                    → matriz de soporte V1/V2 (sin firmar nada)
 *   npm run matrix -- --quote         → + fees reales de Iris: Fast/Standard (bps) y Forwarding Service (USDC)
 *   npm run matrix -- --run [--amount 0.05] [--fast] [--forward] [--hop base] [--only base,solana]
 *                                     → ejecuta TODOS los pares (los 4 sin ruta directa, en 2 saltos vía --hop)
 */
import fs from "node:fs";
import { ALL_CHAINS, domainOf, familyOf, nameOf, type ChainKey } from "../config/chains.js";
import { planCctp, cctpTransfer, saveResult } from "../cctp/route.js";
import { getFeeBps, getForwardFee } from "../lib/iris.js";
import { fromUnits } from "../lib/encoding.js";
import { myAddresses } from "../lib/env.js";
import { getBalance } from "../lib/balances.js";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k: string) => args.includes(`--${k}`);
const only = arg("only")?.split(",") as ChainKey[] | undefined;
const chains = only ?? ALL_CHAINS;
const hop = (arg("hop") ?? "base") as ChainKey;
const short: Record<ChainKey, string> = { ethereum: "ETH", avalanche: "AVAX", arbitrum: "ARB", base: "BASE", arc: "ARC", solana: "SOL", sui: "SUI", stellar: "XLM" };

function cell(src: ChainKey, dst: ChainKey) {
  if (src === dst) return "—";
  const p = planCctp(src, dst);
  return p.kind === "direct" ? `V${p.version}` : `✗ (vía ${short[hop]})`;
}

console.log("\nMatriz CCTP (filas = origen, columnas = destino). V2/V1 = ruta directa, ✗ = requiere 2 saltos\n");
const table: Record<string, Record<string, string>> = {};
for (const s of chains) {
  table[short[s]] = {};
  for (const d of chains) table[short[s]][short[d]] = cell(s, d);
}
console.table(table);

if (flag("quote")) {
  const out: Record<string, unknown>[] = [];
  for (const s of chains)
    for (const d of chains) {
      if (s === d) continue;
      const p = planCctp(s, d);
      const row: Record<string, unknown> = { par: `${short[s]}→${short[d]}`, cctp: p.kind === "direct" ? `V${p.version}` : "✗" };
      if (p.kind === "direct" && p.version === 2) {
        const f = await getFeeBps(domainOf(s), domainOf(d)).catch(() => undefined);
        row.fastBps = f?.fast;
        row.standardBps = f?.standard;
        row.forwardFeeUSDC = await getForwardFee(domainOf(s), domainOf(d))
          .then((x) => fromUnits(x.high, 6))
          .catch(() => "no soportado");
      } else if (p.kind === "direct") row.nota = "V1: sin fees de protocolo, sin Fast, sin forwarding";
      else row.nota = `2 saltos: ${short[s]}→${short[hop]}→${short[d]}`;
      out.push(row);
    }
  console.table(out);
  fs.mkdirSync("results", { recursive: true });
  fs.writeFileSync("results/quotes.json", JSON.stringify(out, null, 2));
}

if (flag("run")) {
  const amount = arg("amount") ?? "0.05";
  const me = myAddresses();
  // Orden round-robin por distancia: para cada desplazamiento k recorre s → s+k,
  // de modo que los fondos que entran a una chain se reutilizan en la siguiente ronda.
  const pairs: [ChainKey, ChainKey][] = [];
  for (let k = 1; k < chains.length; k++) for (let i = 0; i < chains.length; i++) pairs.push([chains[i], chains[(i + k) % chains.length]]);
  for (const [s, d] of pairs) {
    const owner = me[familyOf(s)];
    if (!owner || !me[familyOf(d)]) {
      saveResult({ src: s, dst: d, status: "skipped", error: "falta wallet en .env" });
      continue;
    }
    const bal = Number(await getBalance(s, owner).catch(() => "0"));
    if (bal < Number(amount)) {
      console.log(`⏭  ${nameOf(s)} → ${nameOf(d)}: saldo insuficiente (${bal} USDC)`);
      saveResult({ src: s, dst: d, status: "skipped", error: `saldo insuficiente ${bal}` });
      continue;
    }
    const opts = { fast: flag("fast"), forward: flag("forward") };
    if (planCctp(s, d).kind === "direct") {
      await cctpTransfer({ src: s, dst: d, amount, ...opts });
    } else {
      const a = await cctpTransfer({ src: s, dst: hop, amount, ...opts });
      const got = a.balancesAfter && a.balancesBefore ? (Number(a.balancesAfter[hop]) - Number(a.balancesBefore[hop])).toFixed(6) : amount;
      if (a.status === "ok") await cctpTransfer({ src: hop, dst: d, amount: got, ...opts });
    }
  }
  console.log("Resultados en results/transfers.jsonl");
}
process.exit(0);
