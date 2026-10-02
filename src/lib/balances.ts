import { EVM, familyOf, usdcDecimals, type ChainKey } from "../config/chains.js";
import { fromUnits } from "./encoding.js";

/** Saldo USDC (string legible) de `owner` en `chain`. Importa adaptadores en caliente para no exigir todas las keys. */
export async function getBalance(chain: ChainKey, owner: string): Promise<string> {
  const dec = usdcDecimals(chain);
  switch (familyOf(chain)) {
    case "evm": {
      const { evmUsdcBalance } = await import("../cctp/evm.js");
      return fromUnits(await evmUsdcBalance(chain as keyof typeof EVM, owner), dec);
    }
    case "solana": {
      const { solUsdcBalance } = await import("../cctp/solana.js");
      return fromUnits(await solUsdcBalance(owner), dec);
    }
    case "sui": {
      const { suiUsdcBalance } = await import("../cctp/sui.js");
      return fromUnits(await suiUsdcBalance(owner), dec);
    }
    case "stellar": {
      const { stellarBalances } = await import("../cctp/stellar.js");
      return fromUnits((await stellarBalances(owner)).usdc, dec);
    }
  }
}

/** Saldo de gas nativo (string legible). */
export async function getNativeBalance(chain: ChainKey, owner: string): Promise<string> {
  switch (familyOf(chain)) {
    case "evm": {
      const { evmNativeBalance } = await import("../cctp/evm.js");
      return fromUnits(await evmNativeBalance(chain as keyof typeof EVM, owner), 18);
    }
    case "solana": {
      const { solNativeBalance } = await import("../cctp/solana.js");
      return fromUnits(await solNativeBalance(owner), 9);
    }
    case "sui": {
      const { suiNativeBalance } = await import("../cctp/sui.js");
      return fromUnits(await suiNativeBalance(owner), 9);
    }
    case "stellar": {
      const { stellarBalances } = await import("../cctp/stellar.js");
      return fromUnits((await stellarBalances(owner)).xlm, 7);
    }
  }
}
