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
  staleAfterMs = 120_000,
) {
  const record = asRecord(value);
  const heartbeatAt =
    typeof record.heartbeatAt === "string" ? record.heartbeatAt : null;
  const storedState = record.state;
  const heartbeatTime = heartbeatAt
    ? new Date(heartbeatAt).getTime()
    : Number.NaN;
  const elapsed = now.getTime() - heartbeatTime;
  const state =
    storedState === "OFFLINE" || !Number.isFinite(heartbeatTime)
      ? ("OFFLINE" as const)
      : elapsed > staleAfterMs
        ? ("STALE" as const)
        : ("ONLINE" as const);
  const nextRuns = asRecord(record.nextRuns);
  const lastError = asRecord(record.lastError);
  const metrics = asRecord(record.metrics);
  const metric = (key: string) =>
    typeof metrics[key] === "number" ? metrics[key] : 0;

  return {
    state,
    heartbeatAt,
    nextDiscovery:
      typeof nextRuns.discovery === "string" ? nextRuns.discovery : null,
    nextPublication:
      typeof nextRuns.publication === "string" ? nextRuns.publication : null,
    lastErrorComponent:
      typeof lastError.component === "string" ? lastError.component : null,
    lastErrorAt: typeof lastError.at === "string" ? lastError.at : null,
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
