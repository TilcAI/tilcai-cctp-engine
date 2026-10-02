import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  evmToBytes32,
  fromUnits,
  hexToBuf,
  mintTargetFor,
  solanaToBytes32,
  stellarContractToBytes32,
  stellarForwarderHookData,
  toUnits,
} from "../lib/encoding.js";
import { FORWARD_HOOK, maxFeeFor } from "../lib/iris.js";
import { planCctp } from "../cctp/route.js";
import { STELLAR } from "../config/chains.js";

// Mensaje CCTP V2 REAL (Base Sepolia → Arc, Fast, Forwarding Service), tx
// 0x24b0ab2ba21e2db5902d952a13adf89f21b82e6a1670c1d4281cad126acea9a7 — obtenido de Iris.
const REAL_V2 =
  "0x00000001000000060000001a0c05a332babcb0ce30885c69536bdc00aabf8f230f59491e17525168c64774280000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000003e8000003e800000001000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e0000000000000000000000005caca04d787f5f28e49ad0085275a5056dd542c400000000000000000000000000000000000000000000000000000000001e8480000000000000000000000000c5567a5e3370d4dbfb0540025078e283e36a363d0000000000000000000000000000000000000000000000000000000000004ecb0000000000000000000000000000000000000000000000000000000000004ecb0000000000000000000000000000000000000000000000000000000003e393bd636374702d666f72776172640000000000000000000000000000000000000000";

test("layout del header y body de CCTP V2 (offsets)", () => {
  const m = hexToBuf(REAL_V2);
  assert.equal(m.readUInt32BE(0), 1, "version header = 1 (V2)");
  assert.equal(m.readUInt32BE(4), 6, "sourceDomain = Base");
  assert.equal(m.readUInt32BE(8), 26, "destinationDomain = Arc");
  assert.equal(m.subarray(12, 44).toString("hex"), "0c05a332babcb0ce30885c69536bdc00aabf8f230f59491e17525168c6477428", "nonce bytes32");
  assert.equal(m.subarray(64, 76).toString("hex"), "8fe6b999dc680ccfdd5bf7eb0974218be2542daa".slice(16), "sender = TokenMessengerV2");
  assert.equal(m.readUInt32BE(140), 1000, "minFinalityThreshold");
  assert.equal(m.readUInt32BE(144), 1000, "finalityThresholdExecuted");
  const body = m.subarray(148);
  assert.equal(body.readUInt32BE(0), 1, "body version");
  assert.equal(`0x${body.subarray(16, 36).toString("hex")}`, "0x036cbd53842c5426634e7929541ec2318f3dcf7e", "burnToken = USDC Base Sepolia");
  assert.equal(BigInt(`0x${body.subarray(68, 100).toString("hex")}`), 2_000_000n, "amount 2 USDC");
  assert.equal(BigInt(`0x${body.subarray(132, 164).toString("hex")}`), 20171n, "maxFee");
  assert.equal(BigInt(`0x${body.subarray(164, 196).toString("hex")}`), 20171n, "feeExecuted");
  assert.equal(`0x${body.subarray(228).toString("hex")}`, FORWARD_HOOK, "hookData = 'cctp-forward'");
});

test("bytes32 de EVM y Solana", () => {
  assert.equal(evmToBytes32("0x5caca04d787f5f28e49ad0085275a5056dd542c4"), "0x0000000000000000000000005caca04d787f5f28e49ad0085275a5056dd542c4");
  assert.equal(solanaToBytes32("11111111111111111111111111111111"), `0x${"00".repeat(32)}`);
});

test("Stellar: mintRecipient y destinationCaller = CctpForwarder, hookData con strkey", () => {
  const g = Keypair.random().publicKey();
  const t = mintTargetFor("stellar", g);
  const fwd = stellarContractToBytes32(STELLAR.cctpV2.cctpForwarder);
  assert.equal(t.mintRecipient, fwd);
  assert.equal(t.destinationCaller, fwd);
  const h = hexToBuf(stellarForwarderHookData(g));
  assert.equal(h.readUInt32BE(24), 0, "hook version");
  assert.equal(h.readUInt32BE(28), 56, "longitud strkey G…");
  assert.equal(h.subarray(32).toString("utf8"), g);
});

test("escalado 6 ↔ 7 decimales", () => {
  assert.equal(toUnits("1.5", 6), 1_500_000n);
  assert.equal(toUnits("1.5", 7), 15_000_000n);
  assert.equal(fromUnits(15_000_000n, 7), "1.5");
  assert.equal(fromUnits(20171n, 6), "0.020171");
});

test("maxFee desde bps", () => {
  assert.equal(maxFeeFor(2_000_000n, 0), 0n);
  assert.ok(maxFeeFor(2_000_000n, 1.3) >= 260n); // 1.3 bps de 2 USDC = 260 unidades
});

test("plan de versiones CCTP", () => {
  assert.deepEqual(planCctp("base", "arc"), { kind: "direct", version: 2 });
  assert.deepEqual(planCctp("sui", "ethereum"), { kind: "direct", version: 1 });
  assert.deepEqual(planCctp("solana", "sui"), { kind: "direct", version: 1 });
  assert.equal(planCctp("sui", "stellar").kind, "unsupported");
  assert.equal(planCctp("arc", "sui").kind, "unsupported");
  assert.equal(planCctp("stellar", "sui").kind, "unsupported");
  assert.deepEqual(planCctp("stellar", "solana"), { kind: "direct", version: 2 });
});
