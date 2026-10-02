#!/usr/bin/env bash
# Genera wallets de laboratorio (TESTNET) con las CLIs oficiales de cada red,
# las escribe en .env (y en .wallets/, ambos gitignored) y pide gas a los faucets por CLI.
# NUNCA imprime claves privadas ni frases semilla: sólo direcciones públicas.
#
#   bash scripts/cli-wallets.sh            # genera wallets nuevas (respalda el .env anterior)
#   bash scripts/cli-wallets.sh --faucet   # sólo pide faucets para las wallets actuales
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"

WDIR="$PWD/.wallets"
SUI_CFG="$WDIR/sui/client.yaml"
STELLAR_ID="usdc-lab"
USDC_ISSUER="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

setkv() { # echo VALOR | setkv KEY  → reemplaza/añade en .env leyendo el valor por stdin (nunca se imprime)
  python3 -c '
import sys, re, os
k, v = sys.argv[1], sys.stdin.read().strip()
if not v: sys.exit(f"valor vacío para {k}")
p = ".env"
s = open(p).read() if os.path.exists(p) else ""
lines = [l for l in s.splitlines() if not re.match(rf"^{re.escape(k)}=", l)]
lines.append(f"{k}={v}")
open(p, "w").write("\n".join(lines) + "\n")
os.chmod(p, 0o600)
' "$1"
}

generate() {
  mkdir -p "$WDIR/solana" "$WDIR/sui"
  chmod 700 "$WDIR"
  if [ -f .env ]; then
    BK=".env.bak-$(date +%Y%m%d-%H%M%S)"; cp -p .env "$BK"; chmod 600 "$BK"; echo "Respaldo del .env anterior: $BK"
    # elimina claves de wallets anteriores
    grep -vE '^(EVM_PRIVATE_KEY|SOLANA_PRIVATE_KEY|SOLANA_KEYPAIR_PATH|SUI_PRIVATE_KEY|STELLAR_SECRET_KEY)=|^# --- wallets' .env > .env.tmp || true
    mv .env.tmp .env
  fi
  echo "# --- wallets generadas con CLIs oficiales $(date -Iseconds) (sólo testnet) ---" >> .env

  # EVM (Foundry cast): una misma cuenta sirve en Ethereum, Avalanche, Arbitrum, Base y Arc
  cast wallet new --json | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d["data"] if isinstance(d,dict) else d; print(d[0]["private_key"])' | setkv EVM_PRIVATE_KEY

  # Solana (solana-keygen): keypair JSON en .wallets/solana
  rm -f "$WDIR/solana/devnet.json"
  solana-keygen new --no-bip39-passphrase --silent --force -o "$WDIR/solana/devnet.json" >/dev/null
  echo "$WDIR/solana/devnet.json" | setkv SOLANA_KEYPAIR_PATH
  solana config set --url devnet --keypair "$WDIR/solana/devnet.json" >/dev/null

  # Sui (sui client/keytool): config propia en .wallets/sui conectada a testnet
  rm -rf "$WDIR/sui"; mkdir -p "$WDIR/sui"
  cat > "$SUI_CFG" <<YAML
---
keystore:
  File: $WDIR/sui/sui.keystore
envs:
  - alias: testnet
    rpc: "https://fullnode.testnet.sui.io:443"
    ws: ~
    basic_auth: ~
active_env: testnet
active_address: ~
YAML
  echo "[]" > "$WDIR/sui/sui.keystore"
  sui client --client.config "$SUI_CFG" new-address ed25519 usdc-lab --json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])' > "$WDIR/sui/address"
  sui client --client.config "$SUI_CFG" switch --address usdc-lab >/dev/null 2>&1
  # El keystore de la CLI guarda base64(flag || privkey32); se exporta la privkey en hex (aceptada por src/lib/env.ts)
  python3 -c 'import json,sys,base64; k=base64.b64decode(json.load(open(sys.argv[1]))[0]); assert k[0]==0, "no es ed25519"; print(k[1:].hex())' "$WDIR/sui/sui.keystore" \
    | setkv SUI_PRIVATE_KEY

  # Stellar (stellar keys): identidad "usdc-lab" + fondeo con Friendbot (--fund)
  stellar keys rm "$STELLAR_ID" >/dev/null 2>&1 || true
  stellar keys generate "$STELLAR_ID" --network testnet --fund >/dev/null 2>&1
  stellar keys secret "$STELLAR_ID" | setkv STELLAR_SECRET_KEY
}

faucets() {
  local EVM_ADDR SOL_ADDR SUI_ADDR XLM_ADDR
  SOL_ADDR=$(solana-keygen pubkey "$WDIR/solana/devnet.json")
  SUI_ADDR=$(cat "$WDIR/sui/address")
  XLM_ADDR=$(stellar keys address "$STELLAR_ID")

  echo "── Faucets por CLI"
  echo -n "  Solana  (solana airdrop 1): "
  solana airdrop 1 "$SOL_ADDR" --url devnet 2>&1 | tail -1 || true
  echo -n "  Sui     (sui client faucet): "
  sui client --client.config "$SUI_CFG" faucet --address "$SUI_ADDR" 2>&1 | tail -1 || true
  echo -n "  Stellar (friendbot vía stellar keys fund): "
  stellar keys fund "$STELLAR_ID" --network testnet 2>&1 | tail -1 || echo "ok"
  echo -n "  Stellar (trustline USDC): "
  stellar tx new change-trust --source-account "$STELLAR_ID" --line "USDC:$USDC_ISSUER" --network testnet >/dev/null 2>&1 \
    && echo "creada" || echo "ya existía o falló (se crea también en el primer mint)"
}

[ "${1:-}" = "--faucet" ] || generate
faucets
