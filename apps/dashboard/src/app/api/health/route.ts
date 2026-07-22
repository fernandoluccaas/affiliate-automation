import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { prisma } from "@affiliate/database";

type HealthCheck = {
  status: "ok" | "error" | "skipped";
  configured?: boolean;
  message?: string;
};

export async function GET() {
  const checks: Record<string, HealthCheck> = {
    application: { status: "ok" },
    postgresql: { status: "ok" },
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    checks.postgresql = {
      status: "error",
      message: error instanceof Error ? error.message : "PostgreSQL check failed.",
    };
  }

  const redisConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );

  if (redisConfigured) {
    try {
      const redis = Redis.fromEnv();
      await redis.ping();
      checks.redis = { status: "ok", configured: true };
    } catch (error) {
      checks.redis = {
        status: "error",
        configured: true,
        message: error instanceof Error ? error.message : "Redis check failed.",
      };
    }
  } else {
    checks.redis = { status: "skipped", configured: false };
  }

  const status = Object.values(checks).some((check) => check.status === "error") ? 503 : 200;

  return NextResponse.json(
    {
      status: status === 200 ? "ok" : "error",
      checks,
    },
    { status },
  );
}
