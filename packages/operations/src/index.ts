import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  getWhatsAppWebQueueStatus,
  isUnresolvedWhatsAppDelivery,
  prisma,
  whatsappWebStoredState,
  type PrismaClient,
} from "@affiliate/database";
import { getRedisHealth } from "@affiliate/redis";
import {
  DEFAULT_WORKER_STALE_AFTER_MS,
  resolveWorkerHealthStatus,
} from "@affiliate/shared";

export const OPS_ROOT = ".local/ops";
export const OPS_LOG_ROOT = ".local/logs";
export const DEFAULT_BACKUP_ROOT = ".local/backups";
export const WORKER_STATUS_KEY = "worker:continuous:status";
export const BURN_IN_REPORT_FILE = ".local/ops/burn-in-report.json";
export const OPERATIONS_WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export type OperationalSeverity =
  | "INFO"
  | "WARNING"
  | "CRITICAL"
  | "HUMAN_REVIEW_REQUIRED";

export type OperationalFinding = {
  code: string;
  severity: OperationalSeverity;
  publicationId?: string;
  channelId?: string;
  action: string;
};

export type WorkerOperationalContext = {
  expectation: "EXPECTED_RUNNING" | "EXPECTED_STOPPED" | "FAILED";
  heartbeatSeverity: "NONE" | "WARNING" | "CRITICAL";
  heartbeatAction: string | null;
  humanActionRequired: boolean;
};

type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function safeCode(value: unknown, fallback = "OPERATION_FAILED") {
  return typeof value === "string" && /^[A-Z0-9_:-]+$/.test(value)
    ? value
    : fallback;
}

export function sanitizeLogEntry(input: Record<string, unknown>) {
  const forbidden = [
    "password",
    "secret",
    "token",
    "cookie",
    "database_url",
    "redis_url",
    "message",
    "caption",
    "affiliateurl",
    "profilepath",
    "groupname",
  ];
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      forbidden.some((item) => key.toLowerCase().includes(item))
        ? []
        : [[key, value]],
    ),
  );
}

export function structuredLog(input: {
  component: "dashboard" | "worker" | "supervisor" | "operations";
  level: "info" | "warn" | "error";
  event: string;
  instanceId: string;
  correlationId?: string;
  publicationId?: string;
  channelId?: string;
  errorCode?: string;
  timestamp?: Date;
}) {
  return JSON.stringify(
    sanitizeLogEntry({
      timestamp: (input.timestamp ?? new Date()).toISOString(),
      component: input.component,
      level: input.level,
      event: safeCode(input.event, "OPERATION_EVENT"),
      instanceId: input.instanceId.slice(0, 12),
      ...(input.correlationId
        ? { correlationId: input.correlationId.slice(0, 36) }
        : {}),
      ...(input.publicationId ? { publicationId: input.publicationId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.errorCode ? { errorCode: safeCode(input.errorCode) } : {}),
    }),
  );
}

export type SupervisorComponentState = {
  component: "dashboard" | "worker";
  pid: number;
  instanceId: string;
  startedAt: string;
  restartCount: number;
  consecutiveCrashes: number;
  status: "STARTING" | "RUNNING" | "BACKOFF" | "STOPPED" | "FAILED";
  nextRestartAt: string | null;
  lastExitCode: number | null;
  lastExitReason: "REQUESTED" | "CRASH" | null;
};

export function supervisorBackoffMs(crashes: number, baseMs = 1_000, maxMs = 60_000) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, crashes - 1));
}

export function resetSupervisorStateAfterStability(
  state: SupervisorComponentState,
  input: { now: Date; stableResetSeconds: number },
) {
  const startedAt = Date.parse(state.startedAt);
  const stableForMs = input.now.getTime() - startedAt;
  if (
    state.status !== "RUNNING" ||
    state.consecutiveCrashes === 0 ||
    !Number.isFinite(startedAt) ||
    stableForMs < Math.max(1, input.stableResetSeconds) * 1_000
  ) {
    return { state, reset: false };
  }
  return {
    state: {
      ...state,
      consecutiveCrashes: 0,
      nextRestartAt: null,
    },
    reset: true,
  };
}

export function nextSupervisorState(
  state: SupervisorComponentState,
  input: { requested: boolean; exitCode: number; maxCrashes: number; now: Date },
): SupervisorComponentState {
  if (input.requested) {
    return {
      ...state,
      pid: 0,
      status: "STOPPED",
      lastExitCode: input.exitCode,
      lastExitReason: "REQUESTED",
      nextRestartAt: null,
    };
  }
  const consecutiveCrashes = state.consecutiveCrashes + 1;
  if (consecutiveCrashes >= input.maxCrashes) {
    return {
      ...state,
      pid: 0,
      status: "FAILED",
      consecutiveCrashes,
      lastExitCode: input.exitCode,
      lastExitReason: "CRASH",
      nextRestartAt: null,
    };
  }
  const delay = supervisorBackoffMs(consecutiveCrashes);
  return {
    ...state,
    pid: 0,
    status: "BACKOFF",
    consecutiveCrashes,
    restartCount: state.restartCount + 1,
    lastExitCode: input.exitCode,
    lastExitReason: "CRASH",
    nextRestartAt: new Date(input.now.getTime() + delay).toISOString(),
  };
}

export function isOwnedProcess(input: {
  expectedPid: number;
  actualPid: number;
  commandLine: string | null;
  repositoryRoot: string;
  componentMarker: string;
}) {
  const command = input.commandLine?.toLowerCase() ?? "";
  const normalizedCommand = command.replaceAll("/", "\\");
  const normalizedRoot = resolve(input.repositoryRoot)
    .toLowerCase()
    .replaceAll("/", "\\");
  return (
    input.expectedPid > 0 &&
    input.expectedPid === input.actualPid &&
    normalizedCommand.includes(normalizedRoot) &&
    normalizedCommand.includes(input.componentMarker.toLowerCase())
  );
}

export function classifyWorkerOperationalContext(input: {
  supervisorState: string;
  components: Array<{ status: string; lastExitReason: string | null }>;
  workerState: string;
  burnInActive?: boolean;
}): WorkerOperationalContext {
  const failed =
    input.supervisorState === "STALE" ||
    input.components.some(
      (component) =>
        component.status === "FAILED" ||
        component.lastExitReason === "CRASH" ||
        component.lastExitReason === "UNEXPECTED_EXIT",
    );
  const running = input.supervisorState === "RUNNING";
  const expectation = failed
    ? "FAILED"
    : running
      ? "EXPECTED_RUNNING"
      : "EXPECTED_STOPPED";
  if (input.workerState !== "STALE") {
    return {
      expectation,
      heartbeatSeverity: "NONE",
      heartbeatAction: null,
      humanActionRequired: failed,
    };
  }
  if (expectation === "EXPECTED_STOPPED" && !input.burnInActive) {
    return {
      expectation,
      heartbeatSeverity: "WARNING",
      heartbeatAction: "START_CONTINUOUS_OPERATIONS_WHEN_READY",
      humanActionRequired: false,
    };
  }
  return {
    expectation,
    heartbeatSeverity: "CRITICAL",
    heartbeatAction: input.burnInActive
      ? "STOP_BURN_IN_AND_INSPECT_WORKER"
      : "RESTART_OR_INSPECT_WORKER",
    humanActionRequired: true,
  };
}

export function auditOperationalSnapshot(input: {
  now: Date;
  heartbeat: unknown;
  heartbeatUpdatedAt?: Date | null;
  backupCreatedAt?: Date | null;
  backupMaxAgeMs: number;
  publications: Array<{
    id: string;
    channelId: string;
    status: string;
    metadata: unknown;
  }>;
  channels: Array<{ id: string; configuration: unknown }>;
  runningAutomationRuns: Array<{ id: string; startedAt: Date }>;
  pendingAttempts: Array<{ id: string; publicationId: string; attemptedAt: Date }>;
  workerContext?: WorkerOperationalContext;
}): OperationalFinding[] {
  const findings: OperationalFinding[] = [];
  const heartbeat = asRecord(input.heartbeat);
  const heartbeatAt =
    typeof heartbeat.lastHeartbeatAt === "string"
      ? heartbeat.lastHeartbeatAt
      : typeof heartbeat.heartbeatAt === "string"
        ? heartbeat.heartbeatAt
        : null;
  if (
    resolveWorkerHealthStatus({
      storedState: heartbeat.state,
      heartbeatAt,
      now: input.now,
      staleAfterMs: DEFAULT_WORKER_STALE_AFTER_MS,
    }) === "STALE"
  ) {
    const context = input.workerContext;
    findings.push({
      code: "WORKER_HEARTBEAT_STALE",
      severity:
        context?.heartbeatSeverity === "WARNING" ? "WARNING" : "CRITICAL",
      action: context?.heartbeatAction ?? "RESTART_OR_INSPECT_WORKER",
    });
  }

  const activeByChannel = new Map<string, string[]>();
  for (const publication of input.publications) {
    const metadata = asRecord(publication.metadata);
    const state = whatsappWebStoredState(publication as never, input.now);
    // A regular waiting queue may contain many non-terminal publications. Only
    // states that hold (or must hold) the single operational channel slot are
    // considered active for this consistency check.
    if (
      ["AUTHORIZED_FOR_SEND", "SEND_IN_PROGRESS", "DELIVERY_UNCERTAIN"].includes(
        state,
      )
    ) {
      const ids = activeByChannel.get(publication.channelId) ?? [];
      ids.push(publication.id);
      activeByChannel.set(publication.channelId, ids);
    }
    if (
      ["PUBLISHED", "CANCELLED"].includes(publication.status) &&
      (metadata.sendAuthorizationStatus === "ACTIVE" ||
        metadata.sendAuthorizationStatus === "CLAIMED" ||
        metadata.deliveryUncertain === true)
    ) {
      findings.push({
        code: "WHATSAPP_ACTIVE_PUBLICATION_INCONSISTENT",
        severity: "CRITICAL",
        publicationId: publication.id,
        channelId: publication.channelId,
        action: "REVIEW_PUBLICATION_AND_CHANNEL_QUEUE_MANUALLY",
      });
    }
    if (
      ["PUBLISHED", "CANCELLED"].includes(publication.status) &&
      (metadata.sendAuthorizationStatus === "ACTIVE" ||
        metadata.sendAuthorizationStatus === "CLAIMED" ||
        metadata.deliveryUncertain === true)
    ) {
      findings.push({
        code: "WHATSAPP_ACTIVE_PUBLICATION_INCONSISTENT",
        severity: "CRITICAL",
        publicationId: publication.id,
        channelId: publication.channelId,
        action: "REVIEW_PUBLICATION_AND_CHANNEL_QUEUE_MANUALLY",
      });
    }
    if (
      metadata.sendAuthorizationStatus === "CLAIMED" &&
      typeof metadata.sendClickStartedAt !== "string"
    ) {
      findings.push({
        code: "WHATSAPP_CLAIM_ABANDONED_PRE_CLICK",
        severity: "HUMAN_REVIEW_REQUIRED",
        publicationId: publication.id,
        channelId: publication.channelId,
        action: "INSPECT_THEN_MANUALLY_RELEASE_OR_KEEP_BLOCKED",
      });
    }
    if (
      metadata.whatsappWebState === "SEND_IN_PROGRESS" &&
      typeof metadata.sendClickStartedAt === "string"
    ) {
      findings.push({
        code: "WHATSAPP_SEND_STARTED_REVIEW_REQUIRED",
        severity: "HUMAN_REVIEW_REQUIRED",
        publicationId: publication.id,
        channelId: publication.channelId,
        action: "REVIEW_DELIVERY_NEVER_RELEASE_CLAIM",
      });
    }
    if (isUnresolvedWhatsAppDelivery(publication as never)) {
      findings.push({
        code: "WHATSAPP_DELIVERY_UNCERTAIN",
        severity: "HUMAN_REVIEW_REQUIRED",
        publicationId: publication.id,
        channelId: publication.channelId,
        action: "RECONCILE_DELIVERY_MANUALLY",
      });
    }
    if (
      metadata.sendAuthorizationStatus === "ACTIVE" &&
      typeof metadata.sendAuthorizationExpiresAt === "string" &&
      new Date(metadata.sendAuthorizationExpiresAt).getTime() <= input.now.getTime()
    ) {
      findings.push({
        code: "WHATSAPP_AUTHORIZATION_EXPIRED_ACTIVE",
        severity: "WARNING",
        publicationId: publication.id,
        channelId: publication.channelId,
        action: "RUN_NEW_PREFLIGHT_AND_AUTHORIZATION_IF_NEEDED",
      });
    }
  }
  for (const [channelId, ids] of activeByChannel) {
    if (ids.length > 1) {
      findings.push({
        code: "WHATSAPP_MULTIPLE_ACTIVE_PUBLICATIONS",
        severity: "CRITICAL",
        channelId,
        action: "REVIEW_QUEUE_WITHOUT_AUTOMATIC_CHANGES",
      });
    }
  }
  for (const channel of input.channels) {
    const configuration = asRecord(channel.configuration);
    if (
      configuration.webAutomationPaused === true &&
      typeof configuration.webAutomationPauseReason !== "string"
    ) {
      findings.push({
        code: "WHATSAPP_CHANNEL_PAUSED_WITHOUT_REASON",
        severity: "WARNING",
        channelId: channel.id,
        action: "REVIEW_CHANNEL_CONFIGURATION",
      });
    }
  }
  const staleOperationMs = 60 * 60_000;
  for (const run of input.runningAutomationRuns) {
    if (input.now.getTime() - run.startedAt.getTime() > staleOperationMs) {
      findings.push({
        code: "AUTOMATION_RUN_STALE",
        severity: "WARNING",
        action: `REVIEW_AUTOMATION_RUN:${run.id}`,
      });
    }
  }
  for (const attempt of input.pendingAttempts) {
    if (input.now.getTime() - attempt.attemptedAt.getTime() > staleOperationMs) {
      findings.push({
        code: "PUBLICATION_ATTEMPT_STALE",
        severity: "WARNING",
        publicationId: attempt.publicationId,
        action: "REVIEW_PUBLICATION_ATTEMPT",
      });
    }
  }
  if (
    !input.backupCreatedAt ||
    input.now.getTime() - input.backupCreatedAt.getTime() > input.backupMaxAgeMs
  ) {
    findings.push({
      code: "DATABASE_BACKUP_STALE",
      severity: "WARNING",
      action: "RUN_OPS_BACKUP_DB",
    });
  }
  return findings;
}

export type BackupManifest = {
  version: 1;
  file: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  format: "postgres-custom";
  verified: true;
};

export function resolveSafeBackupDirectory(
  workspaceRoot: string,
  configured = process.env.AFFILIATE_BACKUP_DIR || DEFAULT_BACKUP_ROOT,
) {
  const directory = isAbsolute(configured)
    ? resolve(configured)
    : resolve(workspaceRoot, configured);
  const gitRoot = resolve(workspaceRoot, ".git");
  const localRoot = resolve(workspaceRoot, ".local");
  if (directory === gitRoot || directory.startsWith(`${gitRoot}${sep}`)) {
    throw new Error("BACKUP_DIRECTORY_INVALID");
  }
  if (
    (directory === resolve(workspaceRoot) ||
      directory.startsWith(`${resolve(workspaceRoot)}${sep}`)) &&
    directory !== localRoot &&
    !directory.startsWith(`${localRoot}${sep}`)
  ) {
    throw new Error("BACKUP_DIRECTORY_MUST_BE_LOCAL_IGNORED_OR_EXTERNAL");
  }
  return directory;
}

export function isFileInsideDirectory(directory: string, file: string) {
  const root = resolve(directory);
  const target = resolve(file);
  return target.startsWith(`${root}${sep}`);
}

export async function withExclusiveFileLock<T>(input: {
  directory: string;
  name: string;
  operation: () => Promise<T>;
  staleAfterMs?: number;
  now?: Date;
}) {
  await mkdir(input.directory, { recursive: true });
  const lockFile = join(input.directory, `.${input.name}.lock`);
  if (!isFileInsideDirectory(input.directory, lockFile)) {
    throw new Error("OPERATION_LOCK_PATH_INVALID");
  }
  const staleAfterMs = input.staleAfterMs ?? 6 * 60 * 60 * 1_000;
  const now = input.now ?? new Date();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockFile).catch(() => null);
      if (!info || now.getTime() - Number(info.mtimeMs) <= staleAfterMs) {
        throw new Error("OPERATION_ALREADY_ACTIVE");
      }
      await rm(lockFile, { force: true });
      handle = await open(lockFile, "wx");
    }
    return await input.operation();
  } finally {
    await handle?.close().catch(() => undefined);
    if (handle) await rm(lockFile, { force: true }).catch(() => undefined);
  }
}

async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runProcessToFile(input: {
  command: string;
  args: string[];
  file: string;
  env?: NodeJS.ProcessEnv;
}) {
  await mkdir(dirname(input.file), { recursive: true });
  return new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(input.file, { flags: "wx" });
    const child = spawn(input.command, input.args, {
      cwd: process.cwd(),
      env: input.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errorCode = "BACKUP_PROCESS_FAILED";
    child.stderr.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (/password|secret|token|postgresql:\/\//i.test(value)) {
        errorCode = "BACKUP_PROCESS_REDACTED_FAILURE";
      }
    });
    child.stdout.pipe(output);
    child.once("error", () => reject(new Error(errorCode)));
    child.once("close", (code) => {
      output.end(() =>
        code === 0 ? resolvePromise() : reject(new Error(errorCode)),
      );
    });
  });
}

export async function verifyPostgresBackup(input: {
  file: string;
  manifestFile?: string;
  verify?: (file: string) => Promise<boolean>;
}) {
  const before = await stat(input.file);
  if (!before.isFile() || before.size <= 0) throw new Error("BACKUP_EMPTY");
  const valid = input.verify ? await input.verify(input.file) : true;
  if (!valid) throw new Error("BACKUP_INVALID");
  const digest = await sha256(input.file);
  if (input.manifestFile && existsSync(input.manifestFile)) {
    const manifest = JSON.parse(
      await readFile(input.manifestFile, "utf8"),
    ) as BackupManifest;
    if (manifest.sha256 !== digest || manifest.sizeBytes !== before.size) {
      throw new Error("BACKUP_CHECKSUM_MISMATCH");
    }
  }
  const after = await stat(input.file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("BACKUP_CHANGED_DURING_VERIFICATION");
  }
  return { valid: true as const, sizeBytes: before.size, sha256: digest };
}

export async function createPostgresBackup(input: {
  directory: string;
  now?: Date;
  dump?: (temporaryFile: string) => Promise<void>;
  verify?: (file: string) => Promise<boolean>;
}) {
  const now = input.now ?? new Date();
  await mkdir(input.directory, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const base = `affiliate-${stamp}`;
  const temporaryFile = join(input.directory, `.${base}-${randomUUID()}.tmp`);
  const finalFile = join(input.directory, `${base}.dump`);
  const manifestFile = `${finalFile}.manifest.json`;
  try {
    if (input.dump) {
      await input.dump(temporaryFile);
    } else {
      await runProcessToFile({
        command: "docker",
        args: [
          "compose",
          "exec",
          "-T",
          "postgres",
          "pg_dump",
          "-Fc",
          "-U",
          process.env.POSTGRES_USER || "affiliate",
          "-d",
          process.env.POSTGRES_DB || "affiliate_automation",
        ],
        file: temporaryFile,
      });
    }
    const verified = await verifyPostgresBackup({
      file: temporaryFile,
      ...(input.verify ? { verify: input.verify } : {}),
    });
    await rename(temporaryFile, finalFile);
    const manifest: BackupManifest = {
      version: 1,
      file: basename(finalFile),
      createdAt: now.toISOString(),
      sizeBytes: verified.sizeBytes,
      sha256: verified.sha256,
      format: "postgres-custom",
      verified: true,
    };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    return { file: finalFile, manifestFile, manifest };
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applyBackupRetention(input: {
  directory: string;
  now?: Date;
  maxAgeDays: number;
  maxCount: number;
}) {
  const now = input.now ?? new Date();
  const files = (await readdir(input.directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^affiliate-.*\.dump$/.test(entry.name))
    .map((entry) => join(input.directory, entry.name));
  const details = await Promise.all(
    files.map(async (file) => ({ file, stats: await stat(file) })),
  );
  details.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const removed: string[] = [];
  for (const [index, item] of details.entries()) {
    const expired =
      now.getTime() - item.stats.mtimeMs > input.maxAgeDays * 86_400_000;
    if ((index >= input.maxCount || expired) && isFileInsideDirectory(input.directory, item.file)) {
      await rm(item.file);
      await rm(`${item.file}.manifest.json`, { force: true });
      removed.push(item.file);
    }
  }
  return removed;
}

export async function latestBackup(directory: string) {
  if (!existsSync(directory)) return null;
  const manifests = (await readdir(directory))
    .filter((name) => /^affiliate-.*\.dump\.manifest\.json$/.test(name))
    .map((name) => join(directory, name));
  const valid: Array<{ file: string; manifest: BackupManifest; stats: Awaited<ReturnType<typeof stat>> }> = [];
  for (const file of manifests) {
    try {
      const manifest = JSON.parse(await readFile(file, "utf8")) as BackupManifest;
      const backupFile = join(directory, manifest.file);
      const stats = await stat(backupFile);
      valid.push({ file: backupFile, manifest, stats });
    } catch {
      // Invalid manifests are ignored and surfaced by audit/preflight as stale.
    }
  }
  return valid.sort((a, b) => Number(b.stats.mtimeMs) - Number(a.stats.mtimeMs))[0] ?? null;
}

export async function rotateLogs(input: {
  directory: string;
  maxBytes: number;
  retentionDays: number;
  now?: Date;
}) {
  await mkdir(input.directory, { recursive: true });
  const now = input.now ?? new Date();
  const entries = await readdir(input.directory, { withFileTypes: true });
  const rotated: string[] = [];
  const removed: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".log") && !entry.name.endsWith(".jsonl"))
    ) {
      continue;
    }
    const file = join(input.directory, entry.name);
    const info = await stat(file);
    if (now.getTime() - info.mtimeMs > input.retentionDays * 86_400_000) {
      try {
        await rm(file);
        removed.push(file);
      } catch {
        // An active Windows log handle is never forced or truncated.
      }
    } else if (info.size >= input.maxBytes) {
      const rotatedFile = `${file}.${now.toISOString().slice(0, 10)}.${randomUUID().slice(0, 8)}`;
      try {
        await rename(file, rotatedFile);
        rotated.push(rotatedFile);
      } catch {
        // Open log files are skipped and retried by a later rotation.
      }
    }
  }
  return { rotated, removed };
}

export async function logDirectoryStatus(directory: string) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = join(directory, entry.name);
        return { file, stats: await stat(file) };
      }),
  );
  const latest = files.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)[0];
  return {
    directory: basename(directory),
    totalBytes: files.reduce((sum, item) => sum + item.stats.size, 0),
    latestFile: latest ? basename(latest.file) : null,
    retentionDays: Number(process.env.AFFILIATE_LOG_RETENTION_DAYS ?? 14),
    writeError: null,
  };
}

async function localSupervisorStatus(workspaceRoot: string, now: Date) {
  try {
    const raw = await readFile(join(workspaceRoot, OPS_ROOT, "supervisor.json"), "utf8");
    const state = asRecord(JSON.parse(raw.replace(/^\uFEFF/, "")));
    const pid = typeof state.pid === "number" ? state.pid : null;
    const startedAt =
      typeof state.startedAt === "string" && !Number.isNaN(Date.parse(state.startedAt))
        ? state.startedAt
        : null;
    let processPresent = false;
    if (pid && pid > 0) {
      try {
        process.kill(pid, 0);
        processPresent = true;
      } catch {
        processPresent = false;
      }
    }
    return {
      state: processPresent ? "RUNNING" : "STALE",
      instanceId:
        typeof state.instanceId === "string" ? state.instanceId.slice(0, 12) : null,
      uptimeSeconds: startedAt
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 1_000))
        : 0,
    };
  } catch {
    return { state: "STOPPED", instanceId: null, uptimeSeconds: 0 };
  }
}

async function localComponentStatus(workspaceRoot: string) {
  try {
    const raw = await readFile(join(workspaceRoot, OPS_ROOT, "components.json"), "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    const components = Array.isArray(parsed) ? parsed : [];
    return components.map((value) => {
      const component = asRecord(value);
      const status = typeof component.status === "string" ? component.status : "UNKNOWN";
      return {
        component:
          component.component === "dashboard" || component.component === "worker"
            ? component.component
            : "unknown",
        status,
        restartCount:
          typeof component.restartCount === "number" ? component.restartCount : 0,
        lastExitReason:
          typeof component.lastExitReason === "string" ? component.lastExitReason : null,
        action: status === "FAILED" ? "INSPECT_LOGS_THEN_RESTART_SUPERVISOR" : null,
        consecutiveCrashes:
          typeof component.consecutiveCrashes === "number"
            ? component.consecutiveCrashes
            : 0,
      };
    });
  } catch {
    return [];
  }
}

export async function collectOperationalStatus(
  client: PrismaClient = prisma,
  input: { workspaceRoot?: string; now?: Date } = {},
) {
  const workspaceRoot = input.workspaceRoot ?? OPERATIONS_WORKSPACE_ROOT;
  const now = input.now ?? new Date();
  let database: "OK" | "ERROR" = "OK";
  try {
    await client.$queryRaw`SELECT 1`;
  } catch {
    database = "ERROR";
  }
  const redis = await getRedisHealth();
  const workerSetting =
    database === "OK"
      ? await client.systemSetting.findUnique({
          where: { key: WORKER_STATUS_KEY },
          select: { value: true, updatedAt: true },
        })
      : null;
  const lastAutomationRun =
    database === "OK"
      ? await client.automationRun.findFirst({
          orderBy: { startedAt: "desc" },
          select: {
            id: true,
            name: true,
            status: true,
            startedAt: true,
            finishedAt: true,
          },
        })
      : null;
  const worker = asRecord(workerSetting?.value);
  const heartbeatAt =
    typeof worker.lastHeartbeatAt === "string"
      ? worker.lastHeartbeatAt
      : typeof worker.heartbeatAt === "string"
        ? worker.heartbeatAt
        : null;
  const workerState = resolveWorkerHealthStatus({
    storedState: worker.state,
    heartbeatAt,
    now,
  });
  const expectedMigrations = existsSync(join(workspaceRoot, "prisma/migrations"))
    ? (await readdir(join(workspaceRoot, "prisma/migrations"), { withFileTypes: true })).filter(
        (entry) => entry.isDirectory(),
      ).length
    : 0;
  let appliedMigrations = 0;
  if (database === "OK") {
    try {
      const rows = await client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;
      appliedMigrations = Number(rows[0]?.count ?? 0);
    } catch {
      appliedMigrations = 0;
    }
  }
  const backupDirectory = resolveSafeBackupDirectory(workspaceRoot);
  const backup = await latestBackup(backupDirectory);
  const channels =
    database === "OK"
      ? await client.channel.findMany({
          where: { type: "WHATSAPP_GROUPS" },
          select: { id: true, configuration: true },
        })
      : [];
  const queues = [] as Array<{
    channelId: string;
    activeState: string | null;
    total: number;
    deliveryUncertain: number;
    paused: boolean;
  }>;
  for (const channel of channels) {
    const configuration = asRecord(channel.configuration);
    if (configuration.publicationMode !== "WEB_EXPERIMENTAL") continue;
    const queue = await getWhatsAppWebQueueStatus(client, channel.id);
    queues.push({
      channelId: channel.id,
      activeState: queue.activeState,
      total: queue.total,
      deliveryUncertain: queue.deliveryUncertainCount,
      paused: configuration.webAutomationPaused === true,
    });
  }
  const buildReady = existsSync(join(workspaceRoot, "apps/dashboard/.next/BUILD_ID"));
  const supervisor = await localSupervisorStatus(workspaceRoot, now);
  const components = await localComponentStatus(workspaceRoot);
  const burnInActive = worker.mode === "BURN_IN" && worker.state === "ONLINE";
  const workerContext = classifyWorkerOperationalContext({
    supervisorState: supervisor.state,
    components,
    workerState,
    burnInActive,
  });
  const dependenciesReady =
    database === "OK" &&
    redis.status === "ok" &&
    appliedMigrations === expectedMigrations &&
    buildReady;
  const status = !dependenciesReady || workerContext.heartbeatSeverity === "CRITICAL"
    ? "NOT_READY"
    : workerContext.heartbeatSeverity === "WARNING"
      ? "READY_WITH_WARNINGS"
      : "READY";
  return {
    checkedAt: now.toISOString(),
    status,
    database,
    redis: redis.status === "ok" ? "OK" : "ERROR",
    migrations: {
      status: appliedMigrations === expectedMigrations ? "UP_TO_DATE" : "PENDING",
      expected: expectedMigrations,
      applied: appliedMigrations,
    },
    build: buildReady ? "AVAILABLE" : "MISSING",
    supervisor,
    workerContext,
    components,
    worker: {
      state: workerState,
      instanceId:
        typeof worker.instanceId === "string" ? worker.instanceId.slice(0, 12) : null,
      leaderStatus:
        typeof worker.leaderStatus === "string" ? worker.leaderStatus : null,
      lastHeartbeatAt: heartbeatAt,
      lastCycleStartedAt:
        typeof worker.lastCycleStartedAt === "string" ? worker.lastCycleStartedAt : null,
      lastCycleFinishedAt:
        typeof worker.lastCycleFinishedAt === "string" ? worker.lastCycleFinishedAt : null,
      lastCycleStatus:
        typeof worker.lastCycleStatus === "string" ? worker.lastCycleStatus : null,
      currentPlanningRunId:
        typeof worker.currentPlanningRunId === "string"
          ? worker.currentPlanningRunId.slice(0, 24)
          : null,
      uptimeSeconds:
        typeof worker.uptimeSeconds === "number" ? worker.uptimeSeconds : 0,
      mode: worker.mode === "BURN_IN" ? "BURN_IN" : "NORMAL",
      burnInActive,
      blockedCycles:
        typeof worker.blockedCycles === "number" ? worker.blockedCycles : 0,
      externalEffectsObserved:
        typeof worker.externalEffectsObserved === "number"
          ? worker.externalEffectsObserved
          : 0,
      businessChangesObserved:
        typeof worker.businessChangesObserved === "number"
          ? worker.businessChangesObserved
          : 0,
      leadershipRenewals:
        typeof worker.leadershipRenewals === "number"
          ? worker.leadershipRenewals
          : 0,
      leadershipRenewalFailures:
        typeof worker.leadershipRenewalFailures === "number"
          ? worker.leadershipRenewalFailures
          : 0,
    },
    lastAutomationRun: lastAutomationRun
      ? {
          id: lastAutomationRun.id.slice(0, 12),
          name: /^[a-z0-9:_-]+$/i.test(lastAutomationRun.name)
            ? lastAutomationRun.name.slice(0, 80)
            : "AUTOMATION_RUN",
          status: lastAutomationRun.status,
          startedAt: lastAutomationRun.startedAt.toISOString(),
          finishedAt: lastAutomationRun.finishedAt?.toISOString() ?? null,
        }
      : null,
    backup: backup
      ? {
          file: basename(backup.file),
          createdAt: backup.manifest.createdAt,
          ageHours: Math.max(
            0,
            Math.round(
              ((now.getTime() - new Date(backup.manifest.createdAt).getTime()) /
                3_600_000) *
                10,
            ) / 10,
          ),
          sizeBytes: backup.manifest.sizeBytes,
          verified: backup.manifest.verified,
        }
      : null,
    whatsappQueues: queues,
    logs: await logDirectoryStatus(resolve(workspaceRoot, OPS_LOG_ROOT)),
  };
}

export async function collectStateAudit(
  client: PrismaClient = prisma,
  input: { workspaceRoot?: string; now?: Date } = {},
) {
  const workspaceRoot = input.workspaceRoot ?? OPERATIONS_WORKSPACE_ROOT;
  const now = input.now ?? new Date();
  const [worker, publications, channels, runs, attempts, backup, supervisor, components] = await Promise.all([
    client.systemSetting.findUnique({
      where: { key: WORKER_STATUS_KEY },
      select: { value: true, updatedAt: true },
    }),
    client.publication.findMany({
      where: { channel: { type: "WHATSAPP_GROUPS" } },
      select: { id: true, channelId: true, status: true, metadata: true },
    }),
    client.channel.findMany({
      where: { type: "WHATSAPP_GROUPS" },
      select: { id: true, configuration: true },
    }),
    client.automationRun.findMany({
      where: { status: "RUNNING" },
      select: { id: true, startedAt: true },
    }),
    client.publicationAttempt.findMany({
      where: { status: "PENDING" },
      select: { id: true, publicationId: true, attemptedAt: true },
    }),
    latestBackup(resolveSafeBackupDirectory(workspaceRoot)),
    localSupervisorStatus(workspaceRoot, now),
    localComponentStatus(workspaceRoot),
  ]);
  const workerRecord = asRecord(worker?.value);
  const heartbeatAt =
    typeof workerRecord.lastHeartbeatAt === "string"
      ? workerRecord.lastHeartbeatAt
      : typeof workerRecord.heartbeatAt === "string"
        ? workerRecord.heartbeatAt
        : null;
  const workerState = resolveWorkerHealthStatus({
    storedState: workerRecord.state,
    heartbeatAt,
    now,
  });
  const workerContext = classifyWorkerOperationalContext({
    supervisorState: supervisor.state,
    components,
    workerState,
    burnInActive:
      workerRecord.mode === "BURN_IN" && workerRecord.state === "ONLINE",
  });
  return auditOperationalSnapshot({
    now,
    heartbeat: worker?.value,
    heartbeatUpdatedAt: worker?.updatedAt ?? null,
    backupCreatedAt: backup ? new Date(backup.manifest.createdAt) : null,
    backupMaxAgeMs:
      Number(process.env.AFFILIATE_BACKUP_MAX_AGE_HOURS ?? 36) * 3_600_000,
    publications,
    channels,
    runningAutomationRuns: runs,
    pendingAttempts: attempts,
    workerContext,
  });
}

function fingerprintRows(rows: unknown[]) {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

function whatsappOperationalMetadata(value: unknown) {
  const metadata = asRecord(value);
  const keys = [
    "whatsappWebState",
    "sendAuthorizationStatus",
    "sendAuthorizationExpiresAt",
    "sendAuthorizationClaimedAt",
    "sendClickStartedAt",
    "deliveryUncertain",
    "retryBlocked",
  ];
  return Object.fromEntries(
    keys.filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]),
  );
}

export async function captureBusinessStateSnapshot(client: PrismaClient = prisma) {
  const [products, offers, publications, attempts, runs, channels] = await Promise.all([
    client.product.findMany({
      orderBy: { id: "asc" },
      select: { id: true, updatedAt: true },
    }),
    client.offer.findMany({
      orderBy: { id: "asc" },
      select: { id: true, updatedAt: true, version: true, status: true },
    }),
    client.publication.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        updatedAt: true,
        status: true,
        channelId: true,
        metadata: true,
      },
    }),
    client.publicationAttempt.findMany({
      orderBy: { id: "asc" },
      select: { id: true, attemptedAt: true, status: true, publicationId: true },
    }),
    client.automationRun.findMany({
      orderBy: { id: "asc" },
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    }),
    client.channel.findMany({
      where: { type: "WHATSAPP_GROUPS" },
      orderBy: { id: "asc" },
      select: { id: true, updatedAt: true, configuration: true },
    }),
  ]);
  const entities = {
    Product: { count: products.length, fingerprint: fingerprintRows(products) },
    Offer: { count: offers.length, fingerprint: fingerprintRows(offers) },
    Publication: {
      count: publications.length,
      fingerprint: fingerprintRows(
        publications.map((item) => ({
          id: item.id,
          updatedAt: item.updatedAt,
          status: item.status,
          channelId: item.channelId,
          operational: whatsappOperationalMetadata(item.metadata),
        })),
      ),
    },
    PublicationAttempt: {
      count: attempts.length,
      fingerprint: fingerprintRows(attempts),
    },
    AutomationRun: { count: runs.length, fingerprint: fingerprintRows(runs) },
    WhatsAppChannel: {
      count: channels.length,
      fingerprint: fingerprintRows(channels),
    },
  };
  return {
    capturedAt: new Date().toISOString(),
    entities,
    fingerprint: fingerprintRows(Object.entries(entities)),
  };
}

export function compareBusinessStateSnapshots(
  before: Awaited<ReturnType<typeof captureBusinessStateSnapshot>>,
  after: Awaited<ReturnType<typeof captureBusinessStateSnapshot>>,
) {
  const changed = Object.keys(before.entities).filter((key) => {
    const name = key as keyof typeof before.entities;
    return (
      before.entities[name].count !== after.entities[name].count ||
      before.entities[name].fingerprint !== after.entities[name].fingerprint
    );
  });
  return { unchanged: changed.length === 0, changedEntities: changed };
}

export async function readBurnInReport(workspaceRoot = OPERATIONS_WORKSPACE_ROOT) {
  try {
    const value = asRecord(
      JSON.parse(await readFile(join(workspaceRoot, BURN_IN_REPORT_FILE), "utf8")),
    );
    return {
      status: typeof value.status === "string" ? value.status : "UNKNOWN",
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
      durationSeconds:
        typeof value.durationSeconds === "number" ? value.durationSeconds : 0,
      supervisorInstanceId:
        typeof value.supervisorInstanceId === "string"
          ? value.supervisorInstanceId.slice(0, 12)
          : null,
      dashboardInstanceId:
        typeof value.dashboardInstanceId === "string"
          ? value.dashboardInstanceId.slice(0, 12)
          : null,
      workerInstanceId:
        typeof value.workerInstanceId === "string"
          ? value.workerInstanceId.slice(0, 12)
          : null,
      componentUptimeSeconds:
        typeof value.componentUptimeSeconds === "number"
          ? value.componentUptimeSeconds
          : 0,
      restartCount:
        typeof value.restartCount === "number" ? value.restartCount : 0,
      maxConsecutiveCrashes:
        typeof value.maxConsecutiveCrashes === "number"
          ? value.maxConsecutiveCrashes
          : 0,
      burnInConfirmed: value.burnInConfirmed === true,
      leadershipRenewals:
        typeof value.leadershipRenewals === "number" ? value.leadershipRenewals : 0,
      leadershipRenewalFailures:
        typeof value.leadershipRenewalFailures === "number"
          ? value.leadershipRenewalFailures
          : 0,
      blockedCycles: typeof value.blockedCycles === "number" ? value.blockedCycles : 0,
      externalEffectsObserved:
        typeof value.externalEffectsObserved === "number"
          ? value.externalEffectsObserved
          : 0,
      businessChangesObserved:
        typeof value.businessChangesObserved === "number"
          ? value.businessChangesObserved
          : 0,
      businessFingerprintUnchanged: value.businessFingerprintUnchanged === true,
      maxHeartbeatGapMs:
        typeof value.maxHeartbeatGapMs === "number" ? value.maxHeartbeatGapMs : 0,
      liveValidated: value.liveValidated === true,
      readyValidated: value.readyValidated === true,
      shutdownValidated: value.shutdownValidated === true,
      realLeaderKeyUnchanged: value.realLeaderKeyUnchanged === true,
      residualProcesses:
        typeof value.residualProcesses === "number" ? value.residualProcesses : 0,
      residualLocks: typeof value.residualLocks === "number" ? value.residualLocks : 0,
      humanActions: Array.isArray(value.humanActions)
        ? value.humanActions.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export async function directoryFreeBytes(directory: string) {
  await mkdir(directory, { recursive: true });
  const info = await statfs(directory);
  return Number(info.bavail) * Number(info.bsize);
}

export async function writableDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
  const probe = join(directory, `.write-probe-${randomUUID()}`);
  const file = await open(probe, "wx");
  await file.close();
  await rm(probe);
  return true;
}
