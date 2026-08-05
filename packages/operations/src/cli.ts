import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "@affiliate/database";
import { acquireLock, getRedisKeyFingerprint } from "@affiliate/redis";
import {
  BURN_IN_REPORT_FILE,
  OPS_LOG_ROOT,
  OPERATIONS_WORKSPACE_ROOT,
  applyBackupRetention,
  collectOperationalStatus,
  collectStateAudit,
  captureBusinessStateSnapshot,
  compareBusinessStateSnapshots,
  createPostgresBackup,
  directoryFreeBytes,
  isFileInsideDirectory,
  latestBackup,
  logDirectoryStatus,
  resolveSafeBackupDirectory,
  readBurnInReport,
  rotateLogs,
  verifyPostgresBackup,
  withExclusiveFileLock,
  writableDirectory,
} from "./index";

const workspaceRoot = OPERATIONS_WORKSPACE_ROOT;

if (process.env.DATABASE_URL) {
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    process.env.POSTGRES_USER ||= decodeURIComponent(databaseUrl.username);
    process.env.POSTGRES_PASSWORD ||= decodeURIComponent(databaseUrl.password);
    process.env.POSTGRES_DB ||= databaseUrl.pathname.replace(/^\//, "");
  } catch {
    // Prisma will report a sanitized database readiness failure later.
  }
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command: string, args: string[], timeoutMs = 30_000) {
  return new Promise<{ ok: boolean; code: number | null; stdout: string }>(
    (resolvePromise) => {
      const child = spawn(command, args, {
        cwd: workspaceRoot,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      const timeout = setTimeout(() => child.kill(), timeoutMs);
      child.once("error", () => {
        clearTimeout(timeout);
        resolvePromise({ ok: false, code: null, stdout: "" });
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolvePromise({ ok: code === 0, code, stdout: stdout.trim() });
      });
    },
  );
}

async function verifyWithPgRestore(file: string) {
  return new Promise<boolean>((resolvePromise) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "--list",
      ],
      {
        cwd: workspaceRoot,
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    createReadStream(file).pipe(child.stdin);
    child.once("error", () => resolvePromise(false));
    child.once("close", (code) => resolvePromise(code === 0));
  });
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function dashboardPortCheck() {
  const available = await new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(3000, "127.0.0.1", () =>
      server.close(() => resolvePromise(true)),
    );
  });
  if (available) return "AVAILABLE" as const;
  try {
    const raw = await readFile(
      join(workspaceRoot, ".local/ops/components.json"),
      "utf8",
    );
    const components = JSON.parse(raw.replace(/^\uFEFF/, "")) as Array<{
      component?: string;
      pid?: number;
      status?: string;
    }>;
    const dashboard = components.find(
      (item) => item.component === "dashboard" && item.status === "RUNNING",
    );
    if (dashboard?.pid) {
      process.kill(dashboard.pid, 0);
      return "PROJECT_PROCESS" as const;
    }
  } catch {
    // An occupied port without a valid local component record is not accepted.
  }
  return "OCCUPIED_UNKNOWN" as const;
}

async function preflight(input: { burnIn?: boolean; print?: boolean } = {}) {
  const checks: Array<{
    name: string;
    status: "READY" | "WARNING" | "NOT_READY";
    action?: string;
  }> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 20 ? "READY" : "NOT_READY",
    ...(nodeMajor >= 20 ? {} : { action: "INSTALL_NODE_20_OR_NEWER" }),
  });
  const npmAvailable = Boolean(process.env.npm_execpath);
  checks.push({
    name: "npm",
    status: npmAvailable ? "READY" : "NOT_READY",
    ...(npmAvailable ? {} : { action: "INSTALL_NPM" }),
  });
  const requiredFiles = [
    "package.json",
    "prisma/schema.prisma",
    "docker-compose.yml",
    "apps/dashboard/.next/BUILD_ID",
  ];
  for (const file of requiredFiles) {
    checks.push({
      name: `file:${file}`,
      status: existsSync(join(workspaceRoot, file)) ? "READY" : "NOT_READY",
      ...(existsSync(join(workspaceRoot, file))
        ? {}
        : { action: file.includes(".next") ? "RUN_PRODUCTION_BUILD" : "RESTORE_REQUIRED_FILE" }),
    });
  }
  for (const name of ["DATABASE_URL", "AUTH_SECRET", "REDIS_URL"]) {
    checks.push({
      name: `env:${name}`,
      status: process.env[name] ? "READY" : "NOT_READY",
      ...(process.env[name] ? {} : { action: `CONFIGURE_${name}` }),
    });
  }
  checks.push({
    name: "env:WHATSAPP_WEB_DRY_RUN",
    status: process.env.WHATSAPP_WEB_DRY_RUN === "true" ? "READY" : "NOT_READY",
    ...(process.env.WHATSAPP_WEB_DRY_RUN === "true"
      ? {}
      : { action: "RESTORE_WHATSAPP_WEB_DRY_RUN_TRUE" }),
  });
  checks.push({
    name: "env:WORKER_REQUIRE_REDIS",
    status: process.env.WORKER_REQUIRE_REDIS === "true" ? "READY" : "NOT_READY",
    ...(process.env.WORKER_REQUIRE_REDIS === "true"
      ? {}
      : { action: "CONFIGURE_WORKER_REQUIRE_REDIS_TRUE" }),
  });
  if (input.burnIn) {
    checks.push({
      name: "env:WORKER_BURN_IN_MODE",
      status: process.env.WORKER_BURN_IN_MODE === "true" ? "READY" : "NOT_READY",
      ...(process.env.WORKER_BURN_IN_MODE === "true"
        ? {}
        : { action: "SET_WORKER_BURN_IN_MODE_TRUE_FOR_THIS_COMMAND" }),
    });
  }
  const docker = await run("docker.exe", ["version", "--format", "{{.Server.Version}}"]);
  const compose = await run("docker.exe", ["compose", "ps", "--format", "json"]);
  checks.push({
    name: "docker",
    status: docker.ok ? "READY" : "NOT_READY",
    ...(docker.ok ? {} : { action: "START_DOCKER_DESKTOP" }),
  });
  checks.push({
    name: "compose",
    status: compose.ok ? "READY" : "NOT_READY",
    ...(compose.ok ? {} : { action: "RUN_DOCKER_COMPOSE_UP" }),
  });
  const prismaCli = join(workspaceRoot, "node_modules/prisma/build/index.js");
  const schema = await run(process.execPath, [
    prismaCli,
    "validate",
    "--schema",
    "prisma/schema.prisma",
  ]);
  const migrations = await run(process.execPath, [
    prismaCli,
    "migrate",
    "status",
    "--schema",
    "prisma/schema.prisma",
  ]);
  checks.push({
    name: "prisma-client",
    status: existsSync(join(workspaceRoot, "node_modules/.prisma/client/index.js"))
      ? "READY"
      : "NOT_READY",
    ...(existsSync(join(workspaceRoot, "node_modules/.prisma/client/index.js"))
      ? {}
      : { action: "RUN_NPM_RUN_PRISMA_GENERATE" }),
  });
  checks.push({
    name: "prisma-schema",
    status: schema.ok ? "READY" : "NOT_READY",
    ...(schema.ok ? {} : { action: "FIX_PRISMA_SCHEMA" }),
  });
  checks.push({
    name: "migrations",
    status: migrations.ok ? "READY" : "NOT_READY",
    ...(migrations.ok ? {} : { action: "RUN_NPX_PRISMA_MIGRATE_DEPLOY_MANUALLY" }),
  });
  const backupDirectory = resolveSafeBackupDirectory(workspaceRoot);
  const logDirectory = resolve(workspaceRoot, OPS_LOG_ROOT);
  for (const [name, directory] of [
    ["backup-directory", backupDirectory],
    ["log-directory", logDirectory],
  ] as const) {
    try {
      await writableDirectory(directory);
      checks.push({ name, status: "READY" });
    } catch {
      checks.push({ name, status: "NOT_READY", action: "FIX_DIRECTORY_PERMISSIONS" });
    }
  }
  const dashboardPort = await dashboardPortCheck();
  checks.push({
    name: "dashboard-port",
    status: dashboardPort === "OCCUPIED_UNKNOWN" ? "NOT_READY" : "READY",
    ...(dashboardPort === "OCCUPIED_UNKNOWN"
      ? { action: "IDENTIFY_PROCESS_USING_LOCAL_PORT_3000" }
      : {}),
  });
  const freeBytes = await directoryFreeBytes(workspaceRoot);
  const minimumBytes = Number(process.env.AFFILIATE_MIN_FREE_DISK_MB ?? 2048) * 1_048_576;
  checks.push({
    name: "disk-space",
    status: freeBytes >= minimumBytes ? "READY" : "NOT_READY",
    ...(freeBytes >= minimumBytes ? {} : { action: "FREE_DISK_SPACE" }),
  });
  const status = await collectOperationalStatus(prisma, { workspaceRoot });
  checks.push({
    name: "database",
    status: status.database === "OK" ? "READY" : "NOT_READY",
    ...(status.database === "OK" ? {} : { action: "START_POSTGRESQL" }),
  });
  checks.push({
    name: "redis",
    status: status.redis === "OK" ? "READY" : "NOT_READY",
    ...(status.redis === "OK" ? {} : { action: "START_REDIS" }),
  });
  checks.push({
    name: "worker-heartbeat",
    status:
      status.workerContext.heartbeatSeverity === "CRITICAL"
        ? "NOT_READY"
        : status.workerContext.heartbeatSeverity === "WARNING"
          ? "WARNING"
          : "READY",
    ...(status.worker.state === "STALE"
      ? {
          action:
            status.workerContext.heartbeatAction ??
            "START_OR_INSPECT_CONTINUOUS_WORKER",
        }
      : {}),
  });
  if (input.burnIn) {
    const supervisorConsistent =
      status.supervisor.state === "STOPPED" &&
      status.components.every(
        (component) =>
          component.status === "STOPPED" &&
          !["CRASH", "UNEXPECTED_EXIT"].includes(
            component.lastExitReason ?? "",
          ),
      );
    checks.push({
      name: "burn-in-supervisor-stopped",
      status: supervisorConsistent ? "READY" : "NOT_READY",
      ...(supervisorConsistent
        ? {}
        : { action: "STOP_AND_INSPECT_SUPERVISOR_BEFORE_BURN_IN" }),
    });
  }
  const backupMaxAgeHours = Number(
    process.env.AFFILIATE_BACKUP_MAX_AGE_HOURS ?? 36,
  );
  const backupCurrent =
    status.backup && status.backup.ageHours <= backupMaxAgeHours;
  checks.push({
    name: "database-backup",
    status: backupCurrent ? "READY" : "WARNING",
    ...(backupCurrent ? {} : { action: "RUN_OPS_BACKUP_DB" }),
  });
  const findings = status.database === "OK" ? await collectStateAudit(prisma, { workspaceRoot }) : [];
  const result = {
    status: checks.some((check) => check.status === "NOT_READY")
      ? "NOT_READY"
      : checks.some((check) => check.status === "WARNING")
        ? "READY_WITH_WARNINGS"
        : "READY",
    checkedAt: new Date().toISOString(),
    checks,
    operationalFindings: findings,
    mode: input.burnIn ? "BURN_IN" : "NORMAL",
  };
  if (input.print !== false) output(result);
  if (result.status === "NOT_READY" && input.print !== false) process.exitCode = 2;
  return result;
}

async function backupDb() {
  const directory = resolveSafeBackupDirectory(workspaceRoot);
  const result = await withExclusiveFileLock({
    directory,
    name: "postgres-backup",
    operation: async () => {
      const created = await createPostgresBackup({
        directory,
        verify: verifyWithPgRestore,
      });
      await applyBackupRetention({
        directory,
        maxAgeDays: Number(process.env.AFFILIATE_BACKUP_RETENTION_DAYS ?? 30),
        maxCount: Number(process.env.AFFILIATE_BACKUP_RETENTION_COUNT ?? 14),
      });
      return created;
    },
  });
  output({
    status: "BACKUP_CREATED",
    file: result.manifest.file,
    sizeBytes: result.manifest.sizeBytes,
    sha256: result.manifest.sha256,
    verified: true,
    directoryConfigured: true,
  });
}

async function backupStatus() {
  const directory = resolveSafeBackupDirectory(workspaceRoot);
  const backup = await latestBackup(directory);
  output({
    status: backup ? "AVAILABLE" : "MISSING",
    directoryConfigured: true,
    latest: backup
      ? {
          file: backup.manifest.file,
          createdAt: backup.manifest.createdAt,
          sizeBytes: backup.manifest.sizeBytes,
          sha256: backup.manifest.sha256,
          verified: backup.manifest.verified,
        }
      : null,
  });
}

async function verifyBackup() {
  const fileValue = option("--file");
  if (!fileValue) throw new Error("BACKUP_FILE_REQUIRED");
  const directory = resolveSafeBackupDirectory(workspaceRoot);
  const file = resolve(fileValue);
  if (!isFileInsideDirectory(directory, file)) {
    throw new Error("BACKUP_FILE_OUTSIDE_CONFIGURED_DIRECTORY");
  }
  const before = await stat(file);
  const result = await verifyPostgresBackup({
    file,
    manifestFile: `${file}.manifest.json`,
    verify: verifyWithPgRestore,
  });
  const after = await stat(file);
  output({
    status: "BACKUP_VALID",
    file: basename(file),
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    modified: before.mtimeMs !== after.mtimeMs || before.size !== after.size,
  });
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function scheduledOperationsTasksPresent() {
  const names = ["AffiliateAutomationSupervisor", "AffiliateAutomationBackup"];
  const installed: string[] = [];
  for (const name of names) {
    const result = await run("schtasks.exe", ["/Query", "/TN", name], 5_000);
    if (result.ok) installed.push(name);
  }
  return installed;
}

async function readEvents(file: string) {
  try {
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          return [value];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function residualOwnedProcesses() {
  try {
    const components = JSON.parse(
      (await readFile(join(workspaceRoot, ".local/ops/components.json"), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    ) as Array<{ pid?: number }>;
    return components.filter((component) => {
      if (!component.pid || component.pid <= 0) return false;
      try {
        process.kill(component.pid, 0);
        return true;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

async function writeBurnInReport(report: Record<string, unknown>) {
  const file = join(workspaceRoot, BURN_IN_REPORT_FILE);
  await mkdir(join(workspaceRoot, ".local/ops"), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2), "utf8");
  await rename(temporary, file);
}

async function runSupervisorSmoke(input: {
  durationSeconds: number;
  burnIn: boolean;
  testLeaderKey?: string;
}) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(workspaceRoot, "scripts/ops/supervisor.ps1"),
    "-Action",
    input.burnIn ? "BurnInSmoke" : "Smoke",
    "-DurationSeconds",
    String(input.durationSeconds),
  ];
  if (!input.burnIn) args.push("-NoJobs");
  if (input.burnIn && input.testLeaderKey) {
    args.push("-TestLeaderKey", input.testLeaderKey);
  }
  const child = spawn("powershell.exe", args, {
    cwd: workspaceRoot,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      ...(input.burnIn
        ? {
            WORKER_BURN_IN_MODE: "true",
            WORKER_BURN_IN_SMOKE: "true",
            WORKER_LEADER_KEY_OVERRIDE: input.testLeaderKey!,
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const close = new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
  return { child, close, stdout: () => stdout };
}

async function reliabilitySmoke() {
  const readiness = await preflight({ print: false });
  if (readiness.status === "NOT_READY") throw new Error("RELIABILITY_PREFLIGHT_FAILED");
  if ((await scheduledOperationsTasksPresent()).length > 0) {
    throw new Error("SCHEDULED_OPERATIONS_TASK_PRESENT");
  }
  const before = await captureBusinessStateSnapshot(prisma);
  const startedAt = new Date();
  const smoke = await runSupervisorSmoke({ durationSeconds: 8, burnIn: false });
  const exitCode = await smoke.close;
  const after = await captureBusinessStateSnapshot(prisma);
  const comparison = compareBusinessStateSnapshots(before, after);
  const residualProcesses = await residualOwnedProcesses();
  const raw = smoke.stdout().trim().split(/\r?\n/).at(-1) ?? "{}";
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  const success =
    exitCode === 0 &&
    evidence.status === "SMOKE_SUCCEEDED" &&
    comparison.unchanged &&
    residualProcesses === 0;
  const result = {
    status: success ? "RELIABILITY_SMOKE_SUCCEEDED" : "HUMAN_REVIEW_REQUIRED",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    processEvidence: evidence,
    businessFingerprintUnchanged: comparison.unchanged,
    changedEntities: comparison.changedEntities,
    residualProcesses,
  };
  output(result);
  if (!success) process.exitCode = 2;
}

async function burnInSmoke() {
  const durationSeconds = Number(option("--duration-seconds") ?? 60);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 600) {
    throw new Error("BURN_IN_DURATION_INVALID");
  }
  const readiness = await preflight({ burnIn: true, print: false });
  if (readiness.status === "NOT_READY") throw new Error("BURN_IN_PREFLIGHT_FAILED");
  if ((await scheduledOperationsTasksPresent()).length > 0) {
    throw new Error("SCHEDULED_OPERATIONS_TASK_PRESENT");
  }

  const eventFile = join(workspaceRoot, ".local/ops/burn-in-events.jsonl");
  await rm(eventFile, { force: true });
  const before = await captureBusinessStateSnapshot(prisma);
  const findingsBefore = await collectStateAudit(prisma, { workspaceRoot });
  const realLeaderBefore = await getRedisKeyFingerprint("affiliate:worker:leader");
  const testLeaderKey = `affiliate:test:worker:leader:${randomUUID()}`;
  const startedAt = new Date();
  const smoke = await runSupervisorSmoke({
    durationSeconds,
    burnIn: true,
    testLeaderKey,
  });
  let liveValidated = false;
  let readyValidated = false;
  const heartbeatSamples: number[] = [];
  const observationDeadline = Date.now() + (durationSeconds + 20) * 1_000;
  let closed = false;
  void smoke.close.finally(() => {
    closed = true;
  });
  while (!closed && Date.now() < observationDeadline) {
    try {
      const live = await fetch("http://127.0.0.1:3000/api/health/live", {
        signal: AbortSignal.timeout(2_000),
      });
      liveValidated ||= live.ok;
    } catch {
      // Startup is observed until the bounded supervisor deadline.
    }
    try {
      const ready = await fetch("http://127.0.0.1:3000/api/health/ready", {
        signal: AbortSignal.timeout(2_000),
      });
      if (ready.ok) {
        const body = (await ready.json()) as Record<string, unknown>;
        readyValidated ||= body.mode === "BURN_IN" && body.burnInActive === true;
      }
    } catch {
      // Readiness remains fail-closed until all dependencies are available.
    }
    try {
      const status = await collectOperationalStatus(prisma, { workspaceRoot });
      if (status.worker.lastHeartbeatAt) {
        const timestamp = Date.parse(status.worker.lastHeartbeatAt);
        if (
          Number.isFinite(timestamp) &&
          timestamp >= startedAt.getTime() &&
          !heartbeatSamples.includes(timestamp)
        ) {
          heartbeatSamples.push(timestamp);
        }
      }
    } catch {
      // Database loss is reflected by the final failed report.
    }
    await delay(500);
  }
  if (!closed) {
    await run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(workspaceRoot, "scripts/ops/supervisor.ps1"),
      "-Action",
      "Stop",
    ], 30_000);
  }
  let forcedStopTimer: NodeJS.Timeout | undefined;
  const exitCode = await Promise.race([
    smoke.close,
    new Promise<null>((resolvePromise) => {
      forcedStopTimer = setTimeout(() => {
        smoke.child.kill();
        resolvePromise(null);
      }, 10_000);
      forcedStopTimer.unref?.();
    }),
  ]);
  if (forcedStopTimer) clearTimeout(forcedStopTimer);
  await delay(500);
  const finishedAt = new Date();
  const after = await captureBusinessStateSnapshot(prisma);
  const findingsAfter = await collectStateAudit(prisma, { workspaceRoot });
  const comparison = compareBusinessStateSnapshots(before, after);
  const realLeaderAfter = await getRedisKeyFingerprint("affiliate:worker:leader");
  const probe = await acquireLock(testLeaderKey, 1_000, { requireRedis: true });
  const residualLocks = probe.acquired ? 0 : 1;
  if (probe.acquired) await probe.release();
  const residualProcesses = await residualOwnedProcesses();
  const events = await readEvents(eventFile);
  let componentEvidence: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(
      (await readFile(join(workspaceRoot, ".local/ops/components.json"), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    ) as unknown;
    componentEvidence = Array.isArray(parsed)
      ? parsed.map((item) =>
          item && typeof item === "object" ? (item as Record<string, unknown>) : {},
        )
      : [];
  } catch {
    componentEvidence = [];
  }
  const finalStatus = await collectOperationalStatus(prisma, { workspaceRoot });
  const leadershipRenewals = events.filter(
    (event) => event.event === "LEADERSHIP_RENEWED",
  ).length;
  const leadershipRenewalFailures = events.filter(
    (event) => event.event === "LEADERSHIP_RENEWAL_FAILED",
  ).length;
  const prohibitedEvents = events.filter((event) =>
    /BROWSER|PLAYWRIGHT|PUBLISHER|TELEGRAM|MERCADO_LIVRE|OLLAMA|OPENAI|DISPATCH/.test(
      String(event.event ?? ""),
    ),
  );
  const heartbeatGaps = heartbeatSamples
    .sort((a, b) => a - b)
    .slice(1)
    .map((value, index) => value - (heartbeatSamples[index] ?? value));
  const previousCodes = new Set(findingsBefore.map((finding) => finding.code));
  const afterCodes = new Set(findingsAfter.map((finding) => finding.code));
  const realLeaderUnchanged =
    realLeaderBefore.exists === realLeaderAfter.exists &&
    realLeaderBefore.fingerprint === realLeaderAfter.fingerprint;
  const success =
    exitCode === 0 &&
    liveValidated &&
    readyValidated &&
    comparison.unchanged &&
    residualProcesses === 0 &&
    residualLocks === 0 &&
    prohibitedEvents.length === 0 &&
    leadershipRenewals > 0 &&
    leadershipRenewalFailures === 0 &&
    realLeaderUnchanged;
  const humanActions = success
    ? []
    : ["PRESERVE_LOGS_AND_REVIEW_BURN_IN_FAILURE"];
  const report = {
    status: success ? "BURN_IN_SUCCEEDED" : "HUMAN_REVIEW_REQUIRED",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1_000),
    supervisorInstanceId:
      typeof events.find((event) => event.component === "supervisor")?.instanceId === "string"
        ? String(events.find((event) => event.component === "supervisor")?.instanceId).slice(0, 12)
        : null,
    workerInstanceId:
      typeof events.find((event) => event.event === "BURN_IN_RUNTIME_STARTED")
        ?.instanceId === "string"
        ? String(
            events.find((event) => event.event === "BURN_IN_RUNTIME_STARTED")
              ?.instanceId,
          ).slice(0, 12)
        : finalStatus.worker.instanceId,
    dashboardInstanceId:
      typeof componentEvidence.find((item) => item.component === "dashboard")?.instanceId ===
      "string"
        ? String(
            componentEvidence.find((item) => item.component === "dashboard")?.instanceId,
          ).slice(0, 12)
        : null,
    componentUptimeSeconds: Math.round(
      (finishedAt.getTime() - startedAt.getTime()) / 1_000,
    ),
    restartCount: componentEvidence.reduce(
      (total, item) => total + (typeof item.restartCount === "number" ? item.restartCount : 0),
      0,
    ),
    maxConsecutiveCrashes: componentEvidence.reduce(
      (maximum, item) =>
        Math.max(
          maximum,
          typeof item.consecutiveCrashes === "number" ? item.consecutiveCrashes : 0,
        ),
      0,
    ),
    burnInConfirmed: events.some((event) => event.event === "BURN_IN_RUNTIME_STARTED"),
    leaderKeyScope: "ISOLATED_TEST",
    leaderKeyFingerprint: createHash("sha256").update(testLeaderKey).digest("hex").slice(0, 12),
    leadershipChanges: events.filter((event) => event.event === "LEADERSHIP_ACQUIRED").length,
    leadershipRenewals,
    leadershipRenewalFailures,
    maxHeartbeatGapMs: heartbeatGaps.length > 0 ? Math.max(...heartbeatGaps) : 0,
    lastCycleStatus: finalStatus.worker.lastCycleStatus,
    blockedCycles: finalStatus.worker.blockedCycles,
    externalEffectsObserved: prohibitedEvents.length + finalStatus.worker.externalEffectsObserved,
    businessChangesObserved: comparison.changedEntities.length,
    businessFingerprintUnchanged: comparison.unchanged,
    changedEntities: comparison.changedEntities,
    liveValidated,
    readyValidated,
    shutdownValidated: residualProcesses === 0,
    residualProcesses,
    residualLocks,
    realLeaderKeyUnchanged: realLeaderUnchanged,
    findingsPreexisting: [...previousCodes].filter((code) => afterCodes.has(code)),
    findingsNew: [...afterCodes].filter((code) => !previousCodes.has(code)),
    findingsResolvedNaturally: [...previousCodes].filter((code) => !afterCodes.has(code)),
    humanActions,
  };
  await writeBurnInReport(report);
  output(report);
  if (!success) process.exitCode = 2;
}

async function burnInStart() {
  if (!process.argv.includes("--confirm-burn-in")) {
    throw new Error("BURN_IN_CONFIRMATION_REQUIRED");
  }
  const readiness = await preflight({ burnIn: true, print: false });
  if (readiness.status === "NOT_READY") throw new Error("BURN_IN_PREFLIGHT_FAILED");
  const result = await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(workspaceRoot, "scripts/ops/supervisor.ps1"),
    "-Action",
    "Start",
    "-BurnIn",
  ]);
  if (!result.ok) throw new Error("BURN_IN_START_FAILED");
  output({ status: "BURN_IN_START_REQUESTED", confirmationAccepted: true });
}

async function burnInStop() {
  const result = await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(workspaceRoot, "scripts/ops/supervisor.ps1"),
    "-Action",
    "Stop",
  ], 60_000);
  if (!result.ok) throw new Error("BURN_IN_STOP_FAILED");
  output({ status: "BURN_IN_STOPPED" });
}

function taskPreview(kind: "supervisor" | "backup") {
  output({
    status: "PREVIEW_ONLY",
    task: kind === "supervisor" ? "AffiliateAutomationSupervisor" : "AffiliateAutomationBackup",
    schedule: kind === "supervisor" ? "AT_LOGON" : "DAILY",
    repositoryConfigured: true,
    command:
      kind === "supervisor"
        ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>/scripts/ops/supervisor.ps1 -Action Run"
        : "npm.cmd run ops:backup-db",
    dispatchIncluded: false,
    playwrightIncluded: false,
    modifiesWindows: false,
  });
}

async function taskMutation(kind: "supervisor" | "backup", action: "install" | "remove") {
  const confirmation = action === "install" ? "--confirm-install" : "--confirm-remove";
  if (!process.argv.includes(confirmation)) {
    throw new Error(
      action === "install"
        ? "TASK_INSTALL_CONFIRMATION_REQUIRED"
        : "TASK_REMOVE_CONFIRMATION_REQUIRED",
    );
  }
  const result = await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(workspaceRoot, "scripts/ops/task-scheduler.ps1"),
    "-Action",
    action === "install" ? "Install" : "Remove",
    "-Task",
    kind === "supervisor" ? "Supervisor" : "Backup",
    action === "install" ? "-ConfirmInstall" : "-ConfirmRemove",
  ]);
  if (!result.ok) throw new Error("TASK_SCHEDULER_OPERATION_FAILED");
  output({
    status: action === "install" ? "INSTALLED" : "REMOVED",
    task: kind === "supervisor" ? "AffiliateAutomationSupervisor" : "AffiliateAutomationBackup",
    dispatchIncluded: false,
    playwrightIncluded: false,
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "preflight") return preflight();
  if (command === "burn-in-preflight") return preflight({ burnIn: true });
  if (command === "burn-in-start") return burnInStart();
  if (command === "burn-in-stop") return burnInStop();
  if (command === "burn-in-smoke") return burnInSmoke();
  if (command === "reliability-smoke") return reliabilitySmoke();
  if (command === "burn-in-report") {
    output({
      status: "BURN_IN_REPORT",
      report: await readBurnInReport(workspaceRoot),
      stateModified: false,
    });
    return;
  }
  if (command === "burn-in-status") {
    const status = await collectOperationalStatus(prisma, { workspaceRoot });
    output({
      status: status.worker.burnInActive ? "BURN_IN_RUNNING" : "BURN_IN_STOPPED",
      mode: status.worker.mode,
      worker: status.worker,
      supervisor: status.supervisor,
      report: await readBurnInReport(workspaceRoot),
      stateModified: false,
    });
    return;
  }
  if (command === "status") {
    const status = await collectOperationalStatus(prisma, { workspaceRoot });
    const findings =
      status.database === "OK" ? await collectStateAudit(prisma, { workspaceRoot }) : [];
    output({
      ...status,
      findings,
      lastBurnIn: await readBurnInReport(workspaceRoot),
      stateModified: false,
    });
    return;
  }
  if (command === "audit-state") {
    output({
      status: "AUDIT_COMPLETED",
      findings: await collectStateAudit(prisma, { workspaceRoot }),
      stateModified: false,
    });
    return;
  }
  if (command === "backup-db") return backupDb();
  if (command === "backup-status") return backupStatus();
  if (command === "verify-backup") return verifyBackup();
  if (command === "task-supervisor-preview") return taskPreview("supervisor");
  if (command === "task-backup-preview") return taskPreview("backup");
  if (command === "task-supervisor-install") return taskMutation("supervisor", "install");
  if (command === "task-supervisor-remove") return taskMutation("supervisor", "remove");
  if (command === "task-backup-install") return taskMutation("backup", "install");
  if (command === "task-backup-remove") return taskMutation("backup", "remove");
  if (command === "rotate-logs") {
    output(
      await rotateLogs({
        directory: resolve(workspaceRoot, OPS_LOG_ROOT),
        maxBytes: Number(process.env.AFFILIATE_LOG_MAX_MB ?? 20) * 1_048_576,
        retentionDays: Number(process.env.AFFILIATE_LOG_RETENTION_DAYS ?? 14),
      }),
    );
    return;
  }
  if (command === "log-status") {
    output(await logDirectoryStatus(resolve(workspaceRoot, OPS_LOG_ROOT)));
    return;
  }
  throw new Error("OPS_COMMAND_INVALID");
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "OPS_COMMAND_FAILED"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
