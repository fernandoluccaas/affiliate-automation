import { afterEach, describe, expect, it, vi } from "vitest";
import type { LockHandle } from "@affiliate/redis";
import { startOwnedLockHeartbeat } from "./index";

afterEach(() => {
  vi.useRealTimers();
});

describe("owned discovery lock heartbeat", () => {
  it("marks ownership as lost when Redis refuses the extension", async () => {
    vi.useFakeTimers();
    const lock: LockHandle = {
      key: "discovery:test",
      token: "owner",
      acquired: true,
      mode: "redis-url",
      extend: vi.fn().mockResolvedValue(false),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const heartbeat = startOwnedLockHeartbeat(lock, 10_000, 10);

    await vi.advanceTimersByTimeAsync(11);

    expect(heartbeat.isLost()).toBe(true);
    expect(() => heartbeat.assertOwned()).toThrow("DISCOVERY_LOCK_LOST");
    heartbeat.stop();
  });

  it("keeps ownership while extensions succeed", async () => {
    vi.useFakeTimers();
    const lock: LockHandle = {
      key: "discovery:test",
      token: "owner",
      acquired: true,
      mode: "redis-url",
      extend: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const heartbeat = startOwnedLockHeartbeat(lock, 10_000, 10);

    await vi.advanceTimersByTimeAsync(11);

    expect(heartbeat.isLost()).toBe(false);
    expect(() => heartbeat.assertOwned()).not.toThrow();
    heartbeat.stop();
  });
});
