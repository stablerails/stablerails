/**
 * CLI commands for events.
 *
 * event create  — Derive account xpub from seed (passphrase-gated) and register via API.
 * event list    — List all events.
 * event show    — Show a single event by id.
 */

import type { Command } from "commander";
import { promptPassphrase } from "../prompt.js";
import { encryptedSeedFromEnv } from "../seedStore.js";
import { decryptSeed } from "../../signer/seed.js";
import { deriveAccountXpub } from "../../signer/provision.js";
import type { ApiClient } from "../apiClient.js";

export function registerEventCommands(parent: Command, getApi: () => ApiClient): void {
  const event = parent.command("event").description("Manage payment events");

  // event create
  event
    .command("create")
    .description(
      "Create an event (derives xpub from seed — requires passphrase)",
    )
    .requiredOption("--name <name>", "Event name")
    .requiredOption(
      "--main-wallet <address>",
      "Main wallet address to sweep funds into",
    )
    .option("--account <n>", "HD derivation account number", "0")
    .action(async (opts: {
      name: string;
      mainWallet: string;
      account: string;
    }) => {
      const account = parseInt(opts.account, 10);
      if (!Number.isInteger(account) || account < 0) {
        console.error("--account must be a non-negative integer");
        process.exit(1);
      }

      // Gate: decrypt seed with human-supplied passphrase.
      const encryptedSeed = encryptedSeedFromEnv();
      const passphrase = await promptPassphrase(
        "Enter seed passphrase to derive xpub: ",
      );

      let mnemonic: string;
      try {
        mnemonic = await decryptSeed(encryptedSeed, passphrase);
      } catch {
        console.error("Wrong passphrase — aborting.");
        process.exit(1);
      }

      const { xpub } = deriveAccountXpub(mnemonic, account);

      const result = await getApi().createEvent({
        name: opts.name,
        mainWalletAddress: opts.mainWallet,
        derivationAccount: account,
        xpubAccount: xpub,
      });

      console.log(JSON.stringify(result, null, 2));
    });

  // event list
  event
    .command("list")
    .description("List all events")
    .action(async () => {
      const result = await getApi().listEvents();
      console.log(JSON.stringify(result, null, 2));
    });

  // event show
  event
    .command("show <id>")
    .description("Show an event by id")
    .action(async (id: string) => {
      const result = await getApi().getEvent(id);
      console.log(JSON.stringify(result, null, 2));
    });
}
