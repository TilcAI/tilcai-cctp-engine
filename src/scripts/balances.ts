/**
 * Saldos USDC + gas en las 8 chains.
 *   npm run balances                         → usa las wallets del .env
 *   npm run balances -- --evm 0xabc --solana <pk> --sui 0x.. --stellar G..   → cualquier dirección pública
 */
import { ALL_CHAINS, EVM, familyOf, nameOf } from "../config/chains.js";
import { myAddresses } from "../lib/env.js";
import { getBalance, getNativeBalance } from "../lib/balances.js";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const mine = myAddresses();
const addrs = {
  evm: (arg("evm") ?? mine.evm)?.split(","),
  solana: (arg("solana") ?? mine.solana)?.split(","),
  sui: (arg("sui") ?? mine.sui)?.split(","),
  stellar: (arg("stellar") ?? mine.stellar)?.split(","),
};

const rows: Record<string, string>[] = [];
await Promise.all(
  ALL_CHAINS.flatMap((chain) =>
    (addrs[familyOf(chain)] ?? []).map(async (owner) => {
      const [usdc, gas] = await Promise.all([
        getBalance(chain, owner).catch((e) => `ERR ${String(e.message ?? e).slice(0, 40)}`),
        getNativeBalance(chain, owner).catch((e) => `ERR ${String(e.message ?? e).slice(0, 40)}`),
      ]);
      const gasSym = familyOf(chain) === "evm" ? EVM[chain as keyof typeof EVM].nativeSymbol : { solana: "SOL", sui: "SUI", stellar: "XLM" }[familyOf(chain) as "solana"];
      rows.push({ chain: nameOf(chain), owner: owner.length > 20 ? `${owner.slice(0, 8)}…${owner.slice(-6)}` : owner, USDC: usdc, gas: `${gas} ${gasSym}` });
    }),
  ),
);
rows.sort((a, b) => ALL_CHAINS.findIndex((c) => nameOf(c) === a.chain) - ALL_CHAINS.findIndex((c) => nameOf(c) === b.chain));
console.table(rows);
const missing = Object.entries(addrs).filter(([, v]) => !v?.length).map(([k]) => k);
if (missing.length) console.log(`Sin dirección para: ${missing.join(", ")} (configura .env o pasa --${missing[0]} <addr>)`);
