/**
 * Derives account 0 xpub from the well-known dev mnemonic.
 * FOR DEV USE ONLY — never use for real funds.
 */
import { deriveAccountXpub } from "../src/signer/provision.js";

// Well-known BIP39 test mnemonic (abandon x11 + about)
const DEV_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const { xpub } = deriveAccountXpub(DEV_MNEMONIC, 0);
process.stdout.write(xpub + "\n");
