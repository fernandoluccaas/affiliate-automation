import { NextResponse } from "next/server";
import { collectOperationalStatus } from "@affiliate/operations";

export async function GET() {
  try {
    const status = await collectOperationalStatus();
    return NextResponse.json(
      {
        status: status.status,
        checkedAt: status.checkedAt,
        mode: status.worker.mode,
        burnInActive: status.worker.burnInActive,
        leadership: status.worker.leaderStatus,
        blockedCycles: status.worker.blockedCycles,
        externalEffectsObserved: status.worker.externalEffectsObserved,
        businessChangesObserved: status.worker.businessChangesObserved,
        workerState: status.worker.state,
        lastHeartbeatAt: status.worker.lastHeartbeatAt,
        humanActionRequired: status.workerContext.humanActionRequired,
        tracking: {
          enabled: status.tracking.enabled,
          state: status.tracking.state,
          rateLimiter: status.tracking.rateLimiter,
          fingerprintSecretConfigured:
            status.tracking.fingerprintSecretConfigured,
          readyForWrites: status.tracking.readyForWrites,
          redirectAvailable: status.tracking.redirectAvailable,
        },
        checks: {
          database: status.database,
          redis: status.redis,
          migrations: status.migrations.status,
          build: status.build,
          worker: status.worker.state,
          tracking: status.tracking.state,
        },
      },
      { status: status.status === "NOT_READY" ? 503 : 200 },
    );
  } catch {
    return NextResponse.json(
      {
        status: "NOT_READY",
        errorCode: "READINESS_CHECK_FAILED",
      },
      { status: 503 },
    );
  }
}
