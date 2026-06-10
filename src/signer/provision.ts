import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
const TRON_COIN_TYPE = 195;
export interface AccountXpub { account: number; xpub: string; }
export interface InvoiceKey { account: number; index: number; privateKey: Uint8Array; publicKey: Uint8Array; }
export function deriveAccountXpub(mnemonic: string, account: number): AccountXpub {
  if (!Number.isInteger(account) || account < 0) throw new Error("account must be a non-negative integer, got " + account);
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const accountNode = root.derive("m/44'/" + TRON_COIN_TYPE + "'/" + account + "'");
  const xpub = accountNode.publicExtendedKey;
  if (HDKey.fromExtendedKey(xpub).privateKey !== null) throw new Error("SECURITY: derived xpub still contains a private key -- invariant violated");
  return { account, xpub };
}
export function deriveInvoiceKey(mnemonic: string, account: number, index: number): InvoiceKey {
  if (!Number.isInteger(account) || account < 0) throw new Error("account must be a non-negative integer, got " + account);
  if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer, got " + index);
  const invoiceNode = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive("m/44'/" + TRON_COIN_TYPE + "'/" + account + "'/0/" + index);
  const privateKey = invoiceNode.privateKey; const publicKey = invoiceNode.publicKey;
  if (privateKey === null || privateKey.length !== 32) throw new Error("Expected 32-byte private key, got " + (privateKey?.length ?? "null"));
  if (publicKey === null || publicKey.length !== 33) throw new Error("Expected 33-byte compressed public key, got " + (publicKey?.length ?? "null"));
  return { account, index, privateKey: new Uint8Array(privateKey), publicKey: new Uint8Array(publicKey) };
}
export function verifyXpubMatch(mnemonic: string, account: number, registeredXpub: string): boolean {
  return deriveAccountXpub(mnemonic, account).xpub === registeredXpub;
}
