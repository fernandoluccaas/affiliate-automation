import { describe, expect, it } from "vitest";
import { acquireLock, getRedisHealth } from "./index";

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("redis abstraction", () => {
  it("reports unavailable when Redis is not configured", async () => {
    const previousUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.REDIS_URL;

    await expect(getRedisHealth()).resolves.toMatchObject({
      mode: "unavailable",
      status: "unavailable",
    });

    restoreEnv("UPSTASH_REDIS_REST_URL", previousUpstashUrl);
    restoreEnv("UPSTASH_REDIS_REST_TOKEN", previousUpstashToken);
    restoreEnv("REDIS_URL", previousRedisUrl);
  });

  it("allows local execution without configured Redis", async () => {
    const previousUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.REDIS_URL;

    const lock = await acquireLock("test-lock", 1000);

    expect(lock.acquired).toBe(true);
    expect(lock.mode).toBe("unavailable");
    await expect(lock.extend(1000)).resolves.toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();

    restoreEnv("UPSTASH_REDIS_REST_URL", previousUpstashUrl);
    restoreEnv("UPSTASH_REDIS_REST_TOKEN", previousUpstashToken);
    restoreEnv("REDIS_URL", previousRedisUrl);
  });
});
