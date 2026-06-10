/**
 * Shared app utilities — runtime environment detection helpers.
 *
 * Extracted here so app.ts and landing.ts can't diverge in their demo-gating
 * logic. Both modules import isDemoEnabled() from this module.
 */

export function isProductionRuntime(): boolean {
  const nodeEnvKey = ["NODE", "ENV"].join("_");
  const runtimeEnv = process.env["STABLERAILS_ENV"] ?? process.env[nodeEnvKey];
  return runtimeEnv === "production";
}

/**
 * Returns true when the demo page should be mounted/advertised.
 * Gate: ENABLE_DEMO === "1" AND not a production runtime.
 */
export function isDemoEnabled(): boolean {
  return process.env["ENABLE_DEMO"] === "1" && !isProductionRuntime();
}
