import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { CCTP_V2_EVM, EVM, type EvmChainCfg } from "../config/chains.js";
import { evmAccount } from "../lib/env.js";
import { log } from "../lib/log.js";
import type { Hex } from "../lib/encoding.js";

export type EvmKey = keyof typeof EVM;

const TOKEN_MESSENGER_V2_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);
const TOKEN_MESSENGER_V1_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)",
  "function depositForBurnWithCaller(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller) returns (uint64 nonce)",
]);
const MESSAGE_TRANSMITTER_ABI = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function usedNonces(bytes32) view returns (uint256)",
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
]);

export function viemChain(cfg: EvmChainCfg): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: cfg.nativeSymbol, symbol: cfg.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
    blockExplorers: { default: { name: "explorer", url: cfg.explorer } },
  });
}

const clients = new Map<string, { pub: PublicClient; wallet?: WalletClient }>();

export function evmClients(key: EvmKey, withWallet = true) {
  const cfg = EVM[key];
  const cached = clients.get(key);
  if (cached && (!withWallet || cached.wallet)) return { cfg, ...cached, wallet: cached.wallet! };
  const chain = viemChain(cfg);
  const pub = createPublicClient({ chain, transport: http(cfg.rpc, { retryCount: 3 }) }) as PublicClient;
  const wallet = withWallet ? createWalletClient({ chain, account: evmAccount(), transport: http(cfg.rpc) }) : undefined;
  clients.set(key, { pub, wallet });
  return { cfg, pub, wallet: wallet! };
}

export async function evmUsdcBalance(key: EvmKey, owner: string): Promise<bigint> {
  const { pub, cfg } = evmClients(key, false);
  return pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner as Hex] });
}

export async function evmNativeBalance(key: EvmKey, owner: string): Promise<bigint> {
  const { pub } = evmClients(key, false);
  return pub.getBalance({ address: owner as Hex });
}

async function ensureAllowance(key: EvmKey, spender: Hex, amount: bigint) {
  const { pub, wallet, cfg } = evmClients(key);
  const owner = wallet.account!.address;
  const current = await pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (current >= amount) return;
  log.info(`approve(${spender}, ${amount}) en ${cfg.name}`);
  const hash = await wallet.writeContract({
    address: cfg.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
    chain: wallet.chain,
    account: wallet.account!,
  });
  await pub.waitForTransactionReceipt({ hash });
  log.tx("approve", `${cfg.explorer}/tx/${hash}`);
}

export interface EvmBurnParams {
  key: EvmKey;
  amount: bigint; // 6 decimales
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: 1000 | 2000;
  hookData?: Hex;
  version: 1 | 2;
}

/** depositForBurn (V2 o V1). Devuelve el hash de la tx de burn. */
export async function evmBurn(p: EvmBurnParams): Promise<Hex> {
  const { pub, wallet, cfg } = evmClients(p.key);
  const account = wallet.account!;
  let hash: Hex;
  if (p.version === 2) {
    if (!cfg.cctpV2) throw new Error(`${cfg.name} no soporta CCTP V2`);
    await ensureAllowance(p.key, CCTP_V2_EVM.tokenMessenger, p.amount);
    const common = [p.amount, p.destinationDomain, p.mintRecipient, cfg.usdc, p.destinationCaller, p.maxFee, p.minFinalityThreshold] as const;
    hash = p.hookData
      ? await wallet.writeContract({
          address: CCTP_V2_EVM.tokenMessenger,
          abi: TOKEN_MESSENGER_V2_ABI,
          functionName: "depositForBurnWithHook",
          args: [...common, p.hookData],
          chain: wallet.chain,
          account,
        })
      : await wallet.writeContract({
          address: CCTP_V2_EVM.tokenMessenger,
          abi: TOKEN_MESSENGER_V2_ABI,
          functionName: "depositForBurn",
          args: common,
          chain: wallet.chain,
          account,
        });
  } else {
    if (!cfg.cctpV1) throw new Error(`${cfg.name} no tiene CCTP V1`);
    await ensureAllowance(p.key, cfg.cctpV1.tokenMessenger, p.amount);
    hash = await wallet.writeContract({
      address: cfg.cctpV1.tokenMessenger,
      abi: TOKEN_MESSENGER_V1_ABI,
      functionName: "depositForBurn",
      args: [p.amount, p.destinationDomain, p.mintRecipient, cfg.usdc],
      chain: wallet.chain,
      account,
    });
  }
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`burn revertido: ${hash}`);
  log.tx(`depositForBurn (CCTP v${p.version})`, `${cfg.explorer}/tx/${hash}`);
  return hash;
}

/** receiveMessage en el MessageTransmitter (V2 o V1) del destino → mintea USDC. */
export async function evmReceive(key: EvmKey, message: Hex, attestation: Hex, version: 1 | 2): Promise<Hex> {
  const { pub, wallet, cfg } = evmClients(key);
  const transmitter = version === 2 ? CCTP_V2_EVM.messageTransmitter : cfg.cctpV1?.messageTransmitter;
  if (!transmitter) throw new Error(`${cfg.name} sin MessageTransmitter v${version}`);
  const hash = await wallet.writeContract({
    address: transmitter as Hex,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [message, attestation],
    chain: wallet.chain,
    account: wallet.account!,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`receiveMessage revertido: ${hash}`);
  log.tx(`receiveMessage (CCTP v${version})`, `${cfg.explorer}/tx/${hash}`);
  return hash;
}

/** Comprueba on-chain que los contratos configurados existen y responden. */
export async function evmSelfCheck(key: EvmKey) {
  const { pub, cfg } = evmClients(key, false);
  const out: Record<string, unknown> = { chain: cfg.name };
  const code = async (a: string) => ((await pub.getCode({ address: a as Hex })) ?? "0x").length > 2;
  out.usdcCode = await code(cfg.usdc);
  out.v2Domain = await pub
    .readContract({ address: CCTP_V2_EVM.messageTransmitter, abi: MESSAGE_TRANSMITTER_ABI, functionName: "localDomain" })
    .catch((e) => `ERR ${String(e).slice(0, 60)}`);
  if (cfg.cctpV1)
    out.v1Domain = await pub
      .readContract({ address: cfg.cctpV1.messageTransmitter, abi: MESSAGE_TRANSMITTER_ABI, functionName: "localDomain" })
      .catch((e) => `ERR ${String(e).slice(0, 60)}`);
  return out;
}
