import { NextResponse } from "next/server";
import { collectOperationalStatus } from "@affiliate/operations";

export async function GET() {
  try {
    const status = await collectOperationalStatus();
    return NextResponse.json(
      {
        status: status.status,
        checks: {
          application: "LIVE",
          postgresql: status.database,
          redis: status.redis,
          migrations: status.migrations.status,
          worker: status.worker.state,
        },
      },
      { status: status.status === "READY" ? 200 : 503 },
    );
  } catch {
    return NextResponse.json(
      { status: "NOT_READY", errorCode: "HEALTH_CHECK_FAILED" },
      { status: 503 },
    );
  }
}
