import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const BURN_IN_SESSION_FILE = ".local/ops/burn-in-session.json";
export const BURN_IN_REPORT_HISTORY = ".local/ops/burn-in-reports";

export type BurnInReportSource = "SMOKE" | "MANUAL" | "MANUAL_TEST";
export type ManualBurnInSession = {
  version: 1;
  sessionId: string;
  reportSource: "MANUAL" | "MANUAL_TEST";
  state: "ACTIVE" | "FINALIZING" | "COMPLETED" | "INCOMPLETE";
  startedAt: string;
  finishedAt: string | null;
  baseline: unknown;
  findingsBefore: unknown[];
  realLeaderBefore: unknown;
  humanActions: string[];
};

export type BurnInSessionReadResult =
  | { status: "MISSING"; session: null }
  | { status: "CORRUPT"; session: null }
  | { status: "VALID"; session: ManualBurnInSession };

function isSession(value: unknown): value is ManualBurnInSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    typeof item.sessionId === "string" &&
    /^[a-f0-9-]{16,80}$/i.test(item.sessionId) &&
    (item.reportSource === "MANUAL" || item.reportSource === "MANUAL_TEST") &&
    ["ACTIVE", "FINALIZING", "COMPLETED", "INCOMPLETE"].includes(String(item.state)) &&
    typeof item.startedAt === "string" &&
    Array.isArray(item.findingsBefore) &&
    Array.isArray(item.humanActions)
  );
}

export async function writeAtomicJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

export async function readManualBurnInSession(
  workspaceRoot: string,
): Promise<BurnInSessionReadResult> {
  try {
    const value = JSON.parse(
      (await readFile(join(workspaceRoot, BURN_IN_SESSION_FILE), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    ) as unknown;
    return isSession(value)
      ? { status: "VALID", session: value }
      : { status: "CORRUPT", session: null };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "MISSING", session: null }
      : { status: "CORRUPT", session: null };
  }
}

export async function createManualBurnInSession(input: {
  workspaceRoot: string;
  baseline: unknown;
  findingsBefore: unknown[];
  realLeaderBefore: unknown;
  reportSource?: "MANUAL" | "MANUAL_TEST";
  now?: Date;
  sessionId?: string;
}) {
  const current = await readManualBurnInSession(input.workspaceRoot);
  if (current.status === "CORRUPT") throw new Error("BURN_IN_SESSION_CORRUPT");
  if (
    current.status === "VALID" &&
    ["ACTIVE", "FINALIZING", "INCOMPLETE"].includes(current.session.state)
  ) {
    throw new Error(
      current.session.state === "INCOMPLETE"
        ? "BURN_IN_SESSION_INCOMPLETE"
        : "BURN_IN_SESSION_ALREADY_ACTIVE",
    );
  }
  const session: ManualBurnInSession = {
    version: 1,
    sessionId: input.sessionId ?? randomUUID(),
    reportSource: input.reportSource ?? "MANUAL",
    state: "ACTIVE",
    startedAt: (input.now ?? new Date()).toISOString(),
    finishedAt: null,
    baseline: input.baseline,
    findingsBefore: input.findingsBefore,
    realLeaderBefore: input.realLeaderBefore,
    humanActions: [],
  };
  await writeAtomicJson(join(input.workspaceRoot, BURN_IN_SESSION_FILE), session);
  return session;
}

export async function updateManualBurnInSession(
  workspaceRoot: string,
  session: ManualBurnInSession,
) {
  await writeAtomicJson(join(workspaceRoot, BURN_IN_SESSION_FILE), session);
}

export async function completeManualBurnInSession(input: {
  workspaceRoot: string;
  session: ManualBurnInSession;
  report: Record<string, unknown>;
  reportFile: string;
}) {
  const current = await readManualBurnInSession(input.workspaceRoot);
  if (
    current.status === "VALID" &&
    current.session.sessionId === input.session.sessionId &&
    current.session.state === "COMPLETED"
  ) {
    return { alreadyCompleted: true };
  }
  if (
    current.status !== "VALID" ||
    current.session.sessionId !== input.session.sessionId
  ) {
    throw new Error("BURN_IN_SESSION_CHANGED");
  }
  const historyFile = join(
    input.workspaceRoot,
    BURN_IN_REPORT_HISTORY,
    `${input.session.sessionId}.json`,
  );
  await writeAtomicJson(historyFile, input.report);
  await writeAtomicJson(join(input.workspaceRoot, input.reportFile), input.report);
  await updateManualBurnInSession(input.workspaceRoot, {
    ...input.session,
    state: "COMPLETED",
    finishedAt:
      typeof input.report.finishedAt === "string"
        ? input.report.finishedAt
        : new Date().toISOString(),
  });
  return { alreadyCompleted: false };
}

export function eventsForSession(
  events: Array<Record<string, unknown>>,
  sessionId: string,
) {
  return events.filter((event) => event.sessionId === sessionId);
}

export async function readBurnInSessionObservations(
  workspaceRoot: string,
  sessionId: string,
) {
  try {
    const events = eventsForSession(
      (await readFile(join(workspaceRoot, ".local/ops/burn-in-events.jsonl"), "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line) as unknown;
            return value && typeof value === "object" && !Array.isArray(value)
              ? [value as Record<string, unknown>]
              : [];
          } catch {
            return [];
          }
        }),
      sessionId,
    );
    return {
      liveObserved: events.some((event) => event.event === "LIVE_VALIDATED"),
      readyObserved: events.some((event) => event.event === "READY_VALIDATED"),
      heartbeatObserved: events.some((event) => event.event === "HEARTBEAT_OBSERVED"),
    };
  } catch {
    return { liveObserved: false, readyObserved: false, heartbeatObserved: false };
  }
}

export function sessionStatusView(
  result: BurnInSessionReadResult,
  now = new Date(),
) {
  if (result.status !== "VALID") {
    return result.status === "CORRUPT"
      ? { state: "HUMAN_REVIEW_REQUIRED", humanActions: ["REVIEW_CORRUPT_BURN_IN_SESSION"] }
      : null;
  }
  const started = Date.parse(result.session.startedAt);
  const completedAt = result.session.finishedAt
    ? Date.parse(result.session.finishedAt)
    : Number.NaN;
  const elapsedUntil =
    result.session.state === "COMPLETED" && Number.isFinite(completedAt)
      ? completedAt
      : now.getTime();
  return {
    source: result.session.reportSource,
    sessionId: result.session.sessionId.slice(0, 12),
    state: result.session.state,
    startedAt: result.session.startedAt,
    elapsedSeconds: Number.isFinite(started)
      ? Math.max(0, Math.floor((elapsedUntil - started) / 1_000))
      : 0,
    humanActions: result.session.humanActions,
  };
}
