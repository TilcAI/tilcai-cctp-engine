import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { encodeFunctionData, parseAbi } from "viem";

// Relayer OpenZeppelin simulado: valida auth/rutas/cuerpos y simula el ciclo pending → submitted → confirmed.
const calls: Array<{ method: string; url: string; auth?: string; body?: any }> = [];
let polls = 0;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const send = (code: number, data: unknown, error?: string) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: code < 400, data, error }));
    };
    if (req.headers.authorization !== "Bearer test-key") return send(401, null, "Unauthorized");
    if (req.method === "GET" && req.url === "/api/v1/relayers/fuji-1")
      return send(200, { id: "fuji-1", name: "fuji", network: "fuji", network_type: "evm", paused: false, address: "0x4ff191f9455ef7ce090665c07d3320fd90a9ab8c" });
    if (req.method === "POST" && req.url === "/api/v1/relayers/fuji-1/transactions") return send(200, { id: "tx-1", status: "pending" });
    if (req.method === "POST" && req.url === "/api/v1/relayers/xlm-1/transactions") return send(200, { id: "tx-2", status: "pending" });
    if (req.method === "GET" && req.url?.startsWith("/api/v1/relayers/fuji-1/transactions/tx-1")) {
      polls++;
      return send(200, polls < 2 ? { id: "tx-1", status: "submitted", hash: "0xabc" } : { id: "tx-1", status: "confirmed", hash: "0xabc" });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/v1/relayers/fuji-1/transactions/tx-fail"))
      return send(200, { id: "tx-fail", status: "failed", status_reason: "execution reverted" });
    send(404, null, "not found");
  });
});

let client: typeof import("../relayer/client.js");
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.RELAYER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.RELAYER_API_KEY = "test-key";
  process.env.EXECUTOR = "relayer";
  process.env.RELAYER_ID_AVALANCHE = "fuji-1";
  client = await import("../relayer/client.js");
});
after(() => server.close());

test("modo relayer y mapeo de ids por chain", () => {
  assert.equal(client.relayerEnabled(), true);
  assert.equal(client.relayerIdFor("avalanche"), "fuji-1");
  assert.equal(client.relayerIdFor("sui"), undefined);
});

test("EVM: envía calldata de depositForBurn con Bearer y espera confirmación", async () => {
  const data = encodeFunctionData({
    abi: parseAbi(["function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"]),
    args: [250000n, 27, `0x${"11".repeat(32)}`, "0x5425890298aed601595a70AB815c96711a31Bc65", `0x${"00".repeat(32)}`, 0n, 2000],
  });
  const sent = await client.sendEvmTx("fuji-1", { to: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", data });
  assert.equal(sent.id, "tx-1");
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/fuji-1/transactions"))!;
  assert.equal(post.auth, "Bearer test-key");
  assert.deepEqual(post.body, { value: 0, speed: "fast", to: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", data });
  const done = await client.waitTx("fuji-1", "tx-1");
  assert.equal(done.status, "confirmed");
  assert.equal(done.hash, "0xabc");
});

test("Stellar: envía transaction_xdr + network", async () => {
  await client.sendStellarXdr("xlm-1", "testnet", "AAAA");
  const post = calls.find((c) => c.url.endsWith("/xlm-1/transactions"))!;
  assert.deepEqual(post.body, { network: "testnet", transaction_xdr: "AAAA" });
});

test("tx fallida en el relayer se propaga como error", async () => {
  await assert.rejects(client.waitTx("fuji-1", "tx-fail"), /failed: execution reverted/);
});

test("sin API key válida → error 401 legible", async () => {
  process.env.RELAYER_API_KEY = "bad";
  await assert.rejects(client.getRelayer("fuji-1"), /HTTP 401 Unauthorized/);
  process.env.RELAYER_API_KEY = "test-key";
});

test("evmSender usa la dirección del relayer en modo relayer", async () => {
  const { evmSender } = await import("../cctp/evm.js");
  assert.equal(await evmSender("avalanche"), "0x4ff191f9455ef7ce090665c07d3320fd90a9ab8c");
});
