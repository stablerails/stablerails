/**
 * RateLimiter — sliding window + unbounded-memory eviction (pre-deploy hardening).
 */

import { describe, it, expect } from "vitest";
import { RateLimiter, type RateLimitClock } from "../rate-limit.js";

function fakeClock(start = 1_000_000): RateLimitClock & { advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const BUCKETS = {
  public_status: { maxRequests: 3, windowMs: 60_000 },
  login: { maxRequests: 10, windowMs: 600_000 },
};

describe("RateLimiter — sliding window", () => {
  it("allows up to maxRequests then denies within the window", () => {
    const clock = fakeClock();
    const rl = new RateLimiter(BUCKETS, clock);
    expect(rl.check("public_status", "inv1")).toBe(true);
    expect(rl.check("public_status", "inv1")).toBe(true);
    expect(rl.check("public_status", "inv1")).toBe(true);
    expect(rl.check("public_status", "inv1")).toBe(false); // 4th in window
  });

  it("permits again after the window slides", () => {
    const clock = fakeClock();
    const rl = new RateLimiter(BUCKETS, clock);
    for (let i = 0; i < 3; i++) rl.check("public_status", "inv1");
    expect(rl.check("public_status", "inv1")).toBe(false);
    clock.advance(60_001);
    expect(rl.check("public_status", "inv1")).toBe(true);
  });

  it("keys are independent per entity", () => {
    const clock = fakeClock();
    const rl = new RateLimiter(BUCKETS, clock);
    for (let i = 0; i < 3; i++) rl.check("public_status", "a");
    expect(rl.check("public_status", "a")).toBe(false);
    expect(rl.check("public_status", "b")).toBe(true);
  });
});

describe("RateLimiter — memory bound (eviction of abandoned keys)", () => {
  it("never stores an empty window", () => {
    const clock = fakeClock();
    const rl = new RateLimiter(BUCKETS, clock);
    rl.check("public_status", "inv1");
    expect(rl.size()).toBe(1);
    // Far past the window, a *single* re-check must not leave 2 entries.
    clock.advance(120_000);
    rl.check("public_status", "inv1");
    expect(rl.size()).toBe(1);
  });

  it("sweeps abandoned distinct keys after the window passes", () => {
    const clock = fakeClock();
    const rl = new RateLimiter(BUCKETS, clock);
    // Simulate the attack: 1000 distinct, never-revisited keys.
    for (let i = 0; i < 1000; i++) rl.check("public_status", `junk-${i}`);
    expect(rl.size()).toBe(1000);
    // After the window elapses, the next request triggers a sweep that reclaims
    // all 1000 expired windows (memory cannot grow unbounded).
    clock.advance(60_001);
    rl.check("public_status", "real");
    expect(rl.size()).toBe(1); // only the live key remains
  });

  it("sweep does not evict still-live windows", () => {
    const clock = fakeClock();
    const rl = new RateLimiter(BUCKETS, clock);
    rl.check("login", "ip-a"); // 10-min window — still live after 60s
    for (let i = 0; i < 50; i++) rl.check("public_status", `j-${i}`);
    clock.advance(60_001); // public_status windows expire; login does not
    rl.check("public_status", "trigger-sweep");
    // login key survives, expired public_status keys gone, +1 live trigger key.
    expect(rl.size()).toBe(2);
  });
});
