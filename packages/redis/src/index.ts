import { createHash, randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { Redis } from "@upstash/redis";

export const OWNED_LOCK_EXTEND_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
export const OWNED_LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type AtomicRedisClient = {
  set(
    key: string,
    value: string,
    options: { nx: true; px: number },
  ): Promise<unknown>;
  eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown>;
};

export type RedisMode = "upstash" | "redis-url" | "unavailable";

export type RedisHealth = {
  mode: RedisMode;
  status: "ok" | "unavailable" | "error";
  message?: string;
};

export type RedisKeyFingerprint = {
  mode: RedisMode;
  exists: boolean;
  fingerprint: string | null;
};

export type LockHandle = {
  key: string;
  token: string;
  acquired: boolean;
  mode: RedisMode;
  failureReason?: "REDIS_UNAVAILABLE" | "LOCK_ALREADY_HELD";
  extend(ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
};

type RedisConfig =
  | { mode: "upstash"; url: string; token: string }
  | { mode: "redis-url"; url: string }
  | { mode: "unavailable" };

function getRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      mode: "upstash",
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    };
  }

  if (env.REDIS_URL) {
    return { mode: "redis-url", url: env.REDIS_URL };
  }

  return { mode: "unavailable" };
}

function encodeCommand(args: Array<string | number>) {
  return `*${args.length}\r\n${args
    .map((arg) => {
      const value = String(arg);
      return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    })
    .join("")}`;
}

async function redisUrlCommand(urlValue: string, args: Array<string | number>) {
  const url = new URL(urlValue);
  const host = url.hostname;
  const port = Number(url.port || 6379);

  return new Promise<string>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    let buffer = "";
    let authenticated = !url.password;

    const timeout = setTimeout(() => {
      finish(new Error("Redis command timed out."));
    }, 3000);

    function finish(error?: Error, value?: string) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(value ?? buffer);
      }
    }

    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!authenticated) {
        const replyEnd = buffer.indexOf("\r\n");
        if (replyEnd < 0) return;
        const authReply = buffer.slice(0, replyEnd + 2);
        buffer = buffer.slice(replyEnd + 2);
        if (!authReply.startsWith("+OK")) {
          finish(new Error("Redis authentication failed."));
          return;
        }
        authenticated = true;
        socket.write(encodeCommand(args));
        return;
      }

      if (buffer.length > 0) {
        finish(undefined, buffer);
      }
    });
    socket.connect(port, host, () => {
      if (url.password) {
        socket.write(encodeCommand(["AUTH", decodeURIComponent(url.password)]));
      } else {
        socket.write(encodeCommand(args));
      }
    });
  });
}

function redisOk(reply: string) {
  return (
    reply.startsWith("+OK") ||
    reply.startsWith("+PONG") ||
    reply.startsWith(":1")
  );
}

export async function getRedisHealth(): Promise<RedisHealth> {
  const config = getRedisConfig();

  if (config.mode === "unavailable") {
    return { mode: "unavailable", status: "unavailable" };
  }

  try {
    if (config.mode === "upstash") {
      const redis = new Redis({ url: config.url, token: config.token });
      await redis.ping();
      return { mode: "upstash", status: "ok" };
    }

    const reply = await redisUrlCommand(config.url, ["PING"]);
    return redisOk(reply)
      ? { mode: "redis-url", status: "ok" }
      : {
          mode: "redis-url",
          status: "error",
          message: "Unexpected Redis ping reply.",
        };
  } catch (error) {
    return {
      mode: config.mode,
      status: "error",
      message: error instanceof Error ? error.message : "Redis check failed.",
    };
  }
}

export async function getRedisKeyFingerprint(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RedisKeyFingerprint> {
  const config = getRedisConfig(env);
  if (config.mode === "unavailable") {
    return { mode: "unavailable", exists: false, fingerprint: null };
  }
  let value: string | null = null;
  if (config.mode === "upstash") {
    const redis = new Redis({ url: config.url, token: config.token });
    value = await redis.get<string>(key);
  } else {
    const reply = await redisUrlCommand(config.url, ["GET", key]);
    if (!reply.startsWith("$-1")) {
      const separator = reply.indexOf("\r\n");
      value = separator >= 0 ? reply.slice(separator + 2).replace(/\r\n$/, "") : null;
    }
  }
  return {
    mode: config.mode,
    exists: value !== null,
    fingerprint: value
      ? createHash("sha256").update(value).digest("hex")
      : null,
  };
}

export async function acquireLock(
  key: string,
  ttlMs: number,
  options: {
    env?: NodeJS.ProcessEnv;
    requireRedis?: boolean;
    upstashClient?: AtomicRedisClient;
  } = {},
): Promise<LockHandle> {
  const env = options.env ?? process.env;
  const config = getRedisConfig(env);
  const token = randomUUID();
  const requireRedis =
    options.requireRedis ?? env.WORKER_REQUIRE_REDIS === "true";

  if (config.mode === "unavailable") {
    return {
      key,
      token,
      acquired: !requireRedis,
      mode: "unavailable",
      failureReason: "REDIS_UNAVAILABLE",
      extend: async () => !requireRedis,
      release: async () => undefined,
    };
  }

  if (config.mode === "upstash") {
    try {
      const redis: AtomicRedisClient =
        options.upstashClient ?? new Redis({ url: config.url, token: config.token });
      const result = await redis.set(key, token, { nx: true, px: ttlMs });

      return {
        key,
        token,
        acquired: result === "OK",
        mode: "upstash",
        ...(result === "OK"
          ? {}
          : { failureReason: "LOCK_ALREADY_HELD" as const }),
        extend: async (nextTtlMs) => {
          const extended = await redis.eval(
            OWNED_LOCK_EXTEND_SCRIPT,
            [key],
            [token, nextTtlMs],
          );

          return Number(extended) === 1;
        },
        release: async () => {
          await redis.eval(OWNED_LOCK_RELEASE_SCRIPT, [key], [token]);
        },
      };
    } catch {
      return unavailableLock(key, token, "upstash", requireRedis);
    }
  }

  try {
    const result = await redisUrlCommand(config.url, [
      "SET",
      key,
      token,
      "NX",
      "PX",
      ttlMs,
    ]);

    return {
      key,
      token,
      acquired: result.startsWith("+OK"),
      mode: "redis-url",
      ...(result.startsWith("+OK")
        ? {}
        : { failureReason: "LOCK_ALREADY_HELD" as const }),
      extend: async (nextTtlMs) => {
        const reply = await redisUrlCommand(config.url, [
          "EVAL",
          OWNED_LOCK_EXTEND_SCRIPT,
          1,
          key,
          token,
          nextTtlMs,
        ]);

        return reply.startsWith(":1");
      },
      release: async () => {
        await redisUrlCommand(config.url, [
          "EVAL",
          OWNED_LOCK_RELEASE_SCRIPT,
          1,
          key,
          token,
        ]);
      },
    };
  } catch {
    return unavailableLock(key, token, "redis-url", requireRedis);
  }
}

function unavailableLock(
  key: string,
  token: string,
  mode: RedisMode,
  requireRedis: boolean,
): LockHandle {
  return {
    key,
    token,
    acquired: !requireRedis,
    mode,
    failureReason: "REDIS_UNAVAILABLE",
    extend: async () => !requireRedis,
    release: async () => undefined,
  };
}
