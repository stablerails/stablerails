import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Argon2id (seed encryption, src/signer) is intentionally CPU-expensive
    // (~4-30s/call at m=19456,t=2 depending on CPU contention); short timeouts
    // are flaky under CI / parallel local load. Keep this generous so KDF tests
    // fail on assertions rather than scheduler noise.
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
