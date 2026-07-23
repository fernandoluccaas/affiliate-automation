import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { Redis } from "@upstash/redis";

export type RedisMode = "upstash" | "redis-url" | "unavailable";

export type RedisHealth = {
  mode: RedisMode;
  status: "ok" | "unavailable" | "error";
  message?: string;
};

export type LockHandle = {
  key: string;
  token: string;
  acquired: boolean;
  mode: RedisMode;
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

      if (buffer.length > 0) {
        finish(undefined, buffer);
      }
    });
    socket.connect(port, host, () => {
      if (url.password) {
        socket.write(encodeCommand(["AUTH", decodeURIComponent(url.password)]));
      }

      socket.write(encodeCommand(args));
    });
  });
}

function redisOk(reply: string) {
  return reply.startsWith("+OK") || reply.startsWith("+PONG") || reply.startsWith(":1");
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
      : { mode: "redis-url", status: "error", message: "Unexpected Redis ping reply." };
  } catch (error) {
    return {
      mode: config.mode,
      status: "error",
      message: error instanceof Error ? error.message : "Redis check failed.",
    };
  }
}

export async function acquireLock(key: string, ttlMs: number): Promise<LockHandle> {
  const config = getRedisConfig();
  const token = randomUUID();

  if (config.mode === "unavailable") {
    return {
      key,
      token,
      acquired: true,
      mode: "unavailable",
      release: async () => undefined,
    };
  }

  if (config.mode === "upstash") {
    const redis = new Redis({ url: config.url, token: config.token });
    const result = await redis.set(key, token, { nx: true, px: ttlMs });

    return {
      key,
      token,
      acquired: result === "OK",
      mode: "upstash",
      release: async () => {
        const current = await redis.get<string>(key);

        if (current === token) {
          await redis.del(key);
        }
      },
    };
  }

  const result = await redisUrlCommand(config.url, ["SET", key, token, "NX", "PX", ttlMs]);

  return {
    key,
    token,
    acquired: result.startsWith("+OK"),
    mode: "redis-url",
    release: async () => {
      await redisUrlCommand(config.url, [
        "EVAL",
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token,
      ]);
    },
  };
}
