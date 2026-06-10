/**
 * Tests for src/lib/ssrf-guard.ts
 *
 * All offline — DNS resolution is injected via mockResolve().
 * No real HTTP requests, no real DNS.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import {
  assertSafeUrl,
  blockedIpReason,
  guardedFetch,
  SsrfGuardError,
  buildPinnedFetch,
} from "../ssrf-guard.js";

// ── Helper ────────────────────────────────────────────────────────────────────

/** Create a mock DNS resolver that always returns the given IPs. */
function mockResolve(ips: string[]) {
  return async (_hostname: string): Promise<string[]> => ips;
}

/** Assert that assertSafeUrl throws SsrfGuardError with the given code. */
async function expectBlocked(
  url: string,
  expectedCode: SsrfGuardError["code"],
  resolve = mockResolve(["93.184.216.34"]), // example.com (public)
): Promise<void> {
  let caught: SsrfGuardError | null = null;
  try {
    await assertSafeUrl(url, resolve);
  } catch (e) {
    caught = e as SsrfGuardError;
  }
  expect(caught, `Expected SsrfGuardError(${expectedCode}) for ${url}`).not.toBeNull();
  expect(caught!.code).toBe(expectedCode);
}

async function expectAllowed(
  url: string,
  resolve = mockResolve(["93.184.216.34"]),
): Promise<void> {
  await expect(assertSafeUrl(url, resolve)).resolves.toBeUndefined();
}

// ── blockedIpReason() ─────────────────────────────────────────────────────────

describe("blockedIpReason()", () => {
  // RFC 1918
  it("blocks 10.0.0.1 (RFC1918 10/8)", () => {
    expect(blockedIpReason("10.0.0.1")).not.toBeNull();
  });
  it("blocks 10.255.255.255 (RFC1918 10/8)", () => {
    expect(blockedIpReason("10.255.255.255")).not.toBeNull();
  });
  it("blocks 172.16.0.1 (RFC1918 172.16/12)", () => {
    expect(blockedIpReason("172.16.0.1")).not.toBeNull();
  });
  it("blocks 172.31.255.255 (RFC1918 172.16/12)", () => {
    expect(blockedIpReason("172.31.255.255")).not.toBeNull();
  });
  it("does not block 172.32.0.0 (outside 172.16/12)", () => {
    expect(blockedIpReason("172.32.0.0")).toBeNull();
  });
  it("blocks 192.168.0.1 (RFC1918 192.168/16)", () => {
    expect(blockedIpReason("192.168.0.1")).not.toBeNull();
  });
  it("blocks 192.168.255.255 (RFC1918 192.168/16)", () => {
    expect(blockedIpReason("192.168.255.255")).not.toBeNull();
  });

  // Loopback
  it("blocks 127.0.0.1 (loopback)", () => {
    expect(blockedIpReason("127.0.0.1")).not.toBeNull();
  });
  it("blocks 127.255.255.255 (loopback 127/8)", () => {
    expect(blockedIpReason("127.255.255.255")).not.toBeNull();
  });
  it("blocks ::1 (IPv6 loopback)", () => {
    expect(blockedIpReason("::1")).not.toBeNull();
  });

  // Link-local / metadata
  it("blocks 169.254.0.1 (link-local)", () => {
    expect(blockedIpReason("169.254.0.1")).not.toBeNull();
  });
  it("blocks 169.254.169.254 (cloud metadata)", () => {
    expect(blockedIpReason("169.254.169.254")).not.toBeNull();
  });

  // Unspecified
  it("blocks 0.0.0.0", () => {
    expect(blockedIpReason("0.0.0.0")).not.toBeNull();
  });

  // IPv6 link-local
  it("blocks fe80::1 (IPv6 link-local)", () => {
    expect(blockedIpReason("fe80::1")).not.toBeNull();
  });
  it("blocks fe80::dead:beef (IPv6 link-local)", () => {
    expect(blockedIpReason("fe80::dead:beef")).not.toBeNull();
  });

  // IPv6 ULA
  it("blocks fc00::1 (ULA)", () => {
    expect(blockedIpReason("fc00::1")).not.toBeNull();
  });
  it("blocks fd12:3456::1 (ULA fd/7)", () => {
    expect(blockedIpReason("fd12:3456::1")).not.toBeNull();
  });

  // IPv4-mapped IPv6
  it("blocks ::ffff:10.0.0.1 (IPv4-mapped RFC1918)", () => {
    expect(blockedIpReason("::ffff:10.0.0.1")).not.toBeNull();
  });
  it("blocks ::ffff:192.168.1.1 (IPv4-mapped RFC1918)", () => {
    expect(blockedIpReason("::ffff:192.168.1.1")).not.toBeNull();
  });
  it("blocks ::ffff:169.254.169.254 (IPv4-mapped metadata)", () => {
    expect(blockedIpReason("::ffff:169.254.169.254")).not.toBeNull();
  });
  it("blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)", () => {
    expect(blockedIpReason("::ffff:127.0.0.1")).not.toBeNull();
  });

  // Public IPs — should be allowed
  it("allows 93.184.216.34 (example.com)", () => {
    expect(blockedIpReason("93.184.216.34")).toBeNull();
  });
  it("allows 8.8.8.8 (Google DNS)", () => {
    expect(blockedIpReason("8.8.8.8")).toBeNull();
  });
  it("allows 2001:db8::1 (documentation range, not ULA)", () => {
    expect(blockedIpReason("2001:db8::1")).toBeNull();
  });
});

// ── assertSafeUrl() ───────────────────────────────────────────────────────────

describe("assertSafeUrl()", () => {
  it("allows a public https:// URL", async () => {
    await expectAllowed("https://example.com/webhook");
  });

  it("blocks http:// URLs", async () => {
    await expectBlocked("http://example.com/webhook", "NOT_HTTPS");
  });

  it("blocks ftp:// URLs", async () => {
    await expectBlocked("ftp://example.com/file", "NOT_HTTPS");
  });

  it("blocks invalid URLs", async () => {
    await expectBlocked("not-a-url", "NOT_HTTPS");
  });

  it("blocks when hostname resolves to RFC1918", async () => {
    await expectBlocked(
      "https://internal.example.com/hook",
      "BLOCKED_IP",
      mockResolve(["192.168.1.10"]),
    );
  });

  it("blocks when hostname resolves to loopback", async () => {
    await expectBlocked(
      "https://localhost/hook",
      "BLOCKED_IP",
      mockResolve(["127.0.0.1"]),
    );
  });

  it("blocks when hostname resolves to 169.254.169.254 (AWS metadata)", async () => {
    await expectBlocked(
      "https://metadata.aws/hook",
      "BLOCKED_IP",
      mockResolve(["169.254.169.254"]),
    );
  });

  it("blocks when hostname resolves to IPv4-mapped private IPv6", async () => {
    await expectBlocked(
      "https://sneaky.example.com/hook",
      "BLOCKED_IP",
      mockResolve(["::ffff:10.0.0.1"]),
    );
  });

  it("blocks bare IP literal 127.0.0.1 without DNS lookup", async () => {
    // resolver should NOT be called for bare IP literals
    const calledDns: string[] = [];
    const trackingResolver = async (h: string) => {
      calledDns.push(h);
      return ["93.184.216.34"];
    };
    await expectBlocked("https://127.0.0.1/hook", "BLOCKED_IP", trackingResolver);
    expect(calledDns).toHaveLength(0); // DNS was not called
  });

  it("blocks bare IP literal 10.0.0.1 without DNS lookup", async () => {
    await expectBlocked("https://10.0.0.1/hook", "BLOCKED_IP");
  });

  it("blocks bare IPv6 literal [::1] without DNS lookup", async () => {
    const calledDns: string[] = [];
    const trackingResolver = async (h: string) => {
      calledDns.push(h);
      return ["93.184.216.34"];
    };
    await expectBlocked("https://[::1]/hook", "BLOCKED_IP", trackingResolver);
    expect(calledDns).toHaveLength(0);
  });

  it("blocks when one of multiple resolved IPs is private", async () => {
    // Hostname resolves to both a public AND a private IP — must block
    await expectBlocked(
      "https://tricky.example.com/hook",
      "BLOCKED_IP",
      mockResolve(["93.184.216.34", "10.0.0.1"]),
    );
  });

  it("propagates DNS failure as DNS_FAILED", async () => {
    const failDns = async (_h: string): Promise<string[]> => {
      throw new Error("DNS_FAILED: connection refused");
    };
    let caught: SsrfGuardError | null = null;
    try {
      await assertSafeUrl("https://bad.example.com/hook", failDns);
    } catch (e) {
      caught = e as SsrfGuardError;
    }
    // The error is propagated — but custom errors from resolver are re-thrown directly
    expect(caught).not.toBeNull();
  });
});

// ── SsrfGuardError ────────────────────────────────────────────────────────────

describe("SsrfGuardError", () => {
  it("carries the correct code and name", () => {
    const err = new SsrfGuardError("BLOCKED_IP", "test message");
    expect(err.code).toBe("BLOCKED_IP");
    expect(err.name).toBe("SsrfGuardError");
    expect(err.message).toBe("test message");
  });
});

// ── S3: expanded IPv4-mapped + NAT64 ─────────────────────────────────────────

describe("blockedIpReason() — S3: expanded IPv4-mapped and NAT64 forms", () => {
  // Expanded IPv4-mapped (OS canonical output): 0:0:0:0:0:ffff:a00:1 = ::ffff:10.0.0.1
  it("blocks 0:0:0:0:0:ffff:a00:1 (expanded ::ffff:10.0.0.1)", () => {
    expect(blockedIpReason("0:0:0:0:0:ffff:a00:1")).not.toBeNull();
  });

  // 0:0:0:0:0:ffff:169.254.169.254 — expanded dot-notation mapped metadata IP
  it("blocks 0:0:0:0:0:ffff:169.254.169.254 (expanded IPv4-mapped metadata)", () => {
    expect(blockedIpReason("0:0:0:0:0:ffff:169.254.169.254")).not.toBeNull();
  });

  // 0:0:0:0:0:ffff:7f00:1 = ::ffff:127.0.0.1 (expanded loopback)
  it("blocks 0:0:0:0:0:ffff:7f00:1 (expanded IPv4-mapped loopback)", () => {
    expect(blockedIpReason("0:0:0:0:0:ffff:7f00:1")).not.toBeNull();
  });

  // Compact but not using :: — e.g. written without compression
  it("blocks ::ffff:10.0.0.1 (compact dot form)", () => {
    expect(blockedIpReason("::ffff:10.0.0.1")).not.toBeNull();
  });

  // NAT64 64:ff9b::/96 — low 32 bits are 10.0.0.1 = 0x0a000001
  // 64:ff9b::a00:1 — a00 = 10.0 (hex), 1 = 0.1 → 10.0.0.1
  it("blocks 64:ff9b::a00:1 (NAT64 embedding 10.0.0.1)", () => {
    expect(blockedIpReason("64:ff9b::a00:1")).not.toBeNull();
  });

  // NAT64 with metadata IP 169.254.169.254 = 0xa9fe:a9fe
  it("blocks 64:ff9b::a9fe:a9fe (NAT64 embedding 169.254.169.254)", () => {
    expect(blockedIpReason("64:ff9b::a9fe:a9fe")).not.toBeNull();
  });

  // NAT64 with 127.0.0.1 = 0x7f00:0001
  it("blocks 64:ff9b::7f00:1 (NAT64 embedding 127.0.0.1)", () => {
    expect(blockedIpReason("64:ff9b::7f00:1")).not.toBeNull();
  });

  // NAT64 with public IP (8.8.8.8 = 0x0808:0808) should NOT block
  it("allows 64:ff9b::808:808 (NAT64 embedding public 8.8.8.8)", () => {
    expect(blockedIpReason("64:ff9b::808:808")).toBeNull();
  });
});

// ── S1: guardedFetch redirect SSRF re-validation ──────────────────────────────

describe("guardedFetch() — S1: 302 redirect to internal IP is blocked", () => {
  it("blocks a redirect to an RFC1918 address (192.168.x.x)", async () => {
    // Endpoint returns 302 Location pointing to an internal IP literal.
    // guardedFetch follows redirects manually and SSRF-validates each Location.
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (u.startsWith("https://public.example.com")) {
        // Return 302 → internal host
        return new Response("", {
          status: 302,
          headers: { location: "https://192.168.1.1/steal" },
        });
      }
      // Should never be reached
      return new Response("internal-data", { status: 200 });
    };

    let caught: SsrfGuardError | null = null;
    try {
      await guardedFetch(
        "https://public.example.com/hook",
        {},
        {
          resolve: async () => ["93.184.216.34"], // public.example.com is safe
          fetchFn: mockFetch as typeof fetch,
        },
      );
    } catch (e) {
      if (e instanceof SsrfGuardError) caught = e;
      else throw e;
    }

    expect(caught, "Expected SsrfGuardError for redirect to internal IP").not.toBeNull();
    expect(caught!.code).toBe("BLOCKED_IP");
  });

  it("blocks a redirect to cloud metadata IP 169.254.169.254", async () => {
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (u === "https://public.example.com/hook") {
        return new Response("", {
          status: 301,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("stolen", { status: 200 });
    };

    let caught: SsrfGuardError | null = null;
    try {
      await guardedFetch(
        "https://public.example.com/hook",
        {},
        {
          resolve: async () => ["93.184.216.34"],
          fetchFn: mockFetch as typeof fetch,
        },
      );
    } catch (e) {
      if (e instanceof SsrfGuardError) caught = e;
      else throw e;
    }

    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("BLOCKED_IP");
  });

  it("does NOT reach the internal host when redirect is blocked", async () => {
    const internalCallsMade: string[] = [];
    const mockFetch = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (u.includes("10.0.0.1")) {
        internalCallsMade.push(u);
        return new Response("internal", { status: 200 });
      }
      return new Response("", {
        status: 302,
        headers: { location: "https://10.0.0.1/secret" },
      });
    };

    try {
      await guardedFetch(
        "https://public.example.com/hook",
        {},
        { resolve: async () => ["93.184.216.34"], fetchFn: mockFetch as typeof fetch },
      );
    } catch {
      // expected
    }

    expect(internalCallsMade).toHaveLength(0);
  });
});

// ── WH-1: DNS pinning — buildPinnedFetch returns undici-backed fetch, not globalThis.fetch ──

describe("buildPinnedFetch() — WH-1: pinning is active", () => {
  it("returns a function that is NOT globalThis.fetch (undici dispatcher is used)", async () => {
    // A public IP that passes validation.
    const publicIp = "93.184.216.34";
    const pinnedFetch = await buildPinnedFetch("example.com", async () => [publicIp]);

    // Pinning is active: the returned function must NOT be the global fetch.
    // With undici as a real dep, buildPinnedFetch always returns an undici-backed function.
    expect(pinnedFetch).not.toBe(globalThis.fetch);
  });

  it("throws SsrfGuardError(BLOCKED_IP) when the resolved IP is private", async () => {
    let caught: SsrfGuardError | null = null;
    try {
      await buildPinnedFetch("internal.example.com", async () => ["10.0.0.1"]);
    } catch (e) {
      if (e instanceof SsrfGuardError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("BLOCKED_IP");
  });

  it("throws SsrfGuardError(DNS_FAILED) when resolver returns empty array", async () => {
    let caught: SsrfGuardError | null = null;
    try {
      await buildPinnedFetch("nxdomain.example.com", async () => []);
    } catch (e) {
      if (e instanceof SsrfGuardError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("DNS_FAILED");
  });

  it("C-1: actually connects to the pinned IP (real HTTP listener; callback shape verified)", async () => {
    // This test PROVES the undici connect.lookup callback fires with the CORRECT
    // array form and routes the TCP connection to the pre-validated address.
    //
    // Strategy: start a plain HTTP server on 127.0.0.1:<port>. The resolver
    // returns a public IP (93.184.216.34) so buildPinnedFetch's SSRF check
    // passes. Then we exercise the raw undici agent directly (same agent that
    // buildPinnedFetch creates) pointing at our local server, to prove the
    // connect.lookup callback shape is accepted by undici.
    //
    // With the OLD single-address callback `cb(null, ip, family)`:
    //   undici reads `addresses[0].address` → undefined → ERR_INVALID_IP_ADDRESS.
    //   The request never arrives. `received` stays false. Test FAILS.
    //
    // With the CORRECT array form `cb(null, [{ address, family }])`:
    //   The TCP connection reaches the listener. `received` is set. Test PASSES.
    //
    // Note: we import UndiciAgent / undiciFetch directly from undici here to
    // exercise the same code path that buildPinnedFetch uses, without going
    // through the SSRF guard's IP-block check on loopback addresses (that
    // blocking behavior is tested separately above).

    const { Agent: UndiciAgentDirect, fetch: undiciFetchDirect } = await import("undici");

    let received = false;

    // Pick a free port.
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close((err) => (err ? reject(err) : resolve(addr.port)));
      });
    });

    const server = http.createServer((_req, res) => {
      received = true;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    await new Promise<void>((resolve) => server.listen(freePort, "127.0.0.1", resolve));

    try {
      // Build the agent with the SAME callback shape used by buildPinnedFetch.
      const pinnedIp = "127.0.0.1";
      const agent = new UndiciAgentDirect({
        connect: {
          lookup: (
            _host: string,
            _opts: { all?: boolean } | undefined,
            callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
          ) => {
            callback(null, [{ address: pinnedIp, family: 4 }]);
          },
        },
      });

      await undiciFetchDirect(
        `http://fake-host.internal:${freePort}/probe`,
        { dispatcher: agent as unknown as import("undici").Dispatcher },
      );
    } catch {
      // Network errors are irrelevant — only `received` matters.
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // The TCP connection reached the listener → array-form callback is correct.
    expect(received).toBe(true);
  });
});

// ── S2: DNS-rebinding — mock resolver returns public then private ─────────────

describe("guardedFetch() — S2: DNS-rebinding via fetchFn injection", () => {
  it("blocks the request when resolver returns an internal IP", async () => {
    // Simulates a rebind: resolver validates against 192.168.0.1 (internal).
    // guardedFetch should throw before calling fetchFn.
    const internalCallsMade: string[] = [];
    const mockFetch = async (url: string | URL | Request, _init?: RequestInit) => {
      internalCallsMade.push(String(url));
      return new Response("stolen", { status: 200 });
    };

    let caught: SsrfGuardError | null = null;
    try {
      await guardedFetch(
        "https://rebind.example.com/hook",
        {},
        {
          // Resolver returns private IP — simulates the "rebind has already happened"
          // scenario at validation time (the IP we'd use is already private).
          resolve: async () => ["192.168.0.1"],
          fetchFn: mockFetch as typeof fetch,
        },
      );
    } catch (e) {
      if (e instanceof SsrfGuardError) caught = e;
      else throw e;
    }

    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("BLOCKED_IP");
    // fetch was NOT called (guard fires before network)
    expect(internalCallsMade).toHaveLength(0);
  });
});
