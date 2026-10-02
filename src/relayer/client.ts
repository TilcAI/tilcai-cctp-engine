import "dotenv/config";
import { log } from "../lib/log.js";
import type { ChainKey } from "../config/chains.js";

/**
 * Cliente mínimo del OpenZeppelin Relayer (API v1).
 *   RELAYER_URL       base del servicio (p. ej. http://192.168.1.57:8080 → luego http://localhost:8080)
 *   RELAYER_API_KEY   Bearer token del relayer
 *   RELAYER_ID_<CHAIN> id del relayer configurado para cada red (ETHEREUM, AVALANCHE, ARBITRUM, BASE, ARC, STELLAR)
 *
 * El relayer firma y envía con SU signer (y paga el gas): en modo relayer la cuenta
 * de origen/destino de CCTP es la dirección del relayer, no la wallet local.
 */

export const RELAYER_URL = (process.env.RELAYER_URL ?? "http://localhost:8080").replace(/\/$/, "");

export function relayerEnabled(): boolean {
  return (process.env.EXECUTOR ?? "local").toLowerCase() === "relayer";
}

export function relayerIdFor(chain: ChainKey): string | undefined {
  return process.env[`RELAYER_ID_${chain.toUpperCase()}`]?.trim() || undefined;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = process.env.RELAYER_API_KEY?.trim();
  if (!key) throw new Error("Falta RELAYER_API_KEY en .env");
  const res = await fetch(`${RELAYER_URL}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Relayer ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.success === false) throw new Error(`Relayer ${method} ${path}: HTTP ${res.status} ${json.error ?? text.slice(0, 200)}`);
  return json.data as T;
}

export interface RelayerInfo {
  id: string;
  name: string;
  network: string;
  network_type: "evm" | "solana" | "stellar";
  paused: boolean;
  address?: string;
}

export interface RelayerTx {
  id: string;
  hash?: string | null;
  status: "pending" | "sent" | "submitted" | "mined" | "confirmed" | "failed" | "expired" | "canceled";
  status_reason?: string | null;
  from?: string;
}

export const health = async () => (await fetch(`${RELAYER_URL}/api/v1/health`)).status;
export const listRelayers = () => call<RelayerInfo[]>("GET", "/relayers?per_page=100");
export const getRelayer = (id: string) => call<RelayerInfo>("GET", `/relayers/${id}`);
export const getBalance = (id: string) => call<{ balance: string | number; unit: string }>("GET", `/relayers/${id}/balance`);
export const getTx = (id: string, txId: string) => call<RelayerTx>("GET", `/relayers/${id}/transactions/${txId}`);

export function sendEvmTx(id: string, tx: { to: string; data: string; value?: bigint; gas_limit?: number; speed?: "fastest" | "fast" | "average" | "safeLow" }) {
  return call<RelayerTx>("POST", `/relayers/${id}/transactions`, { value: 0, speed: "fast", ...tx });
}

export function sendStellarXdr(id: string, network: string, transaction_xdr: string) {
  return call<RelayerTx>("POST", `/relayers/${id}/transactions`, { network, transaction_xdr });
}

/** Espera a que el relayer confirme la tx (mined/confirmed) y devuelve el hash on-chain. */
export async function waitTx(id: string, txId: string, timeoutMs = 10 * 60_000): Promise<RelayerTx> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const tx = await getTx(id, txId);
    if (tx.status !== last) log.info(`relayer tx ${txId.slice(0, 8)}…: ${tx.status}${tx.hash ? ` (${tx.hash})` : ""}`);
    last = tx.status;
    if (tx.status === "confirmed" || tx.status === "mined") return tx;
    if (["failed", "expired", "canceled"].includes(tx.status)) throw new Error(`Relayer tx ${tx.status}: ${tx.status_reason ?? ""}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Timeout esperando tx ${txId} del relayer`);
}
