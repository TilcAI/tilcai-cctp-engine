/**
 * Configuración central de TESTNET para CCTP (Circle Cross-Chain Transfer Protocol).
 *
 * Fuentes (verificadas 2026-10-02):
 *  - https://developers.circle.com/cctp/cctp-supported-blockchains
 *  - https://developers.circle.com/cctp/evm-smart-contracts           (V2)
 *  - https://developers.circle.com/cctp/v1/evm-smart-contracts        (V1 legacy)
 *  - https://developers.circle.com/cctp/solana-programs
 *  - https://developers.circle.com/cctp/v1/sui-packages
 *  - https://developers.circle.com/cctp/references/stellar-contracts
 *  - https://developers.circle.com/stablecoins/usdc-contract-addresses
 */

export type ChainKey =
  | "ethereum"
  | "avalanche"
  | "arbitrum"
  | "base"
  | "arc"
  | "solana"
  | "sui"
  | "stellar";

export type Family = "evm" | "solana" | "sui" | "stellar";

export const IRIS_API = process.env.IRIS_API_URL ?? "https://iris-api-sandbox.circle.com";

/** Contratos CCTP V2 en EVM testnet: misma dirección (CREATE2) en todas las chains. */
export const CCTP_V2_EVM = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinter: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
  message: "0xbaC0179bB358A8936169a63408C8481D582390C4",
} as const;

export interface EvmChainCfg {
  key: ChainKey;
  family: "evm";
  name: string;
  chainId: number;
  rpc: string;
  explorer: string;
  nativeSymbol: string;
  usdc: `0x${string}`;
  cctpDomain: number;
  cctpV2: boolean;
  /** Contratos CCTP V1 (legacy) — sólo necesarios para hablar con Sui (V1-only). */
  cctpV1?: { tokenMessenger: `0x${string}`; messageTransmitter: `0x${string}` };
}

export interface SolanaCfg {
  key: "solana";
  family: "solana";
  name: string;
  rpc: string;
  explorer: string;
  usdcMint: string;
  cctpDomain: 5;
  cctpV2: { messageTransmitter: string; tokenMessengerMinter: string };
  cctpV1: { messageTransmitter: string; tokenMessengerMinter: string };
}

export interface SuiCfg {
  key: "sui";
  family: "sui";
  name: string;
  rpc: string;
  faucet: string;
  explorer: string;
  cctpDomain: 8;
  usdcPackage: string;
  usdcType: string;
  cctpV1: {
    messageTransmitterPkg: string;
    tokenMessengerMinterPkg: string;
    messageTransmitterState: string;
    tokenMessengerMinterState: string;
    usdcTreasury: string;
  };
}

export interface StellarCfg {
  key: "stellar";
  family: "stellar";
  name: string;
  rpc: string;
  horizon: string;
  friendbot: string;
  passphrase: string;
  explorer: string;
  cctpDomain: 27;
  usdcSac: string; // Stellar Asset Contract (Soroban) de USDC
  usdcIssuer: string; // Asset clásico USDC:G...
  decimals: 7;
  cctpV2: { tokenMessengerMinter: string; messageTransmitter: string; cctpForwarder: string };
}

const env = (k: string, d: string) => process.env[k] || d;

export const EVM: Record<"ethereum" | "avalanche" | "arbitrum" | "base" | "arc", EvmChainCfg> = {
  ethereum: {
    key: "ethereum",
    family: "evm",
    name: "Ethereum Sepolia",
    chainId: 11155111,
    rpc: env("RPC_ETHEREUM_SEPOLIA", "https://ethereum-sepolia-rpc.publicnode.com"),
    explorer: "https://sepolia.etherscan.io",
    nativeSymbol: "ETH",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    cctpDomain: 0,
    cctpV2: true,
    cctpV1: { tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", messageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
  },
  avalanche: {
    key: "avalanche",
    family: "evm",
    name: "Avalanche Fuji",
    chainId: 43113,
    rpc: env("RPC_AVALANCHE_FUJI", "https://api.avax-test.network/ext/bc/C/rpc"),
    explorer: "https://testnet.snowtrace.io",
    nativeSymbol: "AVAX",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    cctpDomain: 1,
    cctpV2: true,
    cctpV1: { tokenMessenger: "0xeb08f243E5d3FCFF26A9E38Ae5520A669f4019d0", messageTransmitter: "0xa9fB1b3009DCb79E2fe346c16a604B8Fa8aE0a79" },
  },
  arbitrum: {
    key: "arbitrum",
    family: "evm",
    name: "Arbitrum Sepolia",
    chainId: 421614,
    rpc: env("RPC_ARBITRUM_SEPOLIA", "https://sepolia-rollup.arbitrum.io/rpc"),
    explorer: "https://sepolia.arbiscan.io",
    nativeSymbol: "ETH",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    cctpDomain: 3,
    cctpV2: true,
    cctpV1: { tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", messageTransmitter: "0xaCF1ceeF35caAc005e15888dDb8A3515C41B4872" },
  },
  base: {
    key: "base",
    family: "evm",
    name: "Base Sepolia",
    chainId: 84532,
    rpc: env("RPC_BASE_SEPOLIA", "https://sepolia.base.org"),
    explorer: "https://sepolia.basescan.org",
    nativeSymbol: "ETH",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    cctpDomain: 6,
    cctpV2: true,
    cctpV1: { tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", messageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
  },
  arc: {
    key: "arc",
    family: "evm",
    name: "Arc Testnet",
    chainId: 5042002,
    rpc: env("RPC_ARC_TESTNET", "https://rpc.testnet.arc.network"),
    explorer: "https://testnet.arcscan.app",
    // En Arc el gas se paga en USDC (moneda nativa, 18 decimales); la interfaz
    // ERC-20 opcional en 0x3600…0000 expone el MISMO saldo con 6 decimales.
    nativeSymbol: "USDC",
    usdc: "0x3600000000000000000000000000000000000000",
    cctpDomain: 26,
    cctpV2: true,
    // Arc no tiene CCTP V1 → no puede hablar directamente con Sui.
  },
};

export const SOLANA: SolanaCfg = {
  key: "solana",
  family: "solana",
  name: "Solana Devnet",
  rpc: env("RPC_SOLANA_DEVNET", "https://api.devnet.solana.com"),
  explorer: "https://explorer.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  cctpDomain: 5,
  cctpV2: {
    messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
    tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  },
  cctpV1: {
    messageTransmitter: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    tokenMessengerMinter: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  },
};

export const SUI: SuiCfg = {
  key: "sui",
  family: "sui",
  name: "Sui Testnet",
  rpc: env("RPC_SUI_TESTNET", "https://fullnode.testnet.sui.io:443"),
  faucet: "https://faucet.testnet.sui.io/v2/gas",
  explorer: "https://suiscan.xyz/testnet",
  cctpDomain: 8,
  usdcPackage: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29",
  usdcType: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  cctpV1: {
    messageTransmitterPkg: "0x4931e06dce648b3931f890035bd196920770e913e43e45990b383f6486fdd0a5",
    tokenMessengerMinterPkg: "0x31cc14d80c175ae39777c0238f20594c6d4869cfab199f40b69f3319956b8beb",
    messageTransmitterState: "0x98234bd0fa9ac12cc0a20a144a22e36d6a32f7e0a97baaeaf9c76cdc6d122d2e",
    tokenMessengerMinterState: "0x5252abd1137094ed1db3e0d75bc36abcd287aee4bc310f8e047727ef5682e7c2",
    usdcTreasury: "0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe",
  },
};

export const STELLAR: StellarCfg = {
  key: "stellar",
  family: "stellar",
  name: "Stellar Testnet",
  rpc: env("RPC_STELLAR_TESTNET", "https://soroban-testnet.stellar.org"),
  horizon: "https://horizon-testnet.stellar.org",
  friendbot: "https://friendbot.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
  explorer: "https://stellar.expert/explorer/testnet",
  cctpDomain: 27,
  usdcSac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  decimals: 7,
  cctpV2: {
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  },
};

export const ALL_CHAINS: ChainKey[] = ["ethereum", "avalanche", "arbitrum", "base", "arc", "solana", "sui", "stellar"];

export function familyOf(k: ChainKey): Family {
  if (k === "solana") return "solana";
  if (k === "sui") return "sui";
  if (k === "stellar") return "stellar";
  return "evm";
}

export function domainOf(k: ChainKey): number {
  if (k === "solana") return SOLANA.cctpDomain;
  if (k === "sui") return SUI.cctpDomain;
  if (k === "stellar") return STELLAR.cctpDomain;
  return EVM[k].cctpDomain;
}

export function nameOf(k: ChainKey): string {
  if (k === "solana") return SOLANA.name;
  if (k === "sui") return SUI.name;
  if (k === "stellar") return STELLAR.name;
  return EVM[k].name;
}

/** Decimales de USDC en la representación usada por CCTP en cada chain. */
export function usdcDecimals(k: ChainKey): number {
  return k === "stellar" ? 7 : 6;
}

/** Versiones de CCTP disponibles por chain. */
export function cctpVersions(k: ChainKey): Array<1 | 2> {
  switch (k) {
    case "sui":
      return [1];
    case "arc":
    case "stellar":
      return [2];
    case "solana":
      return [1, 2];
    default:
      return [1, 2];
  }
}
