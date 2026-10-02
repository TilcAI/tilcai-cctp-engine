import {
  encodeFunctionData,
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
import { getRelayer, relayerEnabled, relayerIdFor, sendEvmTx, waitTx } from "../relayer/client.js";

/** id del relayer OZ para esta chain si EXECUTOR=relayer, si no undefined (wallet local). */
function relayerFor(key: EvmKey): string | undefined {
  if (!relayerEnabled()) return undefined;
  const id = relayerIdFor(key);
  if (!id) throw new Error(`EXECUTOR=relayer pero falta RELAYER_ID_${key.toUpperCase()} en .env`);
  return id;
}

/** Dirección que firma en esta chain: la del relayer (modo relayer) o la wallet local. */
export async function evmSender(key: EvmKey): Promise<Hex> {
  const id = relayerFor(key);
  if (id) return (await getRelayer(id)).address as Hex;
  return evmAccount().address;
}

/** Envía una llamada: vía relayer OZ (firma y paga gas el relayer) o con la wallet local. */
async function sendCall(key: EvmKey, to: Hex, data: Hex, label: string): Promise<Hex> {
  const { pub, wallet, cfg } = evmClients(key, !relayerFor(key));
  const id = relayerFor(key);
  let hash: Hex;
  if (id) {
    const sent = await sendEvmTx(id, { to, data });
    log.info(`${label}: enviada al relayer ${id} (tx ${sent.id})`);
    hash = (await waitTx(id, sent.id)).hash as Hex;
  } else {
    hash = await (wallet as any).sendTransaction({ to, data, chain: wallet.chain, account: wallet.account! });
  }
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${label} revertido: ${hash}`);
  log.tx(`${label}${id ? " [relayer]" : ""}`, `${cfg.explorer}/tx/${hash}`);
  return hash;
}

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
  const { pub, cfg } = evmClients(key, false);
  const owner = await evmSender(key);
  const current = await pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (current >= amount) return;
  log.info(`approve(${spender}, ${amount}) en ${cfg.name}`);
  await sendCall(key, cfg.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), "approve");
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
  const { cfg } = evmClients(p.key, false);
  if (p.version === 2) {
    if (!cfg.cctpV2) throw new Error(`${cfg.name} no soporta CCTP V2`);
    await ensureAllowance(p.key, CCTP_V2_EVM.tokenMessenger, p.amount);
    const common = [p.amount, p.destinationDomain, p.mintRecipient, cfg.usdc, p.destinationCaller, p.maxFee, p.minFinalityThreshold] as const;
    const data = p.hookData
      ? encodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, functionName: "depositForBurnWithHook", args: [...common, p.hookData] })
      : encodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, functionName: "depositForBurn", args: common });
    return sendCall(p.key, CCTP_V2_EVM.tokenMessenger, data, "depositForBurn (CCTP v2)");
  }
  if (!cfg.cctpV1) throw new Error(`${cfg.name} no tiene CCTP V1`);
  await ensureAllowance(p.key, cfg.cctpV1.tokenMessenger, p.amount);
  const data = encodeFunctionData({ abi: TOKEN_MESSENGER_V1_ABI, functionName: "depositForBurn", args: [p.amount, p.destinationDomain, p.mintRecipient, cfg.usdc] });
  return sendCall(p.key, cfg.cctpV1.tokenMessenger, data, "depositForBurn (CCTP v1)");
}

/** receiveMessage en el MessageTransmitter (V2 o V1) del destino → mintea USDC. */
export async function evmReceive(key: EvmKey, message: Hex, attestation: Hex, version: 1 | 2): Promise<Hex> {
  const { cfg } = evmClients(key, false);
  const transmitter = version === 2 ? CCTP_V2_EVM.messageTransmitter : cfg.cctpV1?.messageTransmitter;
  if (!transmitter) throw new Error(`${cfg.name} sin MessageTransmitter v${version}`);
  const data = encodeFunctionData({ abi: MESSAGE_TRANSMITTER_ABI, functionName: "receiveMessage", args: [message, attestation] });
  return sendCall(key, transmitter as Hex, data, `receiveMessage (CCTP v${version})`);
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
