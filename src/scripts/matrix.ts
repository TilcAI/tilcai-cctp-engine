/**
 * Matriz CCTP de las 8 chains (56 pares ordenados).
 *   npm run matrix                    → matriz de soporte V1/V2 (sin firmar nada)
 *   npm run matrix -- --quote         → + fees reales de Iris: Fast/Standard (bps) y Forwarding Service (USDC)
 *   npm run matrix -- --run [--amount 0.05] [--fast] [--forward] [--hop base] [--only base,solana]
 *                         [--skip-src arbitrum,base] [--forward-to arbitrum,base] [--fast-src ethereum,solana] [--skip-done]
 *                                     → ejecuta TODOS los pares (los 4 sin ruta directa, en 2 saltos vía --hop)
 *     --skip-src     orígenes a omitir (p. ej. sin gas)
 *     --forward-to   destinos donde usar Circle Forwarding Service (p. ej. sin gas para el mint)
 *     --fast-src     orígenes donde usar Fast Transfer (ETH/L2/Solana: segundos en vez de ~15–19 min)
 *     --skip-done    no repite pares con status "ok" en results/transfers.jsonl
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
const list = (k: string) => (arg(k)?.split(",") ?? []) as ChainKey[];
const skipSrc = list("skip-src");
const forwardTo = list("forward-to");
const fastSrc = list("fast-src");
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
  const done = new Set<string>();
  if (flag("skip-done") && fs.existsSync("results/transfers.jsonl"))
    for (const l of fs.readFileSync("results/transfers.jsonl", "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l);
      if (r.status === "ok" && r.round) done.add(r.round);
    }
  const summary: Record<string, string>[] = [];
  const optsFor = (src: ChainKey, dst: ChainKey) => ({
    fast: flag("fast") || fastSrc.includes(src),
    forward: flag("forward") || forwardTo.includes(dst),
  });
  for (const [s, d] of pairs) {
    const tag = `${s}->${d}`;
    if (skipSrc.includes(s)) continue;
    if (done.has(tag)) {
      summary.push({ par: tag, estado: "ok (previo)" });
      continue;
    }
    const owner = me[familyOf(s)];
    if (!owner || !me[familyOf(d)]) {
      saveResult({ round: tag, src: s, dst: d, status: "skipped", error: "falta wallet en .env" });
      continue;
    }
    const bal = Number(await getBalance(s, owner).catch(() => "0"));
    if (bal < Number(amount)) {
      console.log(`⏭  ${nameOf(s)} → ${nameOf(d)}: saldo insuficiente (${bal} USDC)`);
      saveResult({ round: tag, src: s, dst: d, status: "skipped", error: `saldo insuficiente ${bal}` });
      summary.push({ par: tag, estado: "saldo insuficiente" });
      continue;
    }
    console.log(`\n════════ ${tag} ════════`);
    let r;
    if (planCctp(s, d).kind === "direct") {
      r = await cctpTransfer({ src: s, dst: d, amount, ...optsFor(s, d) });
    } else {
      const a = await cctpTransfer({ src: s, dst: hop, amount, ...optsFor(s, hop) });
      const got = a.balancesAfter && a.balancesBefore ? (Number(a.balancesAfter[hop]) - Number(a.balancesBefore[hop])).toFixed(6) : amount;
      r = a.status === "ok" ? await cctpTransfer({ src: hop, dst: d, amount: got, ...optsFor(hop, d) }) : a;
    }
    // marca de ronda para --skip-done
    saveResult({ round: tag, src: s, dst: d, status: r.status, error: r.error, burnTx: r.burnTx, mintTx: r.mintTx, totalSeconds: r.totalSeconds, version: r.version, forwarded: r.forwarded });
    summary.push({ par: tag, estado: r.status, v: `V${r.version}`, seg: String(r.totalSeconds ?? ""), error: (r.error ?? "").slice(0, 70) });
  }
  console.table(summary);
  console.log("Resultados en results/transfers.jsonl");
}
process.exit(0);
