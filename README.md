# usdc-crosschain-lab

Laboratorio de transferencias **USDC cross-chain** con **Circle CCTP** (V2, V1 legacy para Sui y Forwarding Service) entre
**Ethereum Sepolia, Avalanche Fuji, Arbitrum Sepolia, Base Sepolia, Arc Testnet, Solana Devnet, Sui Testnet y Stellar Testnet**.

📖 Documento técnico completo (funcionamiento por red, 56 combinaciones, flujos paso a paso): [`docs/CROSSCHAIN-USDC.md`](docs/CROSSCHAIN-USDC.md)

## Requisitos

- **Node ≥ 22** (requisito de `@mysten/sui` v2; `.nvmrc` fija 24)
- `npm install`

## Configuración

```bash
bash scripts/cli-wallets.sh # genera wallets con las CLIs oficiales (cast, solana-keygen, sui, stellar) → .env + .wallets/
bash scripts/cli-wallets.sh --faucet   # sólo faucets por CLI (solana airdrop, sui faucet, friendbot + trustline USDC)
npm run wallets:new         # alternativa sin CLIs (genera con los SDKs las que falten)
npm run faucet              # SOL airdrop, SUI faucet, Friendbot + trustline USDC en Stellar, links de faucets EVM/USDC
npm run balances            # USDC + gas en las 8 redes
```

## Comandos

| Comando | Qué hace | ¿Necesita keys? |
|---|---|---|
| `npm run verify` | Verifica on-chain todos los contratos/programas/paquetes de las 8 redes + Iris | No |
| `npm run matrix` | Matriz CCTP de los 56 pares (V2 / V1 / 2 saltos) | No |
| `npm run matrix -- --quote` | + fees reales de Iris: Fast/Standard (bps) y Forwarding Service (USDC) | No |
| `npm run balances -- --evm 0x…,0x… --solana … --sui … --stellar G…` | Saldos de cualquier dirección pública | No |
| `npm test` | Tests offline (layout del mensaje real, encodings, decimales, planificación) | No |
| `npm run transfer -- --from base --to solana --amount 0.1 [--fast]` | Transferencia CCTP (mint manual en destino) | Sí |
| `npm run transfer -- --from avalanche --to arc --amount 1 --forward` | CCTP + Circle Forwarding Service (Circle hace el mint, sin gas en destino) | Sí |
| `npm run transfer -- --from sui --to arc --amount 1 --via base` | 2 saltos (Sui sólo V1 → Arc sólo V2) | Sí |
| `npm run matrix -- --run --amount 0.05 [--fast] [--forward] [--hop avalanche] [--only avalanche,base,solana]` | Ejecuta **los 56 pares** (los 4 sin ruta directa en 2 saltos) con fondos suficientes | Sí |

Resultados: `results/transfers.jsonl` (una línea por transferencia: txs, tiempos, fees, saldos antes/después) y `results/quotes.json`.

## Estructura

```
src/
  config/chains.ts      dominios CCTP, contratos V1/V2, USDC, RPCs (todo verificado on-chain)
  lib/encoding.ts       bytes32 por red (EVM pad, ATA Solana, address Sui, CctpForwarder Stellar + hookData), decimales 6/7
  lib/iris.ts           API de atestación de Circle (mensajes, fees bps, forwarding)
  cctp/evm.ts           depositForBurn[WithHook] V2 / depositForBurn V1, receiveMessage (viem)
  cctp/solana.ts        deposit_for_burn / receive_message V2 y V1 (Anchor + IDLs oficiales)
  cctp/sui.ts           deposit_for_burn y PTB hot-potato de 5 llamadas (V1, gRPC)
  cctp/stellar.ts       approve + deposit_for_burn, CctpForwarder.mint_and_forward (Soroban)
  cctp/route.ts         orquestador: elige V1/V2, fees, burn → atestación → mint, forwarding
  scripts/              verify, matrix, transfer, balances, faucet, new-wallets
  test/                 tests offline
  idl/                  IDLs Anchor de Circle (V2 y V1 "031")
```

## Seguridad

- `.env` está en `.gitignore` y se crea con permisos `600`. Ningún script imprime claves: sólo direcciones públicas.
- Sólo testnet. Para mainnet cambia `IRIS_API_URL`, RPCs y direcciones en `src/config/chains.ts`.
