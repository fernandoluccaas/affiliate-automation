import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  OWNED_LOCK_EXTEND_SCRIPT,
  OWNED_LOCK_RELEASE_SCRIPT,
  acquireLock,
  getRedisHealth,
  type AtomicRedisClient,
} from "./index";

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("redis abstraction", () => {
  function atomicClient() {
    let value: string | null = null;
    let ttlMs = 0;
    const client: AtomicRedisClient = {
      set: async (_key, token, options) => {
        if (value !== null) return null;
        value = token;
        ttlMs = options.px;
        return "OK";
      },
      eval: async (script, _keys, args) => {
        const [owner, nextTtl] = args;
        if (value !== owner) return 0;
        if (script === OWNED_LOCK_RELEASE_SCRIPT) {
          value = null;
          return 1;
        }
        if (script === OWNED_LOCK_EXTEND_SCRIPT) {
          ttlMs = Number(nextTtl);
          return 1;
        }
        throw new Error("UNEXPECTED_SCRIPT");
      },
    };
    return {
      client,
      replaceOwner(next: string, nextTtlMs: number) {
        value = next;
        ttlMs = nextTtlMs;
      },
      state: () => ({ value, ttlMs }),
    };
  }

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
    expect(lock.failureReason).toBe("REDIS_UNAVAILABLE");
    await expect(lock.extend(1000)).resolves.toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();

    restoreEnv("UPSTASH_REDIS_REST_URL", previousUpstashUrl);
    restoreEnv("UPSTASH_REDIS_REST_TOKEN", previousUpstashToken);
    restoreEnv("REDIS_URL", previousRedisUrl);
  });

  it("does not pretend to acquire a lock when Redis is required", async () => {
    const lock = await acquireLock("required-lock", 1000, {
      env: { WORKER_REQUIRE_REDIS: "true" },
    });

    expect(lock).toMatchObject({
      acquired: false,
      mode: "unavailable",
      failureReason: "REDIS_UNAVAILABLE",
    });
    await expect(lock.extend(1000)).resolves.toBe(false);
  });

  it("identifies an unavailable configured backend without exposing its URL", async () => {
    const lock = await acquireLock("required-lock", 1000, {
      env: {
        WORKER_REQUIRE_REDIS: "true",
        REDIS_URL: "redis://127.0.0.1:1/secret-database",
      },
    });

    expect(lock).toMatchObject({
      acquired: false,
      mode: "redis-url",
      failureReason: "REDIS_UNAVAILABLE",
    });
    expect(JSON.stringify(lock)).not.toContain("secret-database");
  });

  it("keeps configured Redis permissive in optional development mode", async () => {
    const lock = await acquireLock("optional-lock", 1000, {
      env: {
        WORKER_REQUIRE_REDIS: "false",
        REDIS_URL: "redis://127.0.0.1:1",
      },
    });

    expect(lock).toMatchObject({
      acquired: true,
      mode: "redis-url",
      failureReason: "REDIS_UNAVAILABLE",
    });
  });

  it("uses the command reply after AUTH when deciding lock ownership", async () => {
    const commands: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        const command = chunk.toString("utf8");
        commands.push(command);
        socket.write(command.includes("AUTH") ? "+OK\r\n" : "$-1\r\n");
      });
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_FAILED");

    try {
      const lock = await acquireLock("authenticated-lock", 1_000, {
        env: {
          WORKER_REQUIRE_REDIS: "true",
          REDIS_URL: `redis://:test-password@127.0.0.1:${address.port}`,
        },
      });
      expect(lock.acquired).toBe(false);
      expect(lock.failureReason).toBe("LOCK_ALREADY_HELD");
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain("AUTH");
      expect(commands[1]).toContain("SET");
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("does not release a replacement Upstash owner after the first lock expires", async () => {
    const redis = atomicClient();
    const lockA = await acquireLock("race-release", 1_000, {
      env: {
        WORKER_REQUIRE_REDIS: "true",
        UPSTASH_REDIS_REST_URL: "https://test.upstash.invalid",
        UPSTASH_REDIS_REST_TOKEN: "test-only",
      },
      upstashClient: redis.client,
    });
    redis.replaceOwner("owner-b", 9_000);

    await lockA.release();

    expect(redis.state()).toEqual({ value: "owner-b", ttlMs: 9_000 });
  });

  it("does not extend a replacement Upstash owner with the stale token", async () => {
    const redis = atomicClient();
    const lockA = await acquireLock("race-extend", 1_000, {
      env: {
        WORKER_REQUIRE_REDIS: "true",
        UPSTASH_REDIS_REST_URL: "https://test.upstash.invalid",
        UPSTASH_REDIS_REST_TOKEN: "test-only",
      },
      upstashClient: redis.client,
    });
    redis.replaceOwner("owner-b", 9_000);

    await expect(lockA.extend(30_000)).resolves.toBe(false);
    expect(redis.state()).toEqual({ value: "owner-b", ttlMs: 9_000 });
  });
});
