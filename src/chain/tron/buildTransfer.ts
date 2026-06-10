/**
 * Build the UNSIGNED TRC-20 transfer payload for a sweep.
 *
 * KEYLESS / WATCH-ONLY: This module builds the PUBLIC transaction data only.
 * No private key, no signing. The signer (Sprint 7 src/signer/) will
 * take the output of this function and sign it offline.
 *
 * Lives in src/chain/tron/ so Sprint-7's server-side sweep-prepare
 * can import it WITHOUT touching src/signer.
 */

import { TRON_USDT_CONTRACT_HEX, TRON_USDT_CONTRACT_BASE58 } from "./usdt.js";
import { base58ToHex, normalizeToBase58 } from "./addressCodec.js";

// ── TRC-20 ABI constants ──────────────────────────────────────────────────────

/** Keccak-256 of "transfer(address,uint256)" — first 4 bytes. */
const TRANSFER_METHOD_ID = "a9059cbb";

// ── Input / output types ──────────────────────────────────────────────────────

export interface BuildTransferParams {
  /** Source address (Base58 or hex). Funds are deducted from here. */
  fromAddress: string;
  /** Destination address (Base58 or hex). */
  toAddress: string;
  /** Amount in micro-USDT (bigint, must be > 0). */
  amountMicro: bigint;
  /**
   * TRX fee limit in SUN (1 TRX = 1_000_000 SUN).
   * Default: 40_000_000 SUN = 40 TRX (standard USDT transfer fee limit).
   */
  feeLimitSun?: bigint;
  /**
   * Extra data to attach (hex string, no 0x prefix). Optional.
   * Used for sweep memo / reference in some integrations.
   */
  memo?: string;
}

export interface UnsignedTrc20Transfer {
  /** Hex-encoded contract address (0x41-prefix, no 0x). */
  contractAddressHex: string;
  /** Base58 contract address. */
  contractAddressBase58: string;
  /** Hex-encoded from address (0x41-prefix, no 0x). */
  fromAddressHex: string;
  /** Base58 from address. */
  fromAddressBase58: string;
  /** Hex-encoded to address (0x41-prefix, no 0x). */
  toAddressHex: string;
  /** Base58 to address. */
  toAddressBase58: string;
  /** Amount in micro-USDT. */
  amountMicro: bigint;
  /** ABI-encoded function call data (hex, no 0x). */
  callData: string;
  /** Fee limit in SUN. */
  feeLimitSun: bigint;
  /** Optional memo hex. */
  memo: string;
}

// ── Builder ───────────────────────────────────────────────────────────────────

const DEFAULT_FEE_LIMIT_SUN = 40_000_000n; // 40 TRX

/**
 * Build the unsigned TRC-20 transfer payload.
 *
 * The returned `UnsignedTrc20Transfer` is ready to be passed to a signer or
 * broadcast after signing. It does NOT touch any private key material.
 *
 * @throws RangeError  if amountMicro <= 0.
 * @throws Error       if addresses are invalid.
 */
export function buildTransfer(params: BuildTransferParams): UnsignedTrc20Transfer {
  const { fromAddress, toAddress, amountMicro, feeLimitSun, memo } = params;

  if (amountMicro <= 0n) {
    throw new RangeError(`buildTransfer: amountMicro must be > 0, got ${amountMicro}`);
  }

  // Normalize addresses to both forms
  const fromBase58 = normalizeToBase58(fromAddress);
  const toBase58 = normalizeToBase58(toAddress);
  const fromHex = base58ToHex(fromBase58);
  const toHex = base58ToHex(toBase58);

  // ABI encode: transfer(address to, uint256 value)
  // Tron uses the same encoding as Ethereum ABI:
  //   [4 bytes methodId][32 bytes address (0-padded)][32 bytes amount (0-padded)]
  //
  // Tron address in ABI is the last 20 bytes of the 21-byte address (drop the 0x41 prefix).
  const toAddressAbi = toHex.slice(2); // strip "41" prefix → 20 bytes (40 hex chars)
  const toAddressPadded = toAddressAbi.padStart(64, "0");
  const amountHex = amountMicro.toString(16).padStart(64, "0");

  const callData = `${TRANSFER_METHOD_ID}${toAddressPadded}${amountHex}`;

  return {
    contractAddressHex: TRON_USDT_CONTRACT_HEX,
    contractAddressBase58: TRON_USDT_CONTRACT_BASE58,
    fromAddressHex: fromHex,
    fromAddressBase58: fromBase58,
    toAddressHex: toHex,
    toAddressBase58: toBase58,
    amountMicro,
    callData,
    feeLimitSun: feeLimitSun ?? DEFAULT_FEE_LIMIT_SUN,
    memo: memo ?? "",
  };
}
