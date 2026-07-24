import { NextResponse } from "next/server";
import { prisma } from "@affiliate/database";
import { getRedisHealth } from "@affiliate/redis";

type HealthCheck = {
  status: "ok" | "error" | "skipped";
  configured?: boolean;
  message?: string | undefined;
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

  const redis = await getRedisHealth();
  checks.redis = {
    status: redis.status === "ok" ? "ok" : redis.status === "unavailable" ? "skipped" : "error",
    configured: redis.mode !== "unavailable",
    message: redis.message,
  };

  const status = Object.values(checks).some((check) => check.status === "error") ? 503 : 200;

  return NextResponse.json(
    {
      status: status === 200 ? "ok" : "error",
      checks,
    },
    { status },
  );
}
