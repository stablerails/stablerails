"use strict";

module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["import"],
  // ── Import resolver: TypeScript-aware (required for no-restricted-paths to fire) ──
  settings: {
    "import/resolver": {
      typescript: { project: "./tsconfig.json" },
      node: true,
    },
  },
  rules: {
    // ---------------------------------------------------------------
    // Module boundary enforcement (spec §2.1)
    // ---------------------------------------------------------------

    // src/core/** must NOT import from src/chain/**
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          // core → chain forbidden
          {
            target: "./src/core",
            from: "./src/chain",
            message: "src/core must not import from src/chain (inject via ports instead)",
          },
          // server → signer forbidden
          {
            target: "./src/server",
            from: "./src/signer",
            message: "SECURITY: src/server must NEVER import from src/signer",
          },
          // workers → signer forbidden
          {
            target: "./src/workers",
            from: "./src/signer",
            message: "SECURITY: src/workers must NEVER import from src/signer",
          },
          // server → cli forbidden (server/workers are network-facing; cli is operator-only)
          {
            target: "./src/server",
            from: "./src/cli",
            message: "src/server must not import from src/cli",
          },
          {
            target: "./src/workers",
            from: "./src/cli",
            message: "src/workers must not import from src/cli",
          },
          // server → mcp forbidden
          {
            target: "./src/server",
            from: "./src/mcp",
            message: "src/server must not import from src/mcp",
          },
          {
            target: "./src/workers",
            from: "./src/mcp",
            message: "src/workers must not import from src/mcp",
          },
          // NOTE (spec §2.1): src/cli and src/mcp MAY import from src/chain — this is intentional
          // and explicitly allowed. No zone entry here means the import is permitted.
        ],
      },
    ],

    // Basic quality rules
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "import/no-duplicates": "error",
  },
  overrides: [
    {
      // Allow console in CLI and scripts
      files: ["src/cli/**/*.ts", "src/mcp/**/*.ts", "scripts/**/*.ts"],
      rules: {
        "no-console": "off",
      },
    },
    {
      // Relax for config/test files
      files: ["*.config.*", "*.test.ts", "vitest.config.ts"],
      rules: {
        "import/no-restricted-paths": "off",
      },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.cjs", "*.mjs"],
};
