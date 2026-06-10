# Operator Runbook: Sweeping Stablerailsments

This runbook explains how to cash out collected USDT from deposit addresses to a single destination wallet.

## Overview

1. The server accumulates USDT at per-invoice deposit addresses (HD wallet, one address per invoice)
2. `sweep prepare` asks the server to build unsigned transfer transactions
3. `sweep execute` signs them locally with your seed passphrase and broadcasts to Tron

**Security principle**: Private keys never leave your machine. The server returns unsigned transaction bytes; your local signer fills in the signature.

---

## Pre-requisites

- `STABLERAILS_ADMIN_KEY` set (admin bearer key for API requests)
  — **First-time setup**: run `stablerails operator init --email <email>` (requires `DATABASE_URL`),
    then log in at `/login` and mint your first admin key at `/api-keys`.
- `STABLERAILS_ENCRYPTED_SEED` set (encrypted seed blob JSON) — or `STABLERAILS_SEED_FILE` pointing to the blob file
  — **First-time setup**: run `stablerails seed init` to generate and encrypt your mnemonic.
- `STABLERAILS_MAIN_WALLET` set to your main wallet's Base58 address (`T...`, 34 chars)
  — **Required for `sweep execute` (SIGN-2)**: every sweep item's destination is hard-asserted against this local pin before signing. The entire sweep aborts if any item mismatches. If unset or not a valid `T...` address, `sweep execute` refuses to run.
  — Set it once in your shell profile: `export STABLERAILS_MAIN_WALLET=TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe`
- For live broadcast: `TRON_RPC_PRIMARY` set to a TronGrid node URL (absent = dry-run)
  — **Note (SIGN-3)**: when `TRON_RPC_PRIMARY` is set, `sweep execute` rebuilds the transfer locally and calls the node's `triggerSmartContract` endpoint before signing and broadcasting. When `TRON_RPC_PRIMARY` is absent, dry-run mode still uses mock signable transactions and does not broadcast.

---

## Energy Rental (Gas Cost Guidance)

Sweeping USDT (TRC-20) on Tron requires **energy**. Each transfer costs ~30,000 energy.

Without staked TRX, Tron charges approximately **~$1.30 per sweep transaction** (as of 2025) at default burn rates.

**Recommendation: rent energy per deposit address before sweeping.**

```bash
# Example: rent energy for 10 deposit addresses (~300,000 energy total)
# Using a Tron energy rental service (e.g. tronsave.io, feee.io)
# Delegate energy to each deposit address individually
# Rental cost: ~$0.20–0.50 per address per 24h (varies by market)
```

Energy rental is done externally — Stablerails does not manage energy delegation.

**Lazy/batched sweep guidance:**
- Accumulate multiple payments before sweeping (amortise energy cost)
- A single sweep of a 100-address batch costs ~$130 in energy at burn rates
- With rented energy: ~$2–5 total for the same batch
- Gas cost scales linearly: ~$1.30/transfer × number of addresses

---

## Step-by-Step

### 1. Prepare the sweep intent (read-only, no signing)

```bash
npx tsx src/cli/index.ts sweep prepare --event evt_...
```

This calls `POST /v1/sweeps/prepare` on the server and returns a **sweep intent ID** with all unsigned transactions.

Output:
```json
{
  "intent": {
    "id": "sw_abc123",
    "items": [
      { "address": "T...", "amountMicroStr": "100000000", "unsignedTx": { ... } }
    ]
  }
}
```

No signing happens here. No passphrase required.

### 2. Review the intent

```bash
npx tsx src/cli/index.ts sweep status sw_abc123
```

Verify the deposit addresses and amounts look correct before proceeding.

### 3. Execute the sweep (sign + broadcast)

Before executing, ensure `STABLERAILS_MAIN_WALLET` is set (SIGN-2 destination pin):

```bash
export STABLERAILS_MAIN_WALLET=T...   # your main wallet Base58 address
```

```bash
# Dry-run — sign locally, do NOT broadcast (TRON_RPC_PRIMARY unset)
npx tsx src/cli/index.ts sweep execute --intent sw_abc123
# You will be shown the destination address and total, then prompted:
#   Confirm destination T... and proceed? [y/N]:
# Then:
#   Enter seed passphrase to sign and broadcast (hidden):

# Live broadcast — set TRON_RPC_PRIMARY to enable
TRON_RPC_PRIMARY=https://api.trongrid.io \
TRON_RPC_PRIMARY_API_KEY=your-primary-provider-key \
npx tsx src/cli/index.ts sweep execute --intent sw_abc123

# Optional fallback node credentials
export TRON_RPC_SECONDARY=https://api.trongrid.io
export TRON_RPC_SECONDARY_API_KEY=your-secondary-provider-key
# Same confirmation flow, then live broadcast.
```

> **No `--dry-run` flag exists.** Dry-run is implicit: when `TRON_RPC_PRIMARY` is unset the command signs locally and prints the signed txIDs, but does NOT broadcast. A fabricated txHash is never emitted. Set `TRON_RPC_PRIMARY` to go live.
>
> **Env var disambiguation:** `TRON_RPC_PRIMARY` (no `_URL` suffix) gates the CLI `sweep execute` broadcast. `TRON_RPC_PRIMARY_URL` (with `_URL` suffix) is used by the block-watcher worker. Setting only `TRON_RPC_PRIMARY_URL` triggers a loud warning and keeps `sweep execute` in dry-run mode — nothing is broadcast.

**Destination pin (SIGN-2)**: Before building any signable transaction, `sweep execute`:
1. Reads `STABLERAILS_MAIN_WALLET` from the local environment (not the server).
2. Asserts every item's `toAddressBase58` equals this pin. If any item mismatches the **entire sweep aborts** (nothing is signed).
3. Displays the verified destination, item list, and total USDT to the operator.
4. Requires explicit `y` confirmation at the TTY before the passphrase prompt.

This check is independent of the server — a server/DB/admin-key compromise that mutates `mainWalletAddress` cannot redirect funds silently.

**TTY gate**: The passphrase prompt requires an interactive terminal (`process.stdin.isTTY === true`).
- Piped stdin, CI runners, MCP tool calls, and automated agents **cannot** bypass this gate
- The command throws immediately if stdin is not a real TTY

### 4. Verify

After a live broadcast, check transaction status on [TronScan](https://tronscan.org/).

---

## Sign-Only (Offline) Mode

If you want to sign without broadcast (air-gapped signing), simply don't set `TRON_RPC_PRIMARY`:

```bash
# Sign offline — outputs signed transactions, no broadcast
npx tsx src/cli/index.ts sweep execute --intent sw_abc123
```

The signed payload can be broadcast later via any Tron node.

---

## Kill-Switch

If you need to halt new payments while sweeping:

```bash
# Set env var before starting the server/worker
STABLERAILS_PAUSE_INVOICES=1   # Stop new invoice creation
STABLERAILS_PAUSE_WATCHER=1    # Pause block watcher
STABLERAILS_PAUSE_WEBHOOKS=1   # Pause webhook delivery
```

These can be toggled at runtime via `pauseArea(area)` / `resumeArea(area)` in `src/server/killswitch.ts`.

---

## Live Broadcast Notes

### SIGN-3: live broadcast uses triggerSmartContract

When `TRON_RPC_PRIMARY` is set, `sweep execute` does not trust server-provided `unsignedTx.callData` for the live path. It rebuilds each transfer locally from the sweep item source address, pinned `STABLERAILS_MAIN_WALLET`, amount, and known USDT contract, then calls `triggerSmartContract` on the configured Tron full node.

The returned transaction is validated before signing: it must include `txID`, `raw_data_hex`, a non-empty `raw_data.contract`, matching owner/contract/data/call value intent, unchanged `fee_limit`, and `txID = sha256(raw_data_hex)`.

As a final guard, live broadcast still refuses any mock/unverified transaction with an empty `raw_data.contract`.

Dry-run mode (no `TRON_RPC_PRIMARY`) intentionally still uses mock signable transactions. It signs locally for operator verification, but does not broadcast and does not post a broadcast result.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `stdin is not a TTY` | Running in a non-interactive shell | Use a real terminal |
| `wrong passphrase` | Incorrect passphrase for the seed blob | Check `STABLERAILS_ENCRYPTED_SEED` (or `STABLERAILS_SEED_FILE`) |
| `TRON_RPC_PRIMARY not set — dry-run only` | Expected if doing offline signing | Set env var for live broadcast |
| `STABLERAILS_MAIN_WALLET is not set` | Local destination pin missing | `export STABLERAILS_MAIN_WALLET=T...` (your main wallet address) |
| `STABLERAILS_MAIN_WALLET is not a valid Tron address` | Env var contains an invalid address | Ensure value starts with `T` and is 34 Base58 characters |
| `Sweep destination mismatch — ABORTING` | Server returned an item with a different destination than the local pin | Verify server/DB integrity and `STABLERAILS_MAIN_WALLET` config |
| `refusing to broadcast a mock/unverified transaction` | `TRON_RPC_PRIMARY` is set, but the live path received a transaction with empty `raw_data.contract` | Verify `TRON_RPC_PRIMARY` points to a real Tron full node and inspect the `triggerSmartContract` response |
| Broadcast fails for one address | Energy insufficient | Rent energy for that deposit address and retry |

---

## Notes

- Sweep is idempotent per intent: re-running `sweep execute` with the same intent ID will not double-spend
- The server marks sweep intents as `executed` after a successful broadcast — check with `sweep status`
- Energy rental must be done externally; Stablerails does not manage TRX staking/delegation

<!-- updated-by-superflow:2026-06-06 -->
