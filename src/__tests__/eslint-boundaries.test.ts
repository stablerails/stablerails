/**
 * Regression guard: ESLint import/no-restricted-paths must FIRE on forbidden
 * cross-boundary imports (spec §2.1).
 *
 * Uses the ESLint Node API against the project's .eslintrc.cjs config.
 * Temporary probe files are written under the real src/<zone> directories
 * (which must exist for the resolver to find) and cleaned up in afterEach.
 *
 * Why real dirs: import/no-restricted-paths resolves `target` and `from`
 * relative to the config file location; the `from` directory must exist on
 * disk for the rule to resolve imports correctly.
 *
 * ALL probe files are prefixed `_btest_` and removed in afterEach.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ESLint } from "eslint";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Track files/dirs written per-test for cleanup.
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      // FILE-ONLY removal (non-recursive). NEVER recursively delete here:
      // probe files live inside real src/<zone> dirs (e.g. src/signer, src/chain),
      // and a recursive rm of one of those dirs would wipe real source.
      rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
});

/**
 * Write a probe file inside one of the real src/ zone directories.
 * Registers both the file and its parent directory for cleanup.
 */
function writeProbe(relPath: string, content: string): string {
  const abs = join(REPO_ROOT, relPath);
  const parentDir = join(abs, "..");
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(abs, content, "utf-8");
  // Register ONLY the probe file for cleanup — NEVER the parent dir
  // (it may be a real src/<zone> dir; recursive removal would delete real source).
  cleanupPaths.push(abs);
  return abs;
}

/**
 * Ensure a stub file exists in `from` dir so the resolver can find it.
 * Returns the stub path (registered for cleanup).
 */
function ensureStub(dir: string, filename: string): string {
  const abs = join(REPO_ROOT, dir, filename);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `export const _stub = true;\n`);
  // Register ONLY the stub file — NEVER the dir (it may be a real src/<zone>).
  cleanupPaths.push(abs);
  return abs;
}

async function lintAndGetBoundaryErrors(filePath: string): Promise<ESLint.LintMessage[]> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    useEslintrc: true,
    errorOnUnmatchedPattern: false,
  });
  const results = await eslint.lintFiles([filePath]);
  return (results[0]?.messages ?? []).filter(
    (m) => m.ruleId === "import/no-restricted-paths",
  );
}

describe("ESLint boundary enforcement (regression guard)", () => {
  // ── server → signer must be BLOCKED ──────────────────────────────────────

  it("reports error: src/server imports from src/signer (static import)", async () => {
    // Stub must exist in src/signer so the resolver can find the from-dir.
    ensureStub("src/signer", "_btest_stub.js");
    const fp = writeProbe(
      "src/server/_btest_handler.ts",
      `import { signTx } from "../signer/_btest_stub.js";\nexport {};\n`,
    );

    const msgs = await lintAndGetBoundaryErrors(fp);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.message).toMatch(/signer/i);
    expect(msgs[0]!.severity).toBe(2); // "error"
  });

  it("reports error: src/server imports from src/signer (index barrel)", async () => {
    ensureStub("src/signer", "_btest_index.ts");
    const fp = writeProbe(
      "src/server/_btest_handler2.ts",
      `import type { Signer } from "../signer/_btest_index.js";\nexport {};\n`,
    );

    const msgs = await lintAndGetBoundaryErrors(fp);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.message).toMatch(/signer/i);
  });

  // ── core → chain must be BLOCKED ─────────────────────────────────────────

  it("reports error: src/core imports from src/chain (static import)", async () => {
    ensureStub("src/chain", "_btest_scanner.js");
    const fp = writeProbe(
      "src/core/_btest_domain.ts",
      `import { scan } from "../chain/_btest_scanner.js";\nexport {};\n`,
    );

    const msgs = await lintAndGetBoundaryErrors(fp);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.message).toMatch(/chain/i);
    expect(msgs[0]!.severity).toBe(2); // "error"
  });

  // ── server → cli must be BLOCKED ─────────────────────────────────────────

  it("reports error: src/server imports from src/cli", async () => {
    ensureStub("src/cli", "_btest_index.js");
    const fp = writeProbe(
      "src/server/_btest_routes.ts",
      `import { run } from "../cli/_btest_index.js";\nexport {};\n`,
    );

    const msgs = await lintAndGetBoundaryErrors(fp);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.message).toMatch(/cli/i);
  });

  // ── workers → signer must be BLOCKED ─────────────────────────────────────

  it("reports error: src/workers imports from src/signer", async () => {
    ensureStub("src/signer", "_btest_hd.js");
    const fp = writeProbe(
      "src/workers/_btest_sweep.ts",
      `import { derive } from "../signer/_btest_hd.js";\nexport {};\n`,
    );

    const msgs = await lintAndGetBoundaryErrors(fp);

    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.message).toMatch(/signer/i);
  });
});
