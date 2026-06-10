/**
 * Signer isolation verifier (spec §2.1, Charter rule 1).
 *
 * Statically asserts that NO file under src/server/** or src/workers/**
 * contains an import from src/signer/**.
 *
 * Scans TypeScript source for:
 *   - static import statements
 *   - dynamic import() expressions
 *   - require() calls (for safety, even though we're ES modules)
 *
 * Exit 0 = clean. Exit 1 = violation found (prints offending file + line).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = join(__dirname, "..", "src");

// Directories whose files must NEVER import from signer
const RESTRICTED_DIRS = ["server", "workers"];

// Matches the /signer segment followed by:
//   /  or  .  — then the rest of the path (sub-path or .js single file)
//   (nothing) — bare directory/barrel import (closing quote immediately follows)
// This covers all four violating forms:
//   from "../signer/seed.js"   — sub-path import
//   from "../signer"           — bare directory/barrel import
//   from "../signer.js"        — signer as a single file
//   import "../signer/x.js"    — bare side-effect import
const SIGNER_TAIL = `\\/signer(?:[\\/\\.][^'"]*)?['"]`;

// Patterns that indicate a signer import
const IMPORT_PATTERNS: RegExp[] = [
  // Static named/default/type import: import ... from "...signer..."
  new RegExp(`from\\s+['"][^'"]*${SIGNER_TAIL}`, "g"),
  // Bare side-effect static import: import "...signer..."
  new RegExp(`import\\s+['"][^'"]*${SIGNER_TAIL}`, "g"),
  // Dynamic import: import("...signer...")
  new RegExp(`import\\s*\\(\\s*['"][^'"]*${SIGNER_TAIL}\\s*\\)`, "g"),
  // require (defensive): require("...signer...")
  new RegExp(`require\\s*\\(\\s*['"][^'"]*${SIGNER_TAIL}\\s*\\)`, "g"),
];

export interface Violation {
  file: string;
  line: number;
  column: number;
  match: string;
}

/** Recursively list .ts files under a directory.
 *
 * Skips files whose basename starts with "_btest_" — a reserved prefix for
 * transient probe files written by eslint-boundaries.test.ts while it lints
 * live src/server/ and src/workers/ dirs. The ESLint import/no-restricted-paths
 * rule (in .eslintrc.cjs) is the authoritative boundary control for production
 * code; this script is a secondary static scan. "_btest_" is a test-only
 * convention; production files MUST NOT use that prefix.
 * Excluding them prevents spurious violations and non-deterministic test runs.
 */
function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory doesn't exist yet — no violations possible
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.startsWith("_btest_")
    ) {
      results.push(full);
    }
  }
  return results;
}

/** Scan a single file for signer imports. */
function scanFile(filePath: string): Violation[] {
  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = source.split("\n");
  const violations: Violation[] = [];

  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex for each file scan
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      // The patterns already encode the signer constraint — every match is a violation.

      // Calculate line/column from index
      const before = source.slice(0, m.index);
      const lineNum = before.split("\n").length;
      const lastNewline = before.lastIndexOf("\n");
      const column = m.index - lastNewline;

      violations.push({
        file: filePath,
        line: lineNum,
        column,
        match: m[0].trim(),
      });
    }
  }

  return violations;
}

export function verifySignerIsolation(srcRoot = SRC_ROOT): Violation[] {
  const allViolations: Violation[] = [];

  for (const dir of RESTRICTED_DIRS) {
    const fullDir = join(srcRoot, dir);
    const files = listTsFiles(fullDir);

    for (const file of files) {
      const fileViolations = scanFile(file);
      allViolations.push(...fileViolations);
    }
  }

  return allViolations;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

// Only run as script when invoked directly (not imported in tests)
const isMain =
  process.argv[1] != null &&
  (process.argv[1].endsWith("verify-signer-isolation.ts") ||
    process.argv[1].endsWith("verify-signer-isolation.js"));

if (isMain) {
  const violations = verifySignerIsolation();

  if (violations.length === 0) {
    process.stdout.write("✓ Signer isolation OK — no violations found.\n");
    process.exit(0);
  } else {
    process.stderr.write(`✗ Signer isolation VIOLATED (${violations.length} violation(s)):\n\n`);
    for (const v of violations) {
      const rel = relative(SRC_ROOT, v.file);
      process.stderr.write(`  ${rel}:${v.line}:${v.column}\n`);
      process.stderr.write(`    ${v.match}\n\n`);
    }
    process.stderr.write("Fix: remove all imports of src/signer from src/server and src/workers.\n");
    process.exit(1);
  }
}
