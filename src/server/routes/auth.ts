/**
 * Operator session auth routes (spec §4.5).
 *
 * GET  /login         — serve login form (HTML)
 * POST /v1/auth/login — Argon2 verify → set session cookie → redirect to /api-keys
 *
 * These routes are separate from the Bearer-key auth. They give the operator
 * a browser-based session to manage API keys via the web UI.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import argon2 from "argon2";
import {
  InMemorySessionStore,
  SESSION_COOKIE_NAME,
  hashLoginToken,
} from "../auth.js";
import type {
  OperatorRepository,
  ApiKeyRepository,
  LoginTokenRepository,
} from "../auth.js";
import type { RateLimiter } from "../../lib/rate-limit.js";

interface AuthRouteOpts {
  operatorRepo: OperatorRepository;
  sessionStore: InMemorySessionStore;
  apiKeyRepo?: ApiKeyRepository;
  rateLimiter: RateLimiter;
  /** Magic-link tokens (GET /auth/magic). Absent → magic links always 403. */
  loginTokenRepo?: LoginTokenRepository;
}

interface LoginBody {
  email: string;
  password: string;
}

// Timing-equalization decoy (user-enumeration hardening): a fixed Argon2id
// hash of a random throwaway password, precomputed once (NOT per request).
// When the email is unknown we still run argon2.verify against this hash so
// the response time matches the known-email path — otherwise the fast 401
// for unknown emails lets an attacker enumerate valid operator addresses.
// Parameters match argon2.hash() defaults used for real operator hashes.
const DECOY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$Tkz3H8ZeEJxmBPL0iRsHxg$5tPIpP8hEeba+q5NRdRgFXiF8IW8GEpvwK9EhRB+EHc";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loginPage(error?: string, styleNonce?: string): string {
  const nonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Войти — Stablerails</title>
  <style${nonceAttr}>
    body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border-radius: 1rem; padding: 2rem; width: 100%; max-width: 360px; }
    h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }
    label { display: block; font-size: 0.875rem; color: #94a3b8; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.6rem 0.75rem; background: #0f172a; border: 1px solid #334155; border-radius: 0.5rem; color: #f1f5f9; font-size: 0.95rem; margin-bottom: 1rem; }
    button { width: 100%; padding: 0.7rem; background: #2563eb; color: white; border: none; border-radius: 0.5rem; font-size: 1rem; cursor: pointer; font-weight: 600; }
    button:hover { background: #1d4ed8; }
    .error { background: #7f1d1d; border: 1px solid #ef4444; border-radius: 0.5rem; padding: 0.75rem; margin-bottom: 1rem; color: #fca5a5; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Войти</h1>
    ${error ? `<div class="error">${escHtml(error)}</div>` : ""}
    <form method="POST" action="/v1/auth/login">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" />
      <label for="password">Пароль</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" />
      <button type="submit">Войти</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * 403 page for invalid/expired/used magic links.
 * Static content only — the token is NEVER echoed back. Inline <style> is
 * covered by the per-request CSP style nonce (same pattern as /login).
 */
function magicLinkErrorPage(styleNonce?: string): string {
  const nonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  const hint = escHtml("stablerails operator login-link");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ссылка недействительна — Stablerails</title>
  <style${nonceAttr}>
    body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; border-radius: 1rem; padding: 2rem; width: 100%; max-width: 420px; }
    h1 { margin-top: 0; font-size: 1.25rem; }
    p { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; }
    code { background: #0f172a; padding: 0.2rem 0.45rem; border-radius: 0.35rem; color: #f1f5f9; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Ссылка для входа недействительна</h1>
    <p>Ссылка устарела, уже была использована или не существует.
       Ссылки действуют 15 минут и работают только один раз.</p>
    <p>Сгенерируйте новую ссылку на сервере (Generate a new link):</p>
    <p><code>${hint}</code></p>
  </div>
</body>
</html>`;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRouteOpts,
): Promise<void> {
  const { operatorRepo, sessionStore, apiKeyRepo, rateLimiter, loginTokenRepo } = opts;

  // GET /login — HTML page with security headers + CSP nonce for inline styles.
  // No inline <script> on /login, so script-src nonce is not required.
  // style-src nonce covers the <style> block.
  app.get(
    "/login",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // nonce injected automatically by @fastify/helmet enableCSPNonces
              "style-src": ["'self'"],
              "script-src": ["'none'"],
              "img-src": ["'self'"],
              "connect-src": ["'none'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // reply.cspNonce is set by @fastify/helmet when enableCSPNonces is true
      const nonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce?.style;
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(loginPage(undefined, nonce));
    },
  );

  // POST /v1/auth/login — accepts both JSON (for tests) and form data
  app.post(
    "/v1/auth/login",
    { config: { rawBody: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // AUTH-1: Rate-limit BEFORE any DB or Argon2 work.
      // Key on the TCP socket IP — do NOT trust X-Forwarded-For which can be
      // forged by clients to bypass per-IP limits.
      // Deployment assumption: req.socket.remoteAddress is the true client IP
      // when NO untrusted proxy fronts this API (direct TLS termination or a
      // trusted reverse proxy that does NOT add XFF). If deployed behind a
      // load-balancer/reverse-proxy, derive the real client IP from a
      // proxy-validated forwarded header (e.g. X-Real-IP or the first
      // X-Forwarded-For entry after stripping proxy hops) — else all clients
      // collapse into a single shared bucket keyed on the proxy's IP.
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("login", ip)) {
        return reply
          .code(429)
          .send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      let email: string | undefined;
      let password: string | undefined;

      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        // Form submission.
        const body = req.body as Record<string, string>;
        email = body["email"];
        password = body["password"];
      } else {
        // JSON submission.
        const body = req.body as LoginBody;
        email = body?.email;
        password = body?.password;
      }

      if (!email || !password) {
        const isHtml = ct.includes("urlencoded");
        if (isHtml) {
          return reply
            .code(400)
            .header("Content-Type", "text/html; charset=utf-8")
            .send(loginPage("Email и пароль обязательны"));
        }
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "email and password required" } });
      }

      const operator = await operatorRepo.findByEmail(email);
      if (!operator) {
        // Constant-time equalization: burn the same Argon2 cost as the
        // known-email path before returning the generic 401, so unknown vs
        // known emails are indistinguishable by response timing.
        // Runs AFTER the rate-limit check (AUTH-1 ordering preserved).
        try {
          await argon2.verify(DECOY_PASSWORD_HASH, password);
        } catch {
          // decoy verify result is irrelevant — always fall through to 401
        }
        if (ct.includes("urlencoded")) {
          return reply
            .code(401)
            .header("Content-Type", "text/html; charset=utf-8")
            .send(loginPage("Неверный email или пароль"));
        }
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
      }

      let valid = false;
      try {
        valid = await argon2.verify(operator.passwordHash, password);
      } catch {
        // argon2 error → treat as invalid
      }

      if (!valid) {
        if (ct.includes("urlencoded")) {
          return reply
            .code(401)
            .header("Content-Type", "text/html; charset=utf-8")
            .send(loginPage("Неверный email или пароль"));
        }
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
      }

      const sessionId = sessionStore.create({
        operatorId: operator.id,
        email: operator.email,
      });

      reply.header(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
      );

      if (ct.includes("urlencoded")) {
        return reply.code(302).header("Location", "/api-keys").send();
      }
      // SEC-4: do NOT echo the session id in the response body — it is already
      // delivered via the HttpOnly Set-Cookie header. Returning it in the body
      // would expose it to JavaScript (XSS risk) and in logs/network captures.
      return reply.code(200).send({ data: { email: operator.email } });
    },
  );

  // GET /auth/magic?token=<hex> — magic-link login (minted by `stablerails
  // init` / `stablerails operator login-link`).
  //
  // SECURITY:
  //   - Rate-limited per-IP (same "login" bucket as POST /v1/auth/login),
  //     BEFORE any DB work.
  //   - Token is hashed (SHA-256) before lookup — raw token never stored.
  //   - Single-use: consume() atomically marks usedAt, replay → 403.
  //   - Session fixation safe: a FRESH random session id is minted by
  //     sessionStore.create(); nothing from the request is reused.
  //   - The token is never echoed back or logged (static 403 page).
  app.get(
    "/auth/magic",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style nonce injected automatically by @fastify/helmet
              "style-src": ["'self'"],
              "script-src": ["'none'"],
              "img-src": ["'self'"],
              "connect-src": ["'none'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const styleNonce = (
        reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }
      ).cspNonce?.style;

      const reject = (code: number): FastifyReply =>
        reply
          .code(code)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(magicLinkErrorPage(styleNonce));

      // Rate-limit BEFORE any DB lookup — key on the TCP socket IP (same
      // deployment assumption as POST /v1/auth/login: no untrusted XFF).
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("login", ip)) {
        return reject(429);
      }

      const token = (req.query as { token?: unknown }).token;
      // Strict shape check (64 hex chars = 32 random bytes) before hashing.
      if (
        !loginTokenRepo ||
        typeof token !== "string" ||
        !/^[0-9a-f]{64}$/i.test(token)
      ) {
        return reject(403);
      }

      // Atomic single-use consume: exists AND unused AND unexpired, marked
      // used in the same guarded update (replay-safe under concurrency).
      const record = await loginTokenRepo.consume(hashLoginToken(token), new Date());
      if (!record) {
        return reject(403);
      }

      const operator = await operatorRepo.findById(record.operatorId);
      if (!operator) {
        return reject(403);
      }

      // Fresh session id — exactly like POST /v1/auth/login.
      const sessionId = sessionStore.create({
        operatorId: operator.id,
        email: operator.email,
      });
      reply.header(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
      );
      return reply.code(302).header("Location", "/dashboard").send();
    },
  );

  // GET /api-keys — session-gated operator page for API key management.
  // Accepts the session cookie set by POST /v1/auth/login.
  // Returns JSON (operator tooling) or simple HTML (browser redirect target).
  // HTML path: CSP with nonce for the inline <script> that handles key creation.
  app.get(
    "/api-keys",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src nonce injected by @fastify/helmet
              "style-src": ["'self'", "'unsafe-inline'"], // inline styles via style="" attributes
              // script-src nonce injected by @fastify/helmet
              "script-src": ["'self'"],
              "connect-src": ["'self'"], // fetch('/v1/api-keys') in the inline script
              "img-src": ["'self'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
        ?.slice(SESSION_COOKIE_NAME.length + 1);

      if (!sessionId) {
        return reply
          .code(302)
          .header("Location", "/login")
          .send();
      }

      const session = sessionStore.get(sessionId);
      if (!session) {
        return reply
          .code(302)
          .header("Location", "/login")
          .send();
      }

      // If an apiKeyRepo was injected, list keys for this operator's context.
      const keys = apiKeyRepo ? await apiKeyRepo.list() : [];
      const sanitizedKeys = keys.map(({ id, label, prefix, scope, createdAt, revokedAt }) => ({
        id,
        label,
        prefix,
        scope,
        createdAt,
        revokedAt,
      }));

      const accept = req.headers["accept"] ?? "";
      if (accept.includes("application/json")) {
        return reply.code(200).send({
          data: {
            operator: { email: session.email },
            apiKeys: sanitizedKeys,
          },
        });
      }

      // Minimal HTML page for browser use.
      // script-src nonce from @fastify/helmet allows this inline <script>.
      const scriptNonce = cspNonce?.script ?? "";
      const nonceAttr = scriptNonce ? ` nonce="${scriptNonce}"` : "";

      const rows = sanitizedKeys
        .map(
          (k) =>
            `<tr><td>${escHtml(k.id)}</td><td>${escHtml(k.label)}</td><td>${escHtml(k.scope)}</td><td>${escHtml(k.prefix)}</td><td>${k.revokedAt ? "revoked" : "active"}</td></tr>`,
        )
        .join("\n");

      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8" /><title>API Keys — Stablerails</title>
<style>
  body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
  table{border-collapse:collapse;width:100%}
  th,td{padding:.5rem 1rem;text-align:left;border-bottom:1px solid #334155}
  .card{background:#1e293b;border-radius:.75rem;padding:1.5rem;max-width:480px;margin-bottom:2rem}
  label{display:block;font-size:.875rem;color:#94a3b8;margin-bottom:.25rem}
  input,select{width:100%;padding:.5rem .75rem;background:#0f172a;border:1px solid #334155;border-radius:.5rem;color:#f1f5f9;font-size:.95rem;margin-bottom:1rem}
  button{padding:.6rem 1.25rem;background:#2563eb;color:white;border:none;border-radius:.5rem;font-size:.95rem;cursor:pointer;font-weight:600}
  button:hover{background:#1d4ed8}
  .note{font-size:.8rem;color:#f59e0b;margin-top:.5rem}
</style>
</head>
<body>
  <h1>API Keys</h1>
  <p>Logged in as <strong>${escHtml(session.email)}</strong></p>

  <div class="card">
    <h2 style="margin-top:0">Create API Key</h2>
    <form id="create-form">
      <label for="label">Label</label>
      <input type="text" id="label" name="label" required placeholder="e.g. main-admin" />
      <label for="scope">Scope</label>
      <select id="scope" name="scope">
        <option value="admin">admin</option>
        <option value="merchant">merchant</option>
      </select>
      <button type="submit">Create key</button>
    </form>
    <div id="create-result" style="display:none;margin-top:1rem"></div>
    <p class="note">The raw key is shown ONCE. Copy it immediately.</p>
  </div>

  <table>
    <thead><tr><th>ID</th><th>Label</th><th>Scope</th><th>Prefix</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <script${nonceAttr}>
    document.getElementById('create-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const label = document.getElementById('label').value.trim();
      const scope = document.getElementById('scope').value;
      const result = document.getElementById('create-result');
      result.style.display = 'none';
      try {
        const res = await fetch('/v1/api-keys', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({label, scope}),
          credentials: 'same-origin',
        });
        const json = await res.json();
        if (res.ok) {
          const raw = json.data.rawKey;
          result.innerHTML = '<strong style="color:#4ade80">Key created!</strong><br>' +
            'Raw key (copy now — shown ONCE):<br>' +
            '<code style="word-break:break-all;background:#0f172a;padding:.5rem;border-radius:.25rem;display:block;margin-top:.5rem">' +
            raw + '</code>';
          result.style.display = 'block';
          setTimeout(() => location.reload(), 5000);
        } else {
          const msg = json.error?.message ?? JSON.stringify(json);
          result.innerHTML = '<strong style="color:#f87171">Error:</strong> ' + msg;
          result.style.display = 'block';
        }
      } catch(err) {
        result.innerHTML = '<strong style="color:#f87171">Network error:</strong> ' + err.message;
        result.style.display = 'block';
      }
    });
  </script>
</body>
</html>`);
    },
  );
}
