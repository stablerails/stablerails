/**
 * Prometheus scrape endpoint.
 *
 * GET /metrics — text/plain; version=0.0.4
 *
 * Gate: bearer token from METRICS_TOKEN env var.
 *   - METRICS_TOKEN unset  → 404 (feature disabled — no hint that the endpoint exists)
 *   - no / wrong token     → 401
 *   - correct token        → 200 with Prometheus text
 *
 * Metrics exposed (read-only, no money-logic):
 *   stablerails_invoices_total{status="..."}  — invoice count per status
 *   stablerails_usdt_received_total           — total USDT received across all invoices
 *
 * Data source: InvoiceRepository.summary() — same read-only aggregate used by
 * the operator dashboard. No imports from core/payments, lifecycle, or signer.
 */

import { timingSafeEqual } from "crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { InvoiceRepository, InvoiceStatus } from "../../core/ports.js";

// All known statuses — emitted even when count is 0 so Prometheus never sees
// a disappearing label set (avoids gaps in dashboards).
const ALL_STATUSES: InvoiceStatus[] = [
  "pending",
  "payment_detected",
  "paid",
  "underpaid",
  "overpaid",
  "expired",
  "canceled",
  "overdue",
];

export interface MetricsRouteOpts {
  invoiceRepo: InvoiceRepository;
}

/**
 * Constant-time string comparison.
 * timingSafeEqual requires equal-length buffers; we check length first (acceptable
 * for a bearer-token gate — length leakage does not reveal token content).
 */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Extract the Bearer token value from an Authorization header string.
 * Returns empty string when the header is absent or has a different scheme.
 */
function extractBearer(authHeader: string | undefined): string {
  if (!authHeader) return "";
  const space = authHeader.indexOf(" ");
  if (space === -1) return "";
  const scheme = authHeader.slice(0, space).toLowerCase();
  if (scheme !== "bearer") return "";
  return authHeader.slice(space + 1);
}

export async function registerMetricsRoutes(
  app: FastifyInstance,
  opts: MetricsRouteOpts,
): Promise<void> {
  const { invoiceRepo } = opts;

  app.get("/metrics", async (req: FastifyRequest, reply: FastifyReply) => {
    const metricsToken = process.env["METRICS_TOKEN"];

    // Feature disabled when env var is absent or empty.
    if (!metricsToken) {
      return reply.code(404).send();
    }

    // Bearer token gate — constant-time compare.
    const provided = extractBearer(req.headers["authorization"]);
    if (!tokenEquals(provided, metricsToken)) {
      return reply.code(401).send();
    }

    // Read-only summary — no money-logic, no state mutations.
    const summary = await invoiceRepo.summary();

    // ── Build Prometheus text-format body ─────────────────────────────────────
    const lines: string[] = [];

    // Invoice count by status
    lines.push("# HELP stablerails_invoices_total Total invoice count by status.");
    lines.push("# TYPE stablerails_invoices_total gauge");
    for (const status of ALL_STATUSES) {
      const count = summary.byStatus[status] ?? 0;
      lines.push(`stablerails_invoices_total{status="${status}"} ${count}`);
    }

    // Total USDT received (decimal string with 6 places — valid Prometheus float)
    lines.push("# HELP stablerails_usdt_received_total Total USDT received across all invoices.");
    lines.push("# TYPE stablerails_usdt_received_total gauge");
    lines.push(`stablerails_usdt_received_total ${summary.totalAmountReceived}`);

    lines.push(""); // trailing newline required by Prometheus text format spec

    return reply
      .code(200)
      .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(lines.join("\n"));
  });
}
