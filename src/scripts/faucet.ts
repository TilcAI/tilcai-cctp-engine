/**
 * Faucets programáticos (testnet):
 *  - SOL devnet: requestAirdrop (rate-limited)
 *  - SUI testnet: faucet.testnet.sui.io/v2/gas
 *  - XLM testnet: Friendbot + trustline USDC
 *  - USDC (todas las chains): API de Circle (requiere CIRCLE_API_KEY de testnet) — si no, imprime el link al faucet web.
 * El gas de EVM (Sepolia ETH, Fuji AVAX, …) requiere faucets web con captcha: se listan al final.
 */
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { myAddresses, hasKey } from "../lib/env.js";
import { log } from "../lib/log.js";

const me = myAddresses();
const args = process.argv.slice(2);

if (me.solana) {
  const { solConnection } = await import("../cctp/solana.js");
  try {
    const sig = await solConnection().requestAirdrop(new PublicKey(me.solana), 0.5 * LAMPORTS_PER_SOL);
    log.ok(`SOL airdrop solicitado: ${sig}`);
  } catch (e) {
    log.warn(`SOL airdrop falló (rate limit habitual): ${String(e).slice(0, 120)} → usa https://faucet.solana.com`);
  }
}

if (me.sui) {
  const { requestSuiFromFaucetV2, getFaucetHost } = await import("@mysten/sui/faucet");
  try {
    const r = await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: me.sui });
    log.ok(`SUI faucet: ${JSON.stringify(r).slice(0, 120)}`);
  } catch (e) {
    log.warn(`SUI faucet falló: ${String(e).slice(0, 160)} → usa https://faucet.sui.io (testnet)`);
  }
}

if (me.stellar) {
  const { stellarBalances, stellarFriendbot, ensureUsdcTrustline } = await import("../cctp/stellar.js");
  const st = await stellarBalances(me.stellar);
  if (!st.exists) await stellarFriendbot(me.stellar);
  if (hasKey("stellar")) await ensureUsdcTrustline();
}

// Circle faucet API: https://developers.circle.com/api-reference/faucet/drip
const circleChains: Record<string, string> = {
  ethereum: "ETH-SEPOLIA",
  avalanche: "AVAX-FUJI",
  arbitrum: "ARB-SEPOLIA",
  base: "BASE-SEPOLIA",
  arc: "ARC-TESTNET",
  solana: "SOL-DEVNET",
  sui: "SUI-TESTNET",
  stellar: "XLM-TESTNET",
};
const key = process.env.CIRCLE_API_KEY;
if (key && args.includes("--usdc")) {
  const fam = (c: string) => (c === "solana" ? "solana" : c === "sui" ? "sui" : c === "stellar" ? "stellar" : "evm") as keyof typeof me;
  for (const [chain, blockchain] of Object.entries(circleChains)) {
    const address = me[fam(chain)];
    if (!address) continue;
    const r = await fetch("https://api.circle.com/v1/faucet/drips", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ address, blockchain, usdc: true, native: chain === "arc" }),
    });
    log.info(`Circle faucet ${blockchain}: HTTP ${r.status} ${(await r.text()).slice(0, 100)}`);
  }
} else {
  log.info("USDC testnet: https://faucet.circle.com (10 USDC/2h por chain) — o define CIRCLE_API_KEY y corre con --usdc");
}

console.log(`
Gas EVM (faucets web):
  Sepolia ETH .......... https://cloud.google.com/application/web3/faucet/ethereum/sepolia
  Fuji AVAX ............ https://core.app/tools/testnet-faucet/?subnet=c&token=c
  Arbitrum Sepolia ETH . https://www.alchemy.com/faucets/arbitrum-sepolia
  Base Sepolia ETH ..... https://www.alchemy.com/faucets/base-sepolia
  Arc (gas = USDC) ..... https://faucet.circle.com  (elige "Arc Testnet")
`);
