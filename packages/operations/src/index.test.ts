import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBackupRetention,
  auditOperationalSnapshot,
  createPostgresBackup,
  isFileInsideDirectory,
  isOwnedProcess,
  nextSupervisorState,
  rotateLogs,
  resolveSafeBackupDirectory,
  sanitizeLogEntry,
  structuredLog,
  supervisorBackoffMs,
  verifyPostgresBackup,
  withExclusiveFileLock,
  type SupervisorComponentState,
} from "./index";

const now = new Date("2026-08-03T12:00:00.000Z");

function supervisorState(): SupervisorComponentState {
  return {
    component: "worker",
    pid: 123,
    instanceId: "instance-safe",
    startedAt: now.toISOString(),
    restartCount: 0,
    consecutiveCrashes: 0,
    status: "RUNNING",
    nextRestartAt: null,
    lastExitCode: null,
    lastExitReason: null,
  };
}

function auditInput() {
  return {
    now,
    heartbeat: {
      state: "ONLINE",
      lastHeartbeatAt: "2026-08-03T11:59:30.000Z",
    },
    heartbeatUpdatedAt: now,
    backupCreatedAt: now as Date | null,
    backupMaxAgeMs: 36 * 3_600_000,
    publications: [] as Array<{
      id: string;
      channelId: string;
      status: string;
      metadata: unknown;
    }>,
    channels: [] as Array<{ id: string; configuration: unknown }>,
    runningAutomationRuns: [] as Array<{ id: string; startedAt: Date }>,
    pendingAttempts: [] as Array<{
      id: string;
      publicationId: string;
      attemptedAt: Date;
    }>,
  };
}

describe("local supervisor policy", () => {
  it("increases backoff and stops after the configured crash limit", () => {
    expect(supervisorBackoffMs(1)).toBe(1_000);
    expect(supervisorBackoffMs(4)).toBe(8_000);
    const backoff = nextSupervisorState(supervisorState(), {
      requested: false,
      exitCode: 1,
      maxCrashes: 3,
      now,
    });
    expect(backoff).toMatchObject({ status: "BACKOFF", consecutiveCrashes: 1 });
    const failed = nextSupervisorState(
      { ...supervisorState(), consecutiveCrashes: 2 },
      { requested: false, exitCode: 1, maxCrashes: 3, now },
    );
    expect(failed).toMatchObject({ status: "FAILED", nextRestartAt: null });
  });

  it("distinguishes requested graceful stop from crash", () => {
    expect(
      nextSupervisorState(supervisorState(), {
        requested: true,
        exitCode: 0,
        maxCrashes: 3,
        now,
      }),
    ).toMatchObject({ status: "STOPPED", lastExitReason: "REQUESTED" });
  });

  it("does not consider an unrelated or stale PID owned", () => {
    expect(
      isOwnedProcess({
        expectedPid: 100,
        actualPid: 101,
        commandLine: "node external.js",
        repositoryRoot: "C:/Projetos/Afiliado",
        componentMarker: "production:worker",
      }),
    ).toBe(false);
    expect(
      isOwnedProcess({
        expectedPid: 100,
        actualPid: 100,
        commandLine:
          "npm run production:worker C:/Projetos/Afiliado production:worker",
        repositoryRoot: "C:/Projetos/Afiliado",
        componentMarker: "production:worker",
      }),
    ).toBe(true);
  });
});

describe("read-only operational state audit", () => {
  it("signals claimed without click without modifying metadata", () => {
    const input = auditInput();
    const metadata = {
      publicationMode: "WEB_EXPERIMENTAL",
      whatsappWebState: "SEND_IN_PROGRESS",
      sendAuthorizationStatus: "CLAIMED",
    };
    input.publications.push({
      id: "publication-one",
      channelId: "channel-one",
      status: "SCHEDULED",
      metadata,
    });
    const before = JSON.stringify(input);
    expect(auditOperationalSnapshot(input)).toContainEqual(
      expect.objectContaining({
        code: "WHATSAPP_CLAIM_ABANDONED_PRE_CLICK",
        severity: "HUMAN_REVIEW_REQUIRED",
      }),
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it("requires human review after click and for DELIVERY_UNCERTAIN", () => {
    const input = auditInput();
    input.publications.push({
      id: "publication-clicked",
      channelId: "channel-one",
      status: "PUBLICATION_FAILED",
      metadata: {
        publicationMode: "WEB_EXPERIMENTAL",
        whatsappWebState: "SEND_IN_PROGRESS",
        sendAuthorizationStatus: "CONSUMED",
        sendClickStartedAt: "2026-08-03T11:59:00.000Z",
        deliveryUncertain: true,
      },
    });
    const codes = auditOperationalSnapshot(input).map((item) => item.code);
    expect(codes).toContain("WHATSAPP_SEND_STARTED_REVIEW_REQUIRED");
    expect(codes).toContain("WHATSAPP_DELIVERY_UNCERTAIN");
  });

  it("classifies multiple active Publications as critical", () => {
    const input = auditInput();
    input.publications.push(
      {
        id: "one",
        channelId: "channel-one",
        status: "SCHEDULED",
        metadata: {
          publicationMode: "WEB_EXPERIMENTAL",
          whatsappWebState: "SEND_IN_PROGRESS",
        },
      },
      {
        id: "two",
        channelId: "channel-one",
        status: "SCHEDULED",
        metadata: {
          publicationMode: "WEB_EXPERIMENTAL",
          whatsappWebState: "DELIVERY_UNCERTAIN",
          deliveryUncertain: true,
        },
      },
    );
    expect(auditOperationalSnapshot(input)).toContainEqual(
      expect.objectContaining({
        code: "WHATSAPP_MULTIPLE_ACTIVE_PUBLICATIONS",
        severity: "CRITICAL",
      }),
    );
  });

  it("does not classify a normal waiting backlog as multiple active", () => {
    const input = auditInput();
    input.publications.push(
      {
        id: "waiting-one",
        channelId: "channel-one",
        status: "SCHEDULED",
        metadata: { publicationMode: "WEB_EXPERIMENTAL" },
      },
      {
        id: "waiting-two",
        channelId: "channel-one",
        status: "SCHEDULED",
        metadata: { publicationMode: "WEB_EXPERIMENTAL" },
      },
    );
    expect(auditOperationalSnapshot(input)).not.toContainEqual(
      expect.objectContaining({
        code: "WHATSAPP_MULTIPLE_ACTIVE_PUBLICATIONS",
      }),
    );
  });

  it("flags terminal Publications that still carry an active send state", () => {
    const input = auditInput();
    input.publications.push({
      id: "terminal-active",
      channelId: "channel-one",
      status: "PUBLISHED",
      metadata: {
        publicationMode: "WEB_EXPERIMENTAL",
        sendAuthorizationStatus: "CLAIMED",
      },
    });
    expect(auditOperationalSnapshot(input)).toContainEqual(
      expect.objectContaining({
        code: "WHATSAPP_ACTIVE_PUBLICATION_INCONSISTENT",
        severity: "CRITICAL",
      }),
    );
  });

  it("detects stale heartbeat and backup", () => {
    const input = auditInput();
    input.heartbeat = {
      state: "ONLINE",
      lastHeartbeatAt: "2026-08-03T10:00:00.000Z",
    };
    input.backupCreatedAt = null;
    const codes = auditOperationalSnapshot(input).map((item) => item.code);
    expect(codes).toContain("WORKER_HEARTBEAT_STALE");
    expect(codes).toContain("DATABASE_BACKUP_STALE");
  });
});

describe("safe PostgreSQL backups", () => {
  it("accepts ignored local or external backup directories and rejects versioned paths", () => {
    const workspace = resolve("C:/project/affiliate");
    expect(resolveSafeBackupDirectory(workspace, ".local/backups")).toBe(
      resolve(workspace, ".local/backups"),
    );
    expect(() => resolveSafeBackupDirectory(workspace, "docs/backups")).toThrow(
      "BACKUP_DIRECTORY_MUST_BE_LOCAL_IGNORED_OR_EXTERNAL",
    );
  });

  it("uses a temporary file, validates it, creates checksum and a secret-free manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "affiliate-backup-"));
    let temporaryName = "";
    const result = await createPostgresBackup({
      directory,
      now,
      dump: async (file) => {
        temporaryName = file;
        await writeFile(file, "valid-postgres-custom-backup");
      },
      verify: async () => true,
    });
    expect(temporaryName).toContain(".tmp");
    expect(result.manifest.sha256).toBe(
      createHash("sha256")
        .update("valid-postgres-custom-backup")
        .digest("hex"),
    );
    const manifest = await readFile(result.manifestFile, "utf8");
    expect(manifest).not.toMatch(/password|secret|token|cookie|postgresql:\/\//i);
    await expect(stat(temporaryName)).rejects.toThrow();
  });

  it("refuses empty and invalid backups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "affiliate-backup-"));
    await expect(
      createPostgresBackup({
        directory,
        now,
        dump: (file) => writeFile(file, ""),
        verify: async () => true,
      }),
    ).rejects.toThrow("BACKUP_EMPTY");
    await expect(
      createPostgresBackup({
        directory,
        now: new Date(now.getTime() + 1_000),
        dump: (file) => writeFile(file, "invalid"),
        verify: async () => false,
      }),
    ).rejects.toThrow("BACKUP_INVALID");
  });

  it("preserves an older valid backup when a new dump fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "affiliate-backup-"));
    const existing = join(directory, "affiliate-existing.dump");
    await writeFile(existing, "existing-valid");
    await expect(
      createPostgresBackup({
        directory,
        now,
        dump: async () => {
          throw new Error("DUMP_FAILED");
        },
      }),
    ).rejects.toThrow("DUMP_FAILED");
    await expect(readFile(existing, "utf8")).resolves.toBe("existing-valid");
  });

  it("prevents two backup operations from running concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "affiliate-backup-lock-"));
    let releaseFirst!: () => void;
    const hold = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      firstStarted = resolvePromise;
    });
    const first = withExclusiveFileLock({
      directory,
      name: "postgres-backup",
      operation: async () => {
        firstStarted();
        await hold;
        return "done";
      },
    });
    await started;
    await expect(
      withExclusiveFileLock({
        directory,
        name: "postgres-backup",
        operation: async () => "unexpected",
      }),
    ).rejects.toThrow("OPERATION_ALREADY_ACTIVE");
    releaseFirst();
    await expect(first).resolves.toBe("done");
  });

  it("verify is read-only and retention never removes outside the directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "affiliate-backup-"));
    const file = join(directory, "affiliate-safe.dump");
    await writeFile(file, "safe-backup");
    const before = await stat(file);
    await verifyPostgresBackup({ file, verify: async () => true });
    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(isFileInsideDirectory(directory, resolve(directory, "../external.dump"))).toBe(false);
    await applyBackupRetention({
      directory,
      now,
      maxAgeDays: 30,
      maxCount: 10,
    });
    await expect(readFile(file, "utf8")).resolves.toBe("safe-backup");
  });
});

describe("sanitized rotating logs and safe scripts", () => {
  it("removes secret and content fields from structured logs", () => {
    const sanitized = sanitizeLogEntry({
      event: "SAFE_EVENT",
      DATABASE_URL: "postgresql://secret",
      REDIS_URL: "redis://secret",
      caption: "private caption",
      token: "private-token",
    });
    expect(sanitized).toEqual({ event: "SAFE_EVENT" });
    const line = structuredLog({
      component: "worker",
      level: "info",
      event: "WORKER_HEARTBEAT",
      instanceId: "instance-safe",
      timestamp: now,
    });
    expect(line).toContain("WORKER_HEARTBEAT");
    expect(line).not.toContain("private");
  });

  it("rotates oversized closed logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "affiliate-logs-"));
    const file = join(directory, "worker.log");
    await writeFile(file, "1234567890");
    const result = await rotateLogs({
      directory,
      maxBytes: 5,
      retentionDays: 30,
      now,
    });
    expect(result.rotated).toHaveLength(1);
    await expect(stat(file)).rejects.toThrow();
  });

  it("Task Scheduler scripts default to preview and never contain dispatch", async () => {
    const script = await readFile(
      resolve(process.cwd(), "../../scripts/ops/task-scheduler.ps1"),
      "utf8",
    );
    expect(script).toContain('[string]$Action = "Preview"');
    expect(script).toContain("TASK_INSTALL_CONFIRMATION_REQUIRED");
    expect(script).toContain("TASK_REMOVE_CONFIRMATION_REQUIRED");
    expect(script).not.toContain("dispatch-authorized");
    expect(script).not.toContain("whatsapp:web:publish");
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["ops:task-supervisor:install"]).not.toContain(
      "confirm-install",
    );
    expect(packageJson.scripts["ops:task-backup:remove"]).not.toContain(
      "confirm-remove",
    );
  });

  it("worker and supervisor do not import Playwright or dispatch WhatsApp", async () => {
    const worker = await readFile(
      resolve(process.cwd(), "../../apps/worker/src/index.ts"),
      "utf8",
    );
    const supervisor = await readFile(
      resolve(process.cwd(), "../../scripts/ops/supervisor.ps1"),
      "utf8",
    );
    const dashboard = await readFile(
      resolve(process.cwd(), "../../apps/dashboard/src/app/operacoes/page.tsx"),
      "utf8",
    );
    const publicationsPage = await readFile(
      resolve(process.cwd(), "../../apps/dashboard/src/app/publicacoes/page.tsx"),
      "utf8",
    );
    const processHost = await readFile(
      resolve(process.cwd(), "../../scripts/ops/process-host.mjs"),
      "utf8",
    );
    expect(worker).not.toMatch(/playwright|dispatchAuthorizedWhatsApp/i);
    expect(supervisor).not.toMatch(/playwright|dispatch-authorized|whatsapp:web:publish/i);
    expect(supervisor).not.toMatch(/release-dispatch-claim/i);
    expect(supervisor).toContain("[System.IO.FileShare]::None");
    expect(supervisor).toContain("SUPERVISOR_ALREADY_ACTIVE");
    expect(supervisor).toContain("Test-OwnedProcess");
    expect(dashboard).not.toMatch(/dispatch-authorized|whatsapp:web:publish|Playwright/i);
    expect(publicationsPage).toContain('tabIndex={0}');
    expect(publicationsPage).toContain("sticky right-0");
    expect(processHost).toContain("contentHash");
    expect(processHost).not.toMatch(/playwright|dispatch-authorized|whatsapp:web:publish/i);
  });
});
