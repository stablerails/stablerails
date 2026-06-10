import { createHash } from "node:crypto";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58L: Int8Array = new Int8Array(256).fill(-1);
for (let i = 0; i < B58.length; i++) B58L[B58.charCodeAt(i)] = i;
function sha256(d: Uint8Array): Buffer { return createHash("sha256").update(d).digest(); }
function sha256d(d: Uint8Array): Buffer { return sha256(sha256(d)); }
function b58enc(data: Uint8Array): string {
  let lz = 0; while (lz < data.length && data[lz] === 0) lz++;
  let n = 0n; for (const b of data) n = n * 256n + BigInt(b);
  let r = ""; while (n > 0n) { const m = n % 58n; r = (B58[Number(m)] ?? "") + r; n = n / 58n; }
  return "1".repeat(lz) + r;
}
function b58dec(s: string): Uint8Array {
  let lz = 0; while (lz < s.length && s[lz] === "1") lz++;
  let n = 0n;
  for (let i = 0; i < s.length; i++) {
    const d = B58L[s.charCodeAt(i)];
    if (d === undefined || d < 0) throw new Error("Invalid Base58 character '" + s[i] + "' at position " + i);
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n = n / 256n; }
  const r = new Uint8Array(lz + bytes.length); r.set(bytes, lz); return r;
}
export function base58CheckEncode(payload: Uint8Array): string {
  const cs = sha256d(payload).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4); full.set(payload); full.set(cs, payload.length);
  return b58enc(full);
}
export function base58CheckDecode(encoded: string): Uint8Array {
  const full = b58dec(encoded);
  if (full.length < 4) throw new Error("Base58Check string too short");
  const payload = full.subarray(0, full.length - 4); const cs = full.subarray(full.length - 4);
  const exp = sha256d(payload).subarray(0, 4);
  let mm = 0; for (let i = 0; i < 4; i++) mm |= (cs[i] ?? 0) ^ (exp[i] ?? 0);
  if (mm !== 0) throw new Error("Base58Check checksum mismatch -- invalid address");
  return payload;
}
const TL = 21; const TP = 0x41;
export function hexToBase58(hex: string): string {
  const n = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (n.length !== TL * 2) throw new Error("Invalid Tron hex address length: expected " + (TL * 2) + " hex chars, got " + n.length);
  const r = Uint8Array.from(Buffer.from(n, "hex"));
  if (r[0] !== TP) throw new Error("Invalid Tron address prefix: expected 0x41, got 0x" + (r[0] ?? 0).toString(16).padStart(2, "0"));
  return base58CheckEncode(r);
}
export function base58ToHex(b58: string): string {
  const r = base58CheckDecode(b58);
  if (r.length !== TL) throw new Error("Invalid Tron address: expected " + TL + " bytes after decode, got " + r.length);
  if (r[0] !== TP) throw new Error("Invalid Tron address prefix: expected 0x41, got 0x" + (r[0] ?? 0).toString(16).padStart(2, "0"));
  return Buffer.from(r).toString("hex");
}
export function isValidBase58Address(a: string): boolean {
  if (!a.startsWith("T")) return false; try { base58ToHex(a); return true; } catch { return false; }
}
export function isValidHexAddress(a: string): boolean { try { hexToBase58(a); return true; } catch { return false; } }
export function normalizeToBase58(a: string): string {
  if (a.startsWith("T")) { base58ToHex(a); return a; } return hexToBase58(a);
}
