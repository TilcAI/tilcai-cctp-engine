/**
 * Transferencia CCTP individual.
 *   npm run transfer -- --from base --to solana --amount 0.1 [--fast] [--to-address X]
 *   npm run transfer -- --from base --to arc --amount 1 --forward   (Circle ejecuta el mint en destino)
 *   npm run transfer -- --from sui --to arc --amount 0.1 --via base  (2 saltos: V1 → V2)
 *   npm run transfer -- --from avalanche --to solana --resume-tx 0x…  (completa el mint de un burn ya hecho)
 */
import { ALL_CHAINS, type ChainKey } from "../config/chains.js";
import { cctpResume, cctpTransfer } from "../cctp/route.js";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k: string) => args.includes(`--${k}`);

const from = arg("from") as ChainKey;
const to = arg("to") as ChainKey;
const amount = arg("amount") ?? "0.1";
const via = arg("via") as ChainKey | undefined;
for (const c of [from, to, via].filter(Boolean)) if (!ALL_CHAINS.includes(c!)) throw new Error(`chain desconocida: ${c}. Opciones: ${ALL_CHAINS.join(", ")}`);

if (arg("resume-tx")) {
  await cctpResume({ src: from, dst: to, burnTx: arg("resume-tx")! });
} else if (via) {
  const a = await cctpTransfer({ src: from, dst: via, amount, fast: flag("fast") });
  // 2º salto con lo que realmente llegó (el 1º puede haber cobrado fee)
  const got = a.balancesAfter && a.balancesBefore ? (Number(a.balancesAfter[via]) - Number(a.balancesBefore[via])).toFixed(6) : amount;
  if (a.status === "ok") await cctpTransfer({ src: via, dst: to, amount: got, fast: flag("fast"), forward: flag("forward"), recipient: arg("to-address") });
} else {
  await cctpTransfer({ src: from, dst: to, amount, fast: flag("fast"), forward: flag("forward"), recipient: arg("to-address") });
}
process.exit(0);
