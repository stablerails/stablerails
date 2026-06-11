/**
 * Hosted v1 merchant self-serve signup routes.
 *
 * All routes are gated behind STABLERAILS_HOSTED_SIGNUP=1.
 * When the flag is unset, every route is not registered (caller checks flag
 * in app.ts before calling this function).
 *
 * Routes:
 *   GET  /signup           — HTML signup form (no auth)
 *   POST /signup           — Create merchant account (rate-limited, argon2)
 *   GET  /m/login          — HTML merchant login form (no auth)
 *   POST /m/login          — Merchant login (rate-limited, argon2)
 *   GET  /signup/store     — Onboarding wizard (merchant session gate)
 *   POST /signup/store     — Validate + create event + mint 2 keys (merchant session gate)
 *   GET  /m/dashboard      — Merchant invoice dashboard (merchant session gate)
 *
 * Security:
 *   - AUTH-1 pattern: rate limit BEFORE any argon2 or DB work on signup/login.
 *   - AUTH-5 pattern: ALL three signup outcomes (success, pre-checked duplicate,
 *     P2002 race duplicate) return a byte-identical body so email existence is
 *     never leaked — even by content, not just timing.
 *   - Merchant session cookie (MERCHANT_SESSION_COOKIE_NAME) is SEPARATE from
 *     the operator session cookie — cross-session usage is impossible.
 *   - Wizard validates Base58Check (isValidBase58Address) to reject charset-valid
 *     typos that pass a simple starts-with-T check.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import argon2 from "argon2";
import type { MerchantRepository } from "../merchants.js";
import {
  InMemoryMerchantSessionStore,
  MERCHANT_SESSION_COOKIE_NAME,
  generateRawKey,
  hashApiKey,
  extractPrefix,
} from "../auth.js";
import type { ApiKeyRepository } from "../auth.js";
import type { EventRepository, AddressValidator, InvoiceRepository } from "../../core/ports.js";
import { createEvent, EventValidationError } from "../../core/events.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { isValidBase58Address } from "../../chain/tron/addressCodec.js";

// ── Timing-equalization decoy (AUTH-5) ────────────────────────────────────────
// Precomputed argon2id hash of a throwaway password. When email is unknown or
// duplicate, we run argon2.verify against this so response time matches the
// known-email path.
const DECOY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$Tkz3H8ZeEJxmBPL0iRsHxg$5tPIpP8hEeba+q5NRdRgFXiF8IW8GEpvwK9EhRB+EHc";

// ── Neutral signup response (AUTH-5 + content equalization) ──────────────────
// ALL three signup code paths — real success, pre-checked duplicate, and P2002
// concurrent-duplicate — return this exact same payload so neither timing nor
// body content leaks whether a given email address already has an account.
const SIGNUP_NEUTRAL_BODY = { data: { message: "Account ready. Sign in to continue." } };

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Dark terminal aesthetic — matches existing site palette (terms.ts / landing).
const SHARED_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      background: #06090c; color: #e2e8f0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
      border-radius: 16px; padding: 2rem; width: 100%; max-width: 400px; }
    h1 { font-size: 1.375rem; font-weight: 800; color: #f1f5f9; margin-bottom: 1.5rem;
      letter-spacing: -.02em; }
    label { display: block; font-size: .75rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .08em; margin-bottom: .35rem; }
    input { width: 100%; padding: .6rem .8rem; background: #0f172a; border: 1px solid #334155;
      border-radius: .5rem; color: #f1f5f9; font-size: .95rem; margin-bottom: 1.1rem; }
    input:focus { outline: none; border-color: #26A17B; }
    button[type=submit] { width: 100%; padding: .7rem; background: #26A17B; color: #fff;
      border: none; border-radius: .5rem; font-size: .95rem; font-weight: 700; cursor: pointer; }
    button[type=submit]:hover { background: #1e8a65; }
    .hint { margin-top: 1rem; font-size: .8rem; color: #475569; text-align: center; }
    .hint a { color: #26A17B; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .error { background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3);
      border-radius: .5rem; padding: .75rem; margin-bottom: 1rem;
      color: #fca5a5; font-size: .875rem; }
    .usdt-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
      background: #26A17B; margin-right: .4rem; box-shadow: 0 0 8px rgba(38,161,123,.5); }
`;

function signupPage(error?: string, styleNonce?: string): string {
  const sa = styleNonce ? ` nonce="${styleNonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create account — Stablerails</title>
  <style${sa}>${SHARED_CSS}</style>
</head>
<body>
  <div class="card">
    <h1><span class="usdt-dot"></span>Create account</h1>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <form method="POST" action="/signup">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" />
      <label for="password">Password (min. 10 characters)</label>
      <input type="password" id="password" name="password" required autocomplete="new-password" />
      <button type="submit">Create account</button>
    </form>
    <p class="hint">Already have an account? <a href="/m/login">Sign in</a></p>
  </div>
</body>
</html>`;
}

function merchantLoginPage(error?: string, styleNonce?: string): string {
  const sa = styleNonce ? ` nonce="${styleNonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — Stablerails</title>
  <style${sa}>${SHARED_CSS}</style>
</head>
<body>
  <div class="card">
    <h1><span class="usdt-dot"></span>Sign in</h1>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <form method="POST" action="/m/login">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
    <p class="hint">No account yet? <a href="/signup">Create one</a></p>
  </div>
</body>
</html>`;
}

function wizardPage(styleNonce?: string): string {
  const sa = styleNonce ? ` nonce="${styleNonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Set up your store — Stablerails</title>
  <style${sa}>${SHARED_CSS}
    .card { max-width: 480px; }
    .step-label { font-size: .67rem; font-weight: 700; color: #26A17B;
      text-transform: uppercase; letter-spacing: .1em; margin-bottom: .75rem; }
    .field-hint { font-size: .73rem; color: #475569; margin-top: -.8rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <p class="step-label">Store setup</p>
    <h1>Your store details</h1>
    <form method="POST" action="/signup/store">
      <label for="storeName">Store name</label>
      <input type="text" id="storeName" name="storeName" required placeholder="My Store" />
      <label for="mainWalletAddress">Sweep-to address (Tron Base58)</label>
      <input type="text" id="mainWalletAddress" name="mainWalletAddress" required
        placeholder="T..." autocomplete="off" />
      <p class="field-hint">Funds will be swept to this address.</p>
      <label for="xpubAccount0">xPub (account 0)</label>
      <input type="text" id="xpubAccount0" name="xpubAccount0" required
        placeholder="xpub…" autocomplete="off" />
      <p class="field-hint">BIP44 extended public key, account 0.</p>
      <button type="submit">Create store</button>
    </form>
  </div>
</body>
</html>`;
}

function successPage(
  merchantKey: string,
  readonlyKey: string,
  styleNonce?: string,
  scriptNonce?: string,
): string {
  const sa = styleNonce ? ` nonce="${styleNonce}"` : "";
  const sc = scriptNonce ? ` nonce="${scriptNonce}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Store created — Stablerails</title>
  <style${sa}>${SHARED_CSS}
    .card { max-width: 540px; }
    .key-wrap { margin-bottom: 1.25rem; }
    .key-label { font-size: .67rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .1em; margin-bottom: .4rem; }
    .key-box { background: #0f172a; border: 1px solid #334155; border-radius: .5rem;
      padding: .6rem .8rem; font-family: monospace; font-size: .8rem;
      color: #f1f5f9; word-break: break-all;
      /* Hidden until JS reveals them (CSP-safe pattern) */
      filter: blur(6px); user-select: none; cursor: pointer; transition: filter .2s; }
    .key-box.revealed { filter: none; user-select: text; cursor: auto; }
    .reveal-hint { font-size: .73rem; color: #475569; margin-top: .3rem; }
    .copy-btn { background: rgba(38,161,123,.12); border: 1px solid rgba(38,161,123,.3);
      border-radius: .4rem; color: #26A17B; font-size: .75rem; font-weight: 600;
      padding: .25rem .6rem; cursor: pointer; margin-top: .4rem; display: none; }
    .copy-btn.shown { display: inline-block; }
    .warn { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.3);
      border-radius: .5rem; padding: .7rem .9rem; font-size: .8rem; color: #fbbf24;
      margin-bottom: 1.25rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span class="usdt-dot"></span>Store created</h1>
    <div class="warn">Keys shown <strong>once only</strong>. Click a field to reveal it, then copy.</div>

    <div class="key-wrap">
      <div class="key-label">Merchant API Key (merchant scope)</div>
      <div class="key-box" id="mk" data-key="${esc(merchantKey)}" title="Click to reveal">${esc(merchantKey)}</div>
      <button class="copy-btn" id="mk-copy">Copy</button>
      <div class="reveal-hint">Click the field to reveal</div>
    </div>

    <div class="key-wrap">
      <div class="key-label">Readonly API Key (readonly scope)</div>
      <div class="key-box" id="rk" data-key="${esc(readonlyKey)}" title="Click to reveal">${esc(readonlyKey)}</div>
      <button class="copy-btn" id="rk-copy">Copy</button>
      <div class="reveal-hint">Click the field to reveal</div>
    </div>

    <p class="hint"><a href="/m/dashboard">Go to dashboard</a></p>
  </div>
  <script${sc}>
    ['mk','rk'].forEach(function(id) {
      var box = document.getElementById(id);
      var btn = document.getElementById(id + '-copy');
      if (!box || !btn) return;
      box.addEventListener('click', function() {
        box.classList.add('revealed');
        box.style.userSelect = 'text';
        btn.classList.add('shown');
      });
      btn.addEventListener('click', function() {
        var key = box.getAttribute('data-key') || '';
        navigator.clipboard.writeText(key).then(function() {
          var prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = prev; }, 1500);
        });
      });
    });
  </script>
</body>
</html>`;
}

// ── CSP config (same pattern as /login in auth.ts) ────────────────────────────

const FORM_PAGE_HELMET = {
  enableCSPNonces: true,
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "style-src":   ["'self'"],
      "script-src":  ["'none'"],
      "img-src":     ["'self'"],
      "connect-src": ["'none'"],
      "frame-ancestors": ["'none'"],
    },
  },
};

const SUCCESS_PAGE_HELMET = {
  enableCSPNonces: true,
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "style-src":   ["'self'"],
      "script-src":  ["'self'"],
      "connect-src": ["'none'"],
      "img-src":     ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
};

// ── Session helpers ───────────────────────────────────────────────────────────

function extractMerchantSessionId(cookieHeader: string): string | null {
  return (
    cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${MERCHANT_SESSION_COOKIE_NAME}=`))
      ?.slice(MERCHANT_SESSION_COOKIE_NAME.length + 1) ?? null
  );
}

// ── Route opts ────────────────────────────────────────────────────────────────

export interface HostedSignupOpts {
  merchantRepo: MerchantRepository;
  merchantSessionStore: InMemoryMerchantSessionStore;
  apiKeyRepo: ApiKeyRepository;
  eventRepo: EventRepository;
  invoiceRepo: InvoiceRepository;
  addressValidator: AddressValidator;
  rateLimiter: RateLimiter;
  /** Next derivation account index (must be globally unique). */
  getNextDerivationAccount: () => Promise<number>;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerHostedSignupRoutes(
  app: FastifyInstance,
  opts: HostedSignupOpts,
): Promise<void> {
  const {
    merchantRepo,
    merchantSessionStore,
    apiKeyRepo,
    eventRepo,
    invoiceRepo,
    addressValidator,
    rateLimiter,
    getNextDerivationAccount,
  } = opts;

  // ── GET /signup ─────────────────────────────────────────────────────────────
  app.get(
    "/signup",
    { config: { helmet: FORM_PAGE_HELMET } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const nonce = (reply as FastifyReply & { cspNonce?: { style?: string } }).cspNonce?.style;
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(signupPage(undefined, nonce));
    },
  );

  // ── POST /signup ────────────────────────────────────────────────────────────
  app.post(
    "/signup",
    { config: { rawBody: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // AUTH-1: Rate limit BEFORE any DB or argon2 work.
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("signup", ip)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      let email: string | undefined;
      let password: string | undefined;

      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = req.body as Record<string, string>;
        email = body["email"];
        password = body["password"];
      } else {
        const body = req.body as { email?: string; password?: string };
        email = body?.email;
        password = body?.password;
      }

      if (!email || !password) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "email and password are required" } });
      }

      // Password minimum length: 10 chars
      if (password.length < 10) {
        return reply.code(400).send({ error: { code: "PASSWORD_TOO_SHORT", message: "Password must be at least 10 characters" } });
      }

      // Check for duplicate email — we must run argon2 regardless to equalize timing (AUTH-5).
      const existing = await merchantRepo.findByEmail(email);
      if (existing) {
        // AUTH-5: Run decoy verify so timing is indistinguishable from real signup.
        try {
          await argon2.verify(DECOY_HASH, password);
        } catch {
          // Decoy result irrelevant — always return the neutral body
        }
        // AUTH-5 content equalization: same body as real success — do not leak existence.
        return reply.code(200).send(SIGNUP_NEUTRAL_BODY);
      }

      // Hash the password (same argon2id defaults as operator path)
      const passwordHash = await argon2.hash(password);

      try {
        await merchantRepo.create(email, passwordHash);
      } catch (err) {
        // Concurrent duplicate (race between check and insert) — same neutral body.
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002") {
          return reply.code(200).send(SIGNUP_NEUTRAL_BODY);
        }
        throw err;
      }

      // Real success — same body as all other paths (content equalization).
      return reply.code(200).send(SIGNUP_NEUTRAL_BODY);
    },
  );

  // ── GET /m/login ────────────────────────────────────────────────────────────
  app.get(
    "/m/login",
    { config: { helmet: FORM_PAGE_HELMET } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const nonce = (reply as FastifyReply & { cspNonce?: { style?: string } }).cspNonce?.style;
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(merchantLoginPage(undefined, nonce));
    },
  );

  // ── POST /m/login ────────────────────────────────────────────────────────────
  app.post(
    "/m/login",
    { config: { rawBody: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // AUTH-1: Rate limit BEFORE any DB or argon2 work.
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("login", ip)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      let email: string | undefined;
      let password: string | undefined;

      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = req.body as Record<string, string>;
        email = body["email"];
        password = body["password"];
      } else {
        const body = req.body as { email?: string; password?: string };
        email = body?.email;
        password = body?.password;
      }

      if (!email || !password) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "email and password are required" } });
      }

      const merchant = await merchantRepo.findByEmail(email);
      if (!merchant) {
        // AUTH-5: Decoy timing equalization for unknown email
        try {
          await argon2.verify(DECOY_HASH, password);
        } catch {
          // irrelevant
        }
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
      }

      let valid = false;
      try {
        valid = await argon2.verify(merchant.passwordHash, password);
      } catch {
        // argon2 error → treat as invalid
      }

      if (!valid) {
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
      }

      const sessionId = merchantSessionStore.create({
        merchantId: merchant.id,
        email: merchant.email,
      });

      reply.header(
        "Set-Cookie",
        `${MERCHANT_SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
      );

      const isForm = ct.includes("urlencoded");
      if (isForm) {
        return reply.code(302).header("Location", "/signup/store").send();
      }
      // SEC-4 pattern: no session id in body
      return reply.code(200).send({ data: { email: merchant.email } });
    },
  );

  // ── GET /signup/store ────────────────────────────────────────────────────────
  app.get(
    "/signup/store",
    { config: { helmet: FORM_PAGE_HELMET } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const cookieHeader = req.headers["cookie"] ?? "";
      const sid = extractMerchantSessionId(cookieHeader);
      if (!sid || !merchantSessionStore.get(sid)) {
        return reply.code(302).header("Location", "/m/login").send();
      }

      const nonce = (reply as FastifyReply & { cspNonce?: { style?: string } }).cspNonce?.style;
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(wizardPage(nonce));
    },
  );

  // ── POST /signup/store ────────────────────────────────────────────────────────
  //
  // Validates mainWalletAddress (full Base58Check), xpubAccount0 (non-empty),
  // creates the merchant's Event, and mints two API keys (merchant + readonly),
  // both with merchantId set. Raw keys shown ONCE in the response.
  app.post(
    "/signup/store",
    { config: { helmet: SUCCESS_PAGE_HELMET } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Session gate
      const cookieHeader = req.headers["cookie"] ?? "";
      const sid = extractMerchantSessionId(cookieHeader);
      if (!sid) {
        return reply.code(302).header("Location", "/m/login").send();
      }
      const session = merchantSessionStore.get(sid);
      if (!session) {
        return reply.code(302).header("Location", "/m/login").send();
      }

      let storeName: string | undefined;
      let mainWalletAddress: string | undefined;
      let xpubAccount0: string | undefined;

      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = req.body as Record<string, string>;
        storeName = body["storeName"];
        mainWalletAddress = body["mainWalletAddress"];
        xpubAccount0 = body["xpubAccount0"];
      } else {
        const body = req.body as { storeName?: string; mainWalletAddress?: string; xpubAccount0?: string };
        storeName = body?.storeName;
        mainWalletAddress = body?.mainWalletAddress;
        xpubAccount0 = body?.xpubAccount0;
      }

      // Validate xpub (non-empty)
      if (!xpubAccount0 || xpubAccount0.trim() === "") {
        return reply.code(422).send({ error: { code: "INVALID_XPUB", message: "xpubAccount0 must not be empty" } });
      }

      // Validate mainWalletAddress (full Base58Check)
      if (!mainWalletAddress || !isValidBase58Address(mainWalletAddress)) {
        return reply.code(422).send({ error: { code: "INVALID_TRON_ADDRESS", message: "mainWalletAddress is not a valid Tron Base58Check address" } });
      }

      const merchantId = session.merchantId;
      const derivationAccount = await getNextDerivationAccount();

      // Create event using the core createEvent use-case
      let event: import("../../core/ports.js").EventRow;
      try {
        event = await createEvent(
          {
            name: (storeName ?? "My Store").trim() || "My Store",
            mainWalletAddress: mainWalletAddress.trim(),
            derivationAccount,
            xpubAccount: xpubAccount0.trim(),
            merchantId,
          },
          { eventRepo, addressValidator },
        );
      } catch (err) {
        if (err instanceof EventValidationError) {
          return reply.code(422).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }

      // Mint two keys: merchant scope + readonly scope, both bound to merchantId
      const merchantRaw = generateRawKey();
      const readonlyRaw = generateRawKey();

      const [merchantKeyRecord, readonlyKeyRecord] = await Promise.all([
        apiKeyRepo.insert({
          label: `${storeName ?? "store"}-merchant`,
          hashedKey: hashApiKey(merchantRaw),
          prefix: extractPrefix(merchantRaw),
          scope: "merchant",
          eventId: event.id,
          merchantId,
        }),
        apiKeyRepo.insert({
          label: `${storeName ?? "store"}-readonly`,
          hashedKey: hashApiKey(readonlyRaw),
          prefix: extractPrefix(readonlyRaw),
          scope: "readonly",
          eventId: event.id,
          merchantId,
        }),
      ]);

      // Accept both JSON (for tests/API clients) and browser form submissions.
      const acceptsJson = (req.headers["accept"] ?? "").includes("application/json") ||
        !ct.includes("urlencoded");

      if (acceptsJson) {
        // Return raw keys ONCE in JSON response.
        return reply.code(201).send({
          data: {
            event,
            merchantKey: merchantRaw,
            readonlyKey: readonlyRaw,
            merchantKeyMerchantId: merchantKeyRecord.merchantId ?? null,
            readonlyKeyMerchantId: readonlyKeyRecord.merchantId ?? null,
          },
        });
      }

      // HTML response: success page with hidden-until-click key reveal
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      return reply
        .code(201)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(successPage(merchantRaw, readonlyRaw, cspNonce?.style, cspNonce?.script));
    },
  );

  // ── GET /m/dashboard ────────────────────────────────────────────────────────
  //
  // Read-only v1: invoice list filtered to merchant's tenant.
  // Reuses the existing invoice repo list() with merchantId filter.
  app.get(
    "/m/dashboard",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              "style-src":   ["'self'"],
              "script-src":  ["'self'"],
              "connect-src": ["'none'"],
              "img-src":     ["'self'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Rate limit before session gate (same pattern as /dashboard)
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Too many requests</h1></body></html>",
        );
      }

      const cookieHeader = req.headers["cookie"] ?? "";
      const sid = extractMerchantSessionId(cookieHeader);
      if (!sid) {
        return reply.code(302).header("Location", "/m/login").send();
      }
      const session = merchantSessionStore.get(sid);
      if (!session) {
        return reply.code(302).header("Location", "/m/login").send();
      }

      const merchantId = session.merchantId;

      // Fetch invoices filtered to this merchant's tenant
      const invoices = typeof invoiceRepo.list === "function"
        ? await invoiceRepo.list({ merchantId, limit: 100 })
        : [];

      // Collect API key prefixes for display (never raw keys)
      const allKeys = await apiKeyRepo.list();
      const merchantKeys = allKeys
        .filter((k) => k.merchantId === merchantId && k.revokedAt === null)
        .map((k) => ({ prefix: k.prefix, scope: k.scope }));

      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const styleNonceAttr = cspNonce?.style ? ` nonce="${cspNonce.style}"` : "";
      const scriptNonceAttr = cspNonce?.script ? ` nonce="${cspNonce.script}"` : "";

      const rows = invoices.length === 0
        ? `<tr><td colspan="5" style="padding:2rem;text-align:center;color:#334155;">No invoices found</td></tr>`
        : invoices.map((inv) => {
            const shortId = inv.id.slice(0, 12) + "…";
            const createdFmt = inv.createdAt.toISOString().replace("T", " ").slice(0, 16);
            return `<tr>
              <td class="mono" title="${esc(inv.id)}">${esc(shortId)}</td>
              <td>${esc(inv.priceFiat)} ${esc(inv.fiatCurrency)}</td>
              <td>${esc(inv.status)}</td>
              <td>${esc(inv.amountUsdt)} USDT</td>
              <td>${esc(createdFmt)}</td>
            </tr>`;
          }).join("\n");

      const keyRows = merchantKeys.map((k) =>
        `<tr><td class="mono">${esc(k.prefix)}…</td><td>${esc(k.scope)}</td></tr>`,
      ).join("\n");

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Merchant dashboard — Stablerails</title>
  <style${styleNonceAttr}>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      background: #06090c; color: #e2e8f0; min-height: 100vh; padding: 1.5rem 1rem 3rem; }
    .hdr { max-width: 1000px; margin: 0 auto 1.5rem;
      display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 1.2rem; font-weight: 800; color: #f1f5f9; }
    .email { font-size: .8rem; color: #475569; }
    .section { max-width: 1000px; margin: 0 auto 2rem; }
    .section-title { font-size: .65rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .1em; margin-bottom: .6rem; }
    .table-wrap { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
      border-radius: 12px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: .6rem 1rem; text-align: left; font-size: .65rem; font-weight: 700;
      color: #475569; text-transform: uppercase; letter-spacing: .08em;
      border-bottom: 1px solid rgba(255,255,255,.07); }
    td { padding: .55rem 1rem; font-size: .82rem; color: #cbd5e1;
      border-bottom: 1px solid rgba(255,255,255,.04); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: monospace; font-size: .78rem; }
  </style>
</head>
<body>
  <div class="hdr">
    <h1>Merchant dashboard</h1>
    <span class="email">${esc(session.email)}</span>
  </div>

  <div class="section">
    <div class="section-title">API keys</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Prefix</th><th>Scope</th></tr></thead>
        <tbody>${keyRows || '<tr><td colspan="2" style="padding:1rem;color:#334155;">No keys</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Invoices</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>USDT</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>

  <script${scriptNonceAttr}>
    // placeholder — no interactions on v1 dashboard
  </script>
</body>
</html>`;

      return reply.code(200).header("Content-Type", "text/html; charset=utf-8").send(html);
    },
  );
}
