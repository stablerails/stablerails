/**
 * Tron USDT contract constants.
 *
 * CHARTER: Only one contract address is ever accepted per process.
 * Dust / zero-value / fake-contract transfers MUST be rejected by callers.
 *
 * Contract address is overridable via TRON_USDT_CONTRACT (Base58) to support
 * testnet operation (e.g. Nile testnet USDT contract).
 * DEFAULT: mainnet USDT (TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t).
 * If the env var is unset, empty, or not a valid Tron Base58 address, the
 * mainnet value is used — a wrong/empty env NEVER produces an invalid contract.
 */

import { base58ToHex, isValidBase58Address } from "./addressCodec.js";

const MAINNET_USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function resolveContractBase58(): string {
  const fromEnv = process.env["TRON_USDT_CONTRACT"];
  if (!fromEnv) {
    // Unset → safe mainnet default (expected for production deployments)
    return MAINNET_USDT_BASE58;
  }
  if (isValidBase58Address(fromEnv)) {
    return fromEnv;
  }
  // SET but invalid Base58 — warn loudly so a testnet typo is never silent.
  // Still falls back to the safe mainnet default rather than producing an invalid address.
  // eslint-disable-next-line no-console
  console.warn(
    `[usdt.ts] TRON_USDT_CONTRACT="${fromEnv}" is not a valid Tron Base58 address — ` +
      `falling back to mainnet USDT (${MAINNET_USDT_BASE58}). ` +
      "Fix the env var to use the intended testnet contract.",
  );
  return MAINNET_USDT_BASE58;
}

/** Tron USDT contract address (Base58). Mainnet unless TRON_USDT_CONTRACT overrides. */
export const TRON_USDT_CONTRACT_BASE58: string = resolveContractBase58();

/**
 * Tron USDT contract address (lowercase hex, 0x41-prefix).
 * Derived from TRON_USDT_CONTRACT_BASE58 — no hand-maintained duplication.
 */
export const TRON_USDT_CONTRACT_HEX: string = base58ToHex(TRON_USDT_CONTRACT_BASE58);

/** USDT decimals on Tron (6). */
export const USDT_DECIMALS_TRON = 6;

/**
 * TRC-20 Transfer event topic (Keccak-256 of "Transfer(address,address,uint256)").
 * Same as ERC-20 — Tron reuses the Ethereum ABI.
 */
export const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** ABI signature for Transfer event (for documentation / future ABI decoding). */
export const TRANSFER_EVENT_SIG = "Transfer(address,address,uint256)";

/**
 * Minimum accepted transfer value in micro-USDT (exclusive lower bound for
 * dust rejection).  The charter says "reject dust/zero-value".
 * Anything <= DUST_THRESHOLD_MICRO is rejected.
 * Current threshold: 0 (reject only zero).  Callers may apply a stricter limit.
 */
export const DUST_THRESHOLD_MICRO = 0n;
