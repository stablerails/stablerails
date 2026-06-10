/**
 * TDD tests for checkout state rendering (checkout-states feature).
 *
 * Verifies that renderCheckout produces the correct markup for:
 * - SUCCESS states: paid, overpaid → success panel visible, QR/address hidden
 * - TERMINAL states: expired, canceled, overdue → terminal panel visible, QR/address hidden
 * - PENDING state: normal UI visible, no success/terminal panel
 *
 * Pure unit tests — no HTTP, no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { renderCheckout } from "../checkout.js";
import type { InvoiceRow } from "../../core/ports.js";

/** Minimal valid InvoiceRow for testing. */
function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv_test_001",
    eventId: "evt_test_001",
    status: "pending",
    priceFiat: "100.00",
    fiatCurrency: "USD",
    amountUsdt: "100.000000",
    amountReceived: "0.000000",
    rateLockedAt: new Date("2025-01-01T00:00:00Z"),
    network: "TRON",
    depositAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
    derivationIndex: 0,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    metadata: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    paidAt: null,
    ...overrides,
  };
}

// ── SUCCESS state: paid ───────────────────────────────────────────────────────

describe("renderCheckout — paid status (success state)", () => {
  it("includes success panel markup with 'Оплачено' text", async () => {
    const html = await renderCheckout(makeInvoice({ status: "paid", amountReceived: "100.000000" }));
    expect(html).toContain("Оплачено");
  });

  it("success panel does NOT have the hidden class on initial paid render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "paid", amountReceived: "100.000000" }));
    // The success-panel element must be visible (not have class="success-panel hidden")
    // It must appear without the hidden class
    expect(html).toMatch(/class="success-panel(?![^"]*\bhidden\b)/);
  });

  it("QR section is hidden on initial paid render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "paid" }));
    expect(html).toMatch(/class="qr-section[^"]*\bhidden\b/);
  });

  it("address section is hidden on initial paid render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "paid" }));
    expect(html).toMatch(/class="address-section[^"]*\bhidden\b/);
  });

  it("terminal panel has hidden class on paid status", async () => {
    const html = await renderCheckout(makeInvoice({ status: "paid" }));
    expect(html).toMatch(/class="terminal-panel[^"]*\bhidden\b/);
  });
});

// ── SUCCESS state: overpaid ────────────────────────────────────────────────────

describe("renderCheckout — overpaid status (success state)", () => {
  it("includes success panel markup with 'Оплачено' text", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overpaid", amountReceived: "110.000000" }));
    expect(html).toContain("Оплачено");
  });

  it("success panel does NOT have the hidden class on initial overpaid render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overpaid", amountReceived: "110.000000" }));
    expect(html).toMatch(/class="success-panel(?![^"]*\bhidden\b)/);
  });

  it("QR section is hidden on initial overpaid render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overpaid" }));
    expect(html).toMatch(/class="qr-section[^"]*\bhidden\b/);
  });

  it("address section is hidden on initial overpaid render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overpaid" }));
    expect(html).toMatch(/class="address-section[^"]*\bhidden\b/);
  });

  it("shows the received amount in the success panel", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overpaid", amountReceived: "110.000000" }));
    expect(html).toContain("110.000000");
  });
});

// ── TERMINAL state: expired ───────────────────────────────────────────────────

describe("renderCheckout — expired status (terminal state)", () => {
  it("includes 'Срок оплаты истёк' text", async () => {
    const html = await renderCheckout(makeInvoice({ status: "expired" }));
    expect(html).toContain("Срок оплаты истёк");
  });

  it("terminal panel does NOT have the hidden class on initial expired render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "expired" }));
    expect(html).toMatch(/class="terminal-panel(?![^"]*\bhidden\b)/);
  });

  it("QR section is hidden on initial expired render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "expired" }));
    expect(html).toMatch(/class="qr-section[^"]*\bhidden\b/);
  });

  it("address section is hidden on initial expired render", async () => {
    const html = await renderCheckout(makeInvoice({ status: "expired" }));
    expect(html).toMatch(/class="address-section[^"]*\bhidden\b/);
  });

  it("success panel has hidden class on expired status", async () => {
    const html = await renderCheckout(makeInvoice({ status: "expired" }));
    expect(html).toMatch(/class="success-panel[^"]*\bhidden\b/);
  });
});

// ── TERMINAL state: canceled ──────────────────────────────────────────────────

describe("renderCheckout — canceled status (terminal state)", () => {
  it("includes 'Срок оплаты истёк' text", async () => {
    const html = await renderCheckout(makeInvoice({ status: "canceled" }));
    expect(html).toContain("Срок оплаты истёк");
  });

  it("terminal panel does NOT have the hidden class on canceled", async () => {
    const html = await renderCheckout(makeInvoice({ status: "canceled" }));
    expect(html).toMatch(/class="terminal-panel(?![^"]*\bhidden\b)/);
  });

  it("QR section is hidden on canceled", async () => {
    const html = await renderCheckout(makeInvoice({ status: "canceled" }));
    expect(html).toMatch(/class="qr-section[^"]*\bhidden\b/);
  });
});

// ── TERMINAL state: overdue ───────────────────────────────────────────────────

describe("renderCheckout — overdue status (terminal state)", () => {
  // overdue means late funds WERE received (merchant got money) — do NOT reuse
  // the "invoice invalid / expired" copy from expired/canceled.
  it("shows late-funds acknowledgment title for overdue", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overdue" }));
    expect(html).toContain("Платёж получен с опозданием");
  });

  it("does NOT show expired wording for overdue (misleading to a customer who paid)", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overdue" }));
    expect(html).not.toContain("счёт недействителен");
  });

  it("does NOT show 'Срок оплаты истёк' title for overdue", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overdue" }));
    // This title belongs to expired/canceled, not to a state where funds arrived.
    expect(html).not.toContain("Срок оплаты истёк");
  });

  it("terminal panel does NOT have the hidden class on overdue", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overdue" }));
    expect(html).toMatch(/class="terminal-panel(?![^"]*\bhidden\b)/);
  });

  it("QR section is hidden on overdue", async () => {
    const html = await renderCheckout(makeInvoice({ status: "overdue" }));
    expect(html).toMatch(/class="qr-section[^"]*\bhidden\b/);
  });
});

// ── Polling loop terminal-status coverage ─────────────────────────────────────

describe("renderCheckout — client polling loop terminal-status coverage", () => {
  // underpaid is in TERMINAL_STATUSES (lifecycle.ts) — polling must stop on it.
  // Before this fix the terminal branch was missing underpaid, so the client
  // would poll every 5 s indefinitely while showing the full pending QR UI.
  it("polling terminal branch includes underpaid so polling halts on that status", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    // The embedded JS must reference "underpaid" in the terminal-check branch.
    expect(html).toContain('data.status === "underpaid"');
  });
});

// ── PENDING state: normal UI ──────────────────────────────────────────────────

describe("renderCheckout — pending status (normal pending UI)", () => {
  it("QR section is visible (no hidden class) on pending", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    // qr-section must not have hidden class
    expect(html).not.toMatch(/class="qr-section[^"]*\bhidden\b/);
  });

  it("address section is visible (no hidden class) on pending", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    expect(html).not.toMatch(/class="address-section[^"]*\bhidden\b/);
  });

  it("success panel has hidden class on pending", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    expect(html).toMatch(/class="success-panel[^"]*\bhidden\b/);
  });

  it("terminal panel has hidden class on pending", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    expect(html).toMatch(/class="terminal-panel[^"]*\bhidden\b/);
  });

  it("includes the status-section countdown UI on pending", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    expect(html).toContain("countdown-val");
  });
});

// ── CSP: no inline style= attributes ─────────────────────────────────────────

describe("renderCheckout — CSP compliance", () => {
  it("paid invoice HTML contains no inline style= attributes", async () => {
    const html = await renderCheckout(makeInvoice({ status: "paid" }));
    // style= is forbidden as an HTML attribute; JS element.style.* is fine but
    // should not appear as HTML. The nonce'd <style> block is allowed.
    // Check that no HTML tag contains a style="..." attribute.
    // [^>\n]+ prevents matching across newlines into JS code comments/strings.
    expect(html).not.toMatch(/<[^>\n]+\sstyle=/);
  });

  it("expired invoice HTML contains no inline style= attributes", async () => {
    const html = await renderCheckout(makeInvoice({ status: "expired" }));
    expect(html).not.toMatch(/<[^>\n]+\sstyle=/);
  });

  it("pending invoice HTML contains no inline style= attributes", async () => {
    const html = await renderCheckout(makeInvoice({ status: "pending" }));
    expect(html).not.toMatch(/<[^>\n]+\sstyle=/);
  });
});
