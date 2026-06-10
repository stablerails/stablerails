/**
 * Tests for verify-signer-isolation.ts
 *
 * Positive cases: each violating import form is detected.
 * Negative case: clean tree passes.
 *
 * Uses in-memory temp fixtures written to OS temp dir so no probe files
 * land in src/ or scripts/. All files are removed after each test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { verifySignerIsolation } from "./verify-signer-isolation.js";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REAL_SRC_ROOT = join(__dirname, "..", "src");

// Temp dirs created per-test — cleaned up in afterEach
const tempDirs: string[] = [];

function makeTempSrc(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "signer-iso-"));
  tempDirs.push(base);

  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(base, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  return base;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── Clean tree ────────────────────────────────────────────────────────────────

describe("verify-signer-isolation — clean tree", () => {
  it("passes on the real (currently clean) source tree", () => {
    const violations = verifySignerIsolation(REAL_SRC_ROOT);
    expect(violations).toHaveLength(0);
  });
});

// ── Positive cases: each violating import form must be detected ───────────────

describe("verify-signer-isolation — positive cases (violations detected)", () => {
  it('detects: from "../signer/seed.js" (named sub-path import)', () => {
    const root = makeTempSrc({
      "server/handler.ts": `import { sign } from "../signer/seed.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.match).toMatch(/signer/);
  });

  it('detects: from "../signer" (bare directory/barrel import)', () => {
    const root = makeTempSrc({
      "server/handler.ts": `import type { Signer } from "../signer";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.match).toMatch(/signer/);
  });

  it('detects: from "../signer.js" (signer as single file)', () => {
    const root = makeTempSrc({
      "server/handler.ts": `import { signer } from "../signer.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.match).toMatch(/signer/);
  });

  it('detects: import "../signer/x.js" (bare side-effect import)', () => {
    const root = makeTempSrc({
      "server/handler.ts": `import "../signer/seed.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.match).toMatch(/signer/);
  });

  it('detects violation in src/workers (not just src/server)', () => {
    const root = makeTempSrc({
      "workers/sweep.ts": `import { derivePath } from "../signer/hd.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("reports correct line number for violation", () => {
    const root = makeTempSrc({
      "server/handler.ts": [
        "// line 1",
        "// line 2",
        `import { sign } from "../signer/seed.js";`,
        "export {};",
      ].join("\n"),
    });
    const violations = verifySignerIsolation(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.line).toBe(3);
  });
});

// ── _btest_ probe files must be ignored by the real-tree scan ────────────────

describe("verify-signer-isolation — _btest_ probes ignored (determinism fix)", () => {
  it("does NOT flag a _btest_-prefixed file with a signer import in src/server", () => {
    // The eslint-boundaries test writes _btest_*.ts probes into real src dirs
    // while they are being linted. If verifySignerIsolation scans those probes it
    // produces a false violation, making the suite non-deterministic.
    // Fix: skip files whose basename starts with "_btest_".
    const root = makeTempSrc({
      "server/_btest_probe.ts": `import { signTx } from "../signer/_btest_stub.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag a _btest_-prefixed file in src/workers", () => {
    const root = makeTempSrc({
      "workers/_btest_sweep.ts": `import { derive } from "../signer/_btest_hd.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    expect(violations).toHaveLength(0);
  });

  it("still detects a real (non-_btest_) violation in the same dir", () => {
    // Ensure the exclusion is filename-prefix-specific, not directory-wide.
    const root = makeTempSrc({
      "server/_btest_probe.ts": `import { signTx } from "../signer/stub.js";\nexport {};\n`,
      "server/real_handler.ts": `import { derive } from "../signer/seed.js";\nexport {};\n`,
    });
    const violations = verifySignerIsolation(root);
    // Only the real_handler.ts violation should be reported
    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toMatch(/real_handler\.ts$/);
  });
});
