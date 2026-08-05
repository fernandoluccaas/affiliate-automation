import {
  DEFAULT_WORKER_STALE_AFTER_MS,
  resolveWorkerHealthStatus,
} from "@affiliate/shared";

export const WORKER_STATUS_KEY = "worker:continuous:status";
export const WORKER_CONTROLS_KEY = "worker:continuous:controls";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function workerControlsFromValue(value: unknown) {
  const record = asRecord(value);
  return {
    discoveryPaused: record.discoveryPaused === true,
    publicationPaused: record.publicationPaused === true,
  };
}

export function workerStatusFromValue(
  value: unknown,
  now = new Date(),
  staleAfterMs = DEFAULT_WORKER_STALE_AFTER_MS,
) {
  const record = asRecord(value);
  const heartbeatAt =
    typeof record.heartbeatAt === "string" ? record.heartbeatAt : null;
  const state = resolveWorkerHealthStatus({
    storedState: record.state,
    heartbeatAt,
    now,
    staleAfterMs,
  });
  const nextRuns = asRecord(record.nextRuns);
  const lastError = asRecord(record.lastError);
  const lockBackend =
    record.lockBackend === "AVAILABLE" || record.lockBackend === "UNAVAILABLE"
      ? record.lockBackend
      : ("UNKNOWN" as const);
  const metrics = asRecord(record.metrics);
  const metric = (key: string) =>
    typeof metrics[key] === "number" ? metrics[key] : 0;

  return {
    state,
    heartbeatAt,
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId.slice(0, 12) : null,
    leaderStatus:
      record.leaderStatus === "ACTIVE" || record.leaderStatus === "RELEASING"
        ? record.leaderStatus
        : null,
    lastCycleStartedAt:
      typeof record.lastCycleStartedAt === "string"
        ? record.lastCycleStartedAt
        : null,
    lastCycleFinishedAt:
      typeof record.lastCycleFinishedAt === "string"
        ? record.lastCycleFinishedAt
        : null,
    lastCycleStatus:
      typeof record.lastCycleStatus === "string" ? record.lastCycleStatus : null,
    nextDiscovery:
      typeof nextRuns.discovery === "string" ? nextRuns.discovery : null,
    nextPublication:
      typeof nextRuns.publication === "string" ? nextRuns.publication : null,
    lastErrorComponent:
      typeof lastError.component === "string" ? lastError.component : null,
    lastErrorAt: typeof lastError.at === "string" ? lastError.at : null,
    lastErrorCode:
      typeof lastError.code === "string" ? lastError.code : null,
    lastErrorRootCause:
      typeof lastError.rootCause === "string" ? lastError.rootCause : null,
    lockBackend,
    metrics: {
      discoveryRuns: metric("discoveryRuns"),
      discoverySucceeded: metric("discoverySucceeded"),
      discoveryPartial: metric("discoveryPartial"),
      discoveryFailed: metric("discoveryFailed"),
      offersDiscovered: metric("offersDiscovered"),
      offersUpdated: metric("offersUpdated"),
      affiliateLinksGenerated: metric("affiliateLinksGenerated"),
      affiliateLinksReused: metric("affiliateLinksReused"),
      offersEvaluated: metric("offersEvaluated"),
      offersScheduled: metric("offersScheduled"),
      offersSkipped: metric("offersSkipped"),
      publicationsAttempted: metric("publicationsAttempted"),
      publicationsSucceeded: metric("publicationsSucceeded"),
      publicationsFailed: metric("publicationsFailed"),
      publicationsRetried: metric("publicationsRetried"),
      aiGenerated: metric("aiGenerated"),
      aiFallbackUsed: metric("aiFallbackUsed"),
    },
  };
}
