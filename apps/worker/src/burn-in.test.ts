import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { prisma } from "@affiliate/database";
import {
  assertBurnInDatabaseReady,
  createBurnInDependencies,
  validateBurnInEnvironment,
} from "./burn-in";

function safeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WORKER_BURN_IN_MODE: "true",
    WHATSAPP_WEB_DRY_RUN: "true",
    WORKER_REQUIRE_REDIS: "true",
    AFFILIATE_SUPERVISOR_MODE: "BURN_IN",
    AFFILIATE_SUPERVISOR_INSTANCE_ID: "a".repeat(32),
    ...overrides,
  };
}

describe("burn-in worker safety boundary", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["false", "false"],
  ])("fails closed when dry-run is %s", (_label, value) => {
    const env = safeEnv();
    if (value === undefined) delete env.WHATSAPP_WEB_DRY_RUN;
    else env.WHATSAPP_WEB_DRY_RUN = value;
    expect(validateBurnInEnvironment(env)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["WHATSAPP_WEB_DRY_RUN_REQUIRED"]),
    });
  });

  it.each([undefined, "", "false"])(
    "fails closed when required Redis is %s",
    (value) => {
      const env = safeEnv();
      if (value === undefined) delete env.WORKER_REQUIRE_REDIS;
      else env.WORKER_REQUIRE_REDIS = value;
      expect(validateBurnInEnvironment(env)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining(["WORKER_REQUIRE_REDIS_REQUIRED"]),
      });
    },
  );

  it.each([undefined, "", "false", "TRUE"])(
    "rejects an absent or invalid burn-in mode: %s",
    (value) => {
      const env = safeEnv();
      if (value === undefined) delete env.WORKER_BURN_IN_MODE;
      else env.WORKER_BURN_IN_MODE = value;
      expect(validateBurnInEnvironment(env).ok).toBe(false);
    },
  );

  it("accepts only the complete safe configuration", () => {
    expect(validateBurnInEnvironment(safeEnv())).toMatchObject({
      ok: true,
      config: { mode: "BURN_IN", smoke: false },
    });
  });

  it("blocks every business component without constructing a client", async () => {
    const dependencies = createBurnInDependencies();
    for (const dependency of Object.values(dependencies)) {
      await expect(dependency(new Date())).resolves.toMatchObject({
        burnInBlocked: true,
        workerComponentOutcome: { status: "SKIPPED" },
      });
    }
  });

  it("fails startup before heartbeat when PostgreSQL is unavailable", async () => {
    const client = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("connection failed")),
    } as unknown as typeof prisma;
    await expect(assertBurnInDatabaseReady(client)).rejects.toThrow("connection failed");
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("fails startup when the applied migration count differs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "affiliate-burn-in-"));
    await mkdir(join(workspace, "prisma/migrations/001_initial"), { recursive: true });
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ ready: 1 }])
      .mockResolvedValueOnce([{ count: 0n }]);
    const client = { $queryRaw: queryRaw } as unknown as typeof prisma;
    await expect(assertBurnInDatabaseReady(client, workspace)).rejects.toThrow(
      "BURN_IN_MIGRATIONS_PENDING",
    );
  });

  it("keeps the isolated entrypoint free of external integration imports", async () => {
    const sources = await Promise.all([
      readFile(new URL("./burn-in.ts", import.meta.url), "utf8"),
      readFile(new URL("./burn-in-entry.ts", import.meta.url), "utf8"),
    ]);
    expect(sources.join("\n")).not.toMatch(
      /playwright|publisher-connectors|marketplace|telegram|ollama|openai|whatsapp-web/i,
    );
  });
});
