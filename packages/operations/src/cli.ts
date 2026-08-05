import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "@affiliate/database";
import {
  OPS_LOG_ROOT,
  OPERATIONS_WORKSPACE_ROOT,
  applyBackupRetention,
  collectOperationalStatus,
  collectStateAudit,
  createPostgresBackup,
  directoryFreeBytes,
  isFileInsideDirectory,
  latestBackup,
  logDirectoryStatus,
  resolveSafeBackupDirectory,
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

async function preflight() {
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
    status: process.env.WHATSAPP_WEB_DRY_RUN !== "false" ? "READY" : "NOT_READY",
    ...(process.env.WHATSAPP_WEB_DRY_RUN !== "false"
      ? {}
      : { action: "RESTORE_WHATSAPP_WEB_DRY_RUN_TRUE" }),
  });
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
    status: status.worker.state === "STALE" ? "NOT_READY" : "READY",
    ...(status.worker.state === "STALE"
      ? { action: "START_OR_INSPECT_CONTINUOUS_WORKER" }
      : {}),
  });
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
    browserOpened: false,
    databaseModified: false,
  };
  output(result);
  if (result.status === "NOT_READY") process.exitCode = 2;
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
  if (command === "status") {
    const status = await collectOperationalStatus(prisma, { workspaceRoot });
    const findings =
      status.database === "OK" ? await collectStateAudit(prisma, { workspaceRoot }) : [];
    output({ ...status, findings, browserOpened: false, stateModified: false });
    return;
  }
  if (command === "audit-state") {
    output({
      status: "AUDIT_COMPLETED",
      findings: await collectStateAudit(prisma, { workspaceRoot }),
      stateModified: false,
      browserOpened: false,
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
