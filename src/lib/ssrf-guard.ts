/**
 * SSRF guard (spec §8).
 *
 * Resolves the hostname of a URL and validates every resolved IP against
 * deny-lists before allowing the request through.
 *
 * Deny-list covers:
 *   - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - Loopback (127/8, ::1)
 *   - Link-local (169.254/16, fe80::/10)
 *   - ULA (fc00::/7)
 *   - Unspecified (0.0.0.0)
 *   - IPv4-mapped IPv6 (::ffff:<private>) — all compact/expanded forms
 *   - NAT64 prefix 64:ff9b::/96
 *   - Cloud metadata IP (169.254.169.254)
 *
 * Only https:// URLs are allowed.
 * DNS resolution is injectable so tests run fully offline.
 * Re-validation after each redirect is enforced by the guarded fetch wrapper.
 */

import { lookup as dnsLookup } from "node:dns/promises";
// undici is a real production dependency (not Node-bundled) — required for DNS pinning.
// Using ESM top-level import guarantees the module is loaded at startup; if it
// fails (missing package), the process exits immediately rather than silently
// degrading to unpinned globalThis.fetch at runtime.
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Injectable DNS resolver for tests. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** Default: uses Node's dns.promises.lookup for all address families. */
const defaultDnsResolver: DnsResolver = async (hostname: string) => {
  try {
    // family: 0 → return both IPv4 and IPv6
    const result = await dnsLookup(hostname, { all: true, family: 0 });
    return result.map((r) => r.address);
  } catch {
    throw new SsrfGuardError(
      "DNS_FAILED",
      `DNS resolution failed for hostname: ${hostname}`,
    );
  }
};

// ── Error ─────────────────────────────────────────────────────────────────────

export class SsrfGuardError extends Error {
  constructor(
    public readonly code:
      | "NOT_HTTPS"
      | "DNS_FAILED"
      | "BLOCKED_IP"
      | "REDIRECT_BLOCKED"
      | "TOO_MANY_REDIRECTS",
    message: string,
  ) {
    super(message);
    this.name = "SsrfGuardError";
  }
}

// ── IP classification helpers ─────────────────────────────────────────────────

/** Parse an IPv4 address into a 32-bit unsigned integer. Returns null if invalid. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255 || p === "") return null;
    n = (n << 8) | v;
  }
  return n >>> 0; // ensure unsigned
}

/** Check an IPv4 32-bit int against a CIDR. */
function inCidr(ip: number, base: number, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (base & mask);
}

const IPV4_DENY_RANGES: Array<{ base: number; prefix: number; label: string }> = [
  // 10.0.0.0/8
  { base: 0x0a000000, prefix: 8, label: "RFC1918 10/8" },
  // 172.16.0.0/12
  { base: 0xac100000, prefix: 12, label: "RFC1918 172.16/12" },
  // 192.168.0.0/16
  { base: 0xc0a80000, prefix: 16, label: "RFC1918 192.168/16" },
  // 127.0.0.0/8 loopback
  { base: 0x7f000000, prefix: 8, label: "loopback 127/8" },
  // 169.254.0.0/16 link-local + metadata
  { base: 0xa9fe0000, prefix: 16, label: "link-local/metadata 169.254/16" },
  // 0.0.0.0/8
  { base: 0x00000000, prefix: 8, label: "unspecified 0/8" },
];

/** Returns deny reason if the IPv4 address is blocked, null otherwise. */
function blockedIPv4Reason(ip: string): string | null {
  const n = parseIPv4(ip);
  if (n === null) return null; // not a valid IPv4

  for (const range of IPV4_DENY_RANGES) {
    if (inCidr(n, range.base, range.prefix)) return range.label;
  }
  return null;
}

/**
 * Expand a full 8-group IPv6 address (no :: compression) into a 32-bit IPv4
 * embedded in the low 32 bits, given that groups[6] and groups[7] carry the
 * address. Returns the IPv4 string.
 */
function low32ToIPv4(hiGroup: number, loGroup: number): string {
  return `${hiGroup >> 8}.${hiGroup & 0xff}.${loGroup >> 8}.${loGroup & 0xff}`;
}

/**
 * Expand a compressed IPv6 address into exactly 8 groups of 16-bit integers.
 * Returns null if the input is not a valid IPv6 address.
 */
function expandIPv6(ip: string): number[] | null {
  const lower = ip.toLowerCase().trim();
  // Remove brackets if present
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;

  // Handle :: expansion
  const halves = bare.split("::");
  if (halves.length > 2) return null; // more than one ::

  if (halves.length === 2) {
    const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
    const right = halves[1] === "" ? [] : (halves[1]?.split(":") ?? []);
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    const groups = [
      ...left.map((g) => parseInt(g, 16)),
      ...Array(fill).fill(0) as number[],
      ...right.map((g) => parseInt(g, 16)),
    ];
    if (groups.some((g) => isNaN(g) || g < 0 || g > 0xffff)) return null;
    return groups;
  }

  // No :: — must be exactly 8 groups
  const groups = bare.split(":").map((g) => parseInt(g, 16));
  if (groups.length !== 8) return null;
  if (groups.some((g) => isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/**
 * If the string ends with an IPv4 dotted-quad (e.g. "0:0:0:0:0:ffff:169.254.169.254"),
 * extract the prefix groups and the trailing IPv4. Returns null if no dot-quad found.
 */
function splitMixedIPv6(ip: string): { prefixGroups: number[]; ipv4: string } | null {
  // Match trailing dotted-quad IPv4 in mixed IPv6 notation
  const mixed = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (!mixed) return null;
  const prefix = mixed[1] ?? "";
  const ipv4 = mixed[2] ?? "";

  // Expand the IPv6 prefix (without the IPv4 tail) as if it were a 6-group addr
  // The :: expansion fills up to 6 groups total
  const halves = prefix.split("::");
  let prefixGroups: number[];
  if (halves.length === 2) {
    const left = halves[0] === "" ? [] : (halves[0]?.split(":").filter(Boolean) ?? []);
    const right = halves[1] === "" ? [] : (halves[1]?.split(":").filter(Boolean) ?? []);
    const fill = 6 - left.length - right.length;
    if (fill < 0) return null;
    prefixGroups = [
      ...left.map((g) => parseInt(g, 16)),
      ...Array(fill).fill(0) as number[],
      ...right.map((g) => parseInt(g, 16)),
    ];
  } else {
    prefixGroups = prefix.split(":").filter(Boolean).map((g) => parseInt(g, 16));
    if (prefixGroups.length !== 6) return null;
  }
  if (prefixGroups.some((g) => isNaN(g) || g < 0 || g > 0xffff)) return null;

  return { prefixGroups, ipv4 };
}

/**
 * Parse an IPv4-mapped IPv6 address in any form:
 *   - ::ffff:a.b.c.d  (compact dot-notation)
 *   - ::ffff:AABB:CCDD  (compact hex)
 *   - 0:0:0:0:0:ffff:a.b.c.d  (expanded dot-notation / mixed)
 *   - 0:0:0:0:0:ffff:AABB:CCDD  (fully expanded hex, e.g. OS canonical form)
 *
 * Returns the embedded IPv4 string if present, null otherwise.
 */
function extractIPv4MappedFromIPv6(ip: string): string | null {
  const lower = ip.toLowerCase().trim();

  // Compact ::ffff:a.b.c.d form
  const dotForm = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotForm) return dotForm[1] ?? null;

  // Compact ::ffff:AABB:CCDD hex form
  const hexCompact = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexCompact) {
    const hi = parseInt(hexCompact[1] ?? "0", 16);
    const lo = parseInt(hexCompact[2] ?? "0", 16);
    return low32ToIPv4(hi, lo);
  }

  // Mixed notation: trailing dotted-quad (e.g. 0:0:0:0:0:ffff:169.254.169.254)
  const mixed = splitMixedIPv6(lower);
  if (mixed !== null) {
    const { prefixGroups, ipv4 } = mixed;
    if (
      prefixGroups[0] === 0 &&
      prefixGroups[1] === 0 &&
      prefixGroups[2] === 0 &&
      prefixGroups[3] === 0 &&
      prefixGroups[4] === 0 &&
      prefixGroups[5] === 0xffff
    ) {
      return ipv4;
    }
    return null;
  }

  // Any fully-hex expanded form: expand to 8 groups and check groups[5] == 0xffff
  const groups = expandIPv6(lower);
  if (groups === null) return null;
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return low32ToIPv4(groups[6] ?? 0, groups[7] ?? 0);
  }

  return null;
}

/**
 * Return true if the IPv6 address is within the NAT64 prefix 64:ff9b::/96.
 * The low 32 bits carry an IPv4 address.
 * Handles both compact and expanded forms.
 */
function isNat64(ip: string): { embedded: string } | null {
  const groups = expandIPv6(ip.toLowerCase().trim());
  if (groups === null) return null;
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return { embedded: low32ToIPv4(groups[6] ?? 0, groups[7] ?? 0) };
  }
  return null;
}

/** Returns deny reason if an IPv6 address is blocked, null otherwise. */
function blockedIPv6Reason(ip: string): string | null {
  const lower = ip.toLowerCase().trim();

  // Use the expanded-groups form for reliable prefix checks
  const groups = expandIPv6(lower);

  if (groups !== null) {
    // ::1 loopback (all groups 0 except last = 1)
    if (groups.every((g, i) => i < 7 ? g === 0 : g === 1)) {
      return "IPv6 loopback ::1";
    }

    // :: unspecified (all zeros)
    if (groups.every((g) => g === 0)) {
      return "IPv6 unspecified ::";
    }

    // fe80::/10 link-local — first group high 10 bits = 1111111010
    if ((groups[0]! & 0xffc0) === 0xfe80) {
      return "IPv6 link-local fe80::/10";
    }

    // fc00::/7 ULA — first group high 7 bits = 1111110
    if ((groups[0]! & 0xfe00) === 0xfc00) {
      return "IPv6 ULA fc00::/7";
    }
  } else {
    // Fallback for forms that expandIPv6 can't parse: first-group-based checks
    const first16 = lower.split(":")[0] ?? "";
    const first16n = parseInt(first16.padEnd(4, "0"), 16);
    if (!isNaN(first16n) && (first16n & 0xffc0) === 0xfe80) {
      return "IPv6 link-local fe80::/10";
    }
    if (!isNaN(first16n) && (first16n & 0xfe00) === 0xfc00) {
      return "IPv6 ULA fc00::/7";
    }
  }

  // IPv4-mapped: ::ffff:... — all compact and expanded forms
  const embedded = extractIPv4MappedFromIPv6(lower);
  if (embedded !== null) {
    const reason = blockedIPv4Reason(embedded);
    if (reason !== null) return `IPv4-mapped IPv6 (${reason})`;
    // Allow public IPv4-mapped — only block private embeds.
  }

  // NAT64 64:ff9b::/96 — low 32 bits carry an IPv4 address
  const nat64 = isNat64(lower);
  if (nat64 !== null) {
    const reason = blockedIPv4Reason(nat64.embedded);
    if (reason !== null) return `NAT64 64:ff9b:: (${reason})`;
  }

  return null;
}

/**
 * Returns a deny reason if the resolved IP should be blocked, null otherwise.
 */
export function blockedIpReason(ip: string): string | null {
  // Try IPv4 first
  const v4reason = blockedIPv4Reason(ip);
  if (v4reason !== null) return v4reason;

  // Try IPv6
  if (ip.includes(":")) {
    return blockedIPv6Reason(ip);
  }

  return null;
}

// ── Core guard ────────────────────────────────────────────────────────────────

/**
 * Validate a URL is safe to request:
 * 1. Must be https://
 * 2. Resolve the hostname
 * 3. Block if any resolved IP is in a deny-listed range
 *
 * @param url      URL to validate.
 * @param resolve  Injectable DNS resolver (defaults to Node dns.lookup).
 * @throws SsrfGuardError on any violation.
 */
export async function assertSafeUrl(
  url: string,
  resolve: DnsResolver = defaultDnsResolver,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfGuardError("NOT_HTTPS", `Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    throw new SsrfGuardError(
      "NOT_HTTPS",
      `Only https:// URLs are allowed, got: ${parsed.protocol}`,
    );
  }

  const hostname = parsed.hostname;

  // If hostname is a bare IP, validate directly without DNS lookup
  if (isIpLiteral(hostname)) {
    // Remove IPv6 brackets if present
    const rawIp = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    const reason = blockedIpReason(rawIp);
    if (reason !== null) {
      throw new SsrfGuardError("BLOCKED_IP", `IP ${rawIp} is blocked: ${reason}`);
    }
    return;
  }

  // DNS resolve
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new SsrfGuardError("DNS_FAILED", `No addresses resolved for: ${hostname}`);
  }

  for (const ip of addresses) {
    const reason = blockedIpReason(ip);
    if (reason !== null) {
      throw new SsrfGuardError(
        "BLOCKED_IP",
        `Hostname ${hostname} resolved to blocked IP ${ip}: ${reason}`,
      );
    }
  }
}

/** Returns true if the hostname is an IP literal (IPv4 or IPv6 bracket notation). */
function isIpLiteral(hostname: string): boolean {
  // IPv6 in brackets
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return false;
}

// ── DNS-pinned fetch (S2: DNS-rebinding prevention) ──────────────────────────

/**
 * Resolve hostname, validate all returned IPs, then return a fetch function
 * that PINS TCP connections to one of those pre-validated addresses.
 *
 * How pinning works (WH-1):
 *   1. DNS resolution is performed ONCE here, before any connection.
 *   2. All resolved IPs are validated against the SSRF deny-list.
 *   3. An undici Agent is created with a custom `connect.lookup` callback that
 *      ALWAYS returns the pre-validated IP instead of calling the OS resolver.
 *   4. undici.fetch is called with this agent as the `dispatcher`.
 *
 * This defeats DNS-rebinding attacks (TTL=0 or rapid DNS flip): even if the
 * attacker changes DNS between the validation step and the connection step,
 * the connection is pinned to the IP we already verified — the OS resolver is
 * never consulted a second time.
 *
 * The Host header and TLS SNI are preserved as the original hostname (undici
 * handles this automatically when using a custom dispatcher).
 *
 * Fails closed: if undici is missing from node_modules the top-level import
 * throws at startup (not silently at request time), preventing any unpinned
 * webhook dispatch.
 *
 * @param hostname  Bare hostname (no scheme/path).
 * @param resolve   Injectable DNS resolver (for tests).
 * @returns         A fetch-compatible function that uses a pinned undici dispatcher.
 * @throws SsrfGuardError  if resolution fails or any resolved IP is blocked.
 */
export async function buildPinnedFetch(
  hostname: string,
  resolve: DnsResolver,
): Promise<typeof fetch> {
  // Step 1: Resolve + validate all IPs.
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new SsrfGuardError("DNS_FAILED", `No addresses resolved for: ${hostname}`);
  }
  for (const ip of addresses) {
    const reason = blockedIpReason(ip);
    if (reason !== null) {
      throw new SsrfGuardError(
        "BLOCKED_IP",
        `Hostname ${hostname} resolved to blocked IP ${ip}: ${reason}`,
      );
    }
  }

  // Step 2: Pin to the first validated address.
  // All addresses have been checked above; we connect to the first one.
  const pinnedIp = addresses[0]!;

  // Step 3: Build an undici Agent that ignores the OS resolver and always
  // returns the pre-validated IP when the undici connect layer asks for it.
  const agent = new UndiciAgent({
    connect: {
      // Override DNS lookup inside the undici connect pipeline.
      // _host is the hostname undici wants to resolve; we ignore it and
      // return pinnedIp so no second OS round-trip can be hijacked.
      //
      // IMPORTANT: undici calls lookup with { all: true }, which requires
      // the callback to return an ARRAY of address objects, NOT the single-
      // address form (address: string, family: number) used by Node's legacy
      // dns.lookup. Using the single-address form makes undici read
      // `addresses[0].address` → undefined → ERR_INVALID_IP_ADDRESS, causing
      // every request to fail and silently defeating the pinning.
      lookup: (
        _host: string,
        _opts: { all?: boolean } | undefined,
        callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
      ) => {
        const family = pinnedIp.includes(":") ? 6 : 4;
        callback(null, [{ address: pinnedIp, family }]);
      },
    },
  });

  // TODO(SF): current implementation pins to addresses[0] only. If the first
  // validated IP becomes unreachable, the request fails rather than trying the
  // next validated public address. Implement a failover loop for resilience.

  // Step 4: Return a fetch wrapper that injects the pinned agent as dispatcher.
  // undiciFetch only accepts string | URL — guardedFetch always passes a string,
  // but we handle all input types for safety.
  return (input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(
      typeof input === "string" || input instanceof URL ? input : input.url,
      { ...(init as Record<string, unknown> ?? {}), dispatcher: agent },
    ) as Promise<Response>;
}

// ── Guarded fetch ─────────────────────────────────────────────────────────────

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  resolve?: DnsResolver;
  /**
   * Injectable fetch for tests. When provided, DNS-pinning is skipped
   * (the mock already controls which host is contacted). SSRF guard and
   * redirect re-validation still run.
   */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * SSRF-safe fetch with DNS pinning (WH-1).
 *
 * 1. Initial URL validation: https-only; all resolved IPs checked against deny-list.
 * 2. DNS pinning via undici: hostname resolved ONCE; undici Agent's connect.lookup
 *    callback pins TCP connections to the pre-validated IP — defeating TTL=0
 *    DNS-rebinding attacks. undici is a real production dependency (not bundled
 *    Node internals), so pinning is ALWAYS active in production.
 * 3. Manual redirect following with full SSRF re-validation of every Location header
 *    (including fresh DNS resolution + pinning for each redirect target).
 * 4. Request timeout via AbortController.
 *
 * Returns the final Response.
 * Throws SsrfGuardError if any URL (initial or redirect) is blocked.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  opts: GuardedFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    resolve = defaultDnsResolver,
    fetchFn,
  } = opts;

  let currentUrl = url;
  let redirectsLeft = maxRedirects;

  while (true) {
    // Parse + https check
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new SsrfGuardError("NOT_HTTPS", `Invalid URL: ${currentUrl}`);
    }
    if (parsed.protocol !== "https:") {
      throw new SsrfGuardError(
        "NOT_HTTPS",
        `Only https:// URLs are allowed, got: ${parsed.protocol}`,
      );
    }

    // Choose fetch function: injected mock (tests) or DNS-pinned real fetch
    let activeFetch: typeof fetch;
    if (fetchFn) {
      // Injected: still validate the URL but skip DNS pinning (mock controls connections)
      await assertSafeUrl(currentUrl, resolve);
      activeFetch = fetchFn;
    } else {
      const hostname = parsed.hostname;
      if (isIpLiteral(hostname)) {
        // Bare IP literal — validate directly, no DNS
        const rawIp = hostname.startsWith("[") && hostname.endsWith("]")
          ? hostname.slice(1, -1)
          : hostname;
        const reason = blockedIpReason(rawIp);
        if (reason !== null) {
          throw new SsrfGuardError("BLOCKED_IP", `IP ${rawIp} is blocked: ${reason}`);
        }
        activeFetch = globalThis.fetch;
      } else {
        // Build a pinned fetch that resolves + validates + pins the IP
        activeFetch = await buildPinnedFetch(hostname, resolve);
      }
    }

    // Abort controller for timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await activeFetch(currentUrl, {
        ...init,
        signal: controller.signal,
        redirect: "manual", // we handle redirects ourselves
      });
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location")
    ) {
      if (redirectsLeft <= 0) {
        throw new SsrfGuardError(
          "TOO_MANY_REDIRECTS",
          `Exceeded ${maxRedirects} redirects at ${currentUrl}`,
        );
      }
      const location = response.headers.get("location")!;
      // Resolve relative redirects against the current URL
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new SsrfGuardError(
          "REDIRECT_BLOCKED",
          `Invalid redirect location: ${location}`,
        );
      }
      currentUrl = nextUrl.toString();
      redirectsLeft--;
      // Loop: next iteration validates + pins the redirect target
      continue;
    }

    return response;
  }
}
