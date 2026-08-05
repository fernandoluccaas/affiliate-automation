import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BURN_IN_SESSION_FILE,
  completeManualBurnInSession,
  createManualBurnInSession,
  eventsForSession,
  readManualBurnInSession,
  readBurnInSessionObservations,
  sessionStatusView,
  updateManualBurnInSession,
} from "./burn-in-session";

const baseline = { fingerprint: "safe", entities: {} };
const leader = { exists: false, fingerprint: null };

async function workspace() {
  return mkdtemp(join(tmpdir(), "affiliate-manual-burn-in-"));
}

describe("manual burn-in session evidence", () => {
  it("creates an atomic confirmed session with its own baseline", async () => {
    const root = await workspace();
    const session = await createManualBurnInSession({
      workspaceRoot: root,
      baseline,
      findingsBefore: [{ code: "PREEXISTING" }],
      realLeaderBefore: leader,
      sessionId: "11111111-1111-4111-8111-111111111111",
      now: new Date("2026-08-05T19:29:00.000Z"),
    });
    expect(session).toMatchObject({ state: "ACTIVE", reportSource: "MANUAL", baseline });
    await expect(readManualBurnInSession(root)).resolves.toMatchObject({
      status: "VALID",
      session: { sessionId: session.sessionId },
    });
  });

  it("refuses an active or incomplete session", async () => {
    const root = await workspace();
    const session = await createManualBurnInSession({
      workspaceRoot: root, baseline, findingsBefore: [], realLeaderBefore: leader,
    });
    await expect(createManualBurnInSession({
      workspaceRoot: root, baseline, findingsBefore: [], realLeaderBefore: leader,
    })).rejects.toThrow("BURN_IN_SESSION_ALREADY_ACTIVE");
    await updateManualBurnInSession(root, { ...session, state: "INCOMPLETE" });
    await expect(createManualBurnInSession({
      workspaceRoot: root, baseline, findingsBefore: [], realLeaderBefore: leader,
    })).rejects.toThrow("BURN_IN_SESSION_INCOMPLETE");
  });

  it("fails closed for a corrupt session file", async () => {
    const root = await workspace();
    const file = join(root, BURN_IN_SESSION_FILE);
    await mkdir(join(root, ".local/ops"), { recursive: true });
    await writeFile(file, "{invalid", "utf8");
    const result = await readManualBurnInSession(root);
    expect(result.status).toBe("CORRUPT");
    expect(sessionStatusView(result)).toMatchObject({ state: "HUMAN_REVIEW_REQUIRED" });
  });

  it("separates a running session from an unrelated completed report", async () => {
    const root = await workspace();
    const session = await createManualBurnInSession({
      workspaceRoot: root, baseline, findingsBefore: [], realLeaderBefore: leader,
      sessionId: "22222222-2222-4222-8222-222222222222",
      now: new Date("2026-08-05T19:29:00.000Z"),
    });
    const view = sessionStatusView(
      await readManualBurnInSession(root),
      new Date("2026-08-05T19:30:00.000Z"),
    );
    expect(view).toMatchObject({ source: "MANUAL", state: "ACTIVE", elapsedSeconds: 60 });
    expect(view).not.toHaveProperty("reportSource", "SMOKE");
    expect(session.sessionId).not.toBe("old-smoke");
  });

  it("filters evidence by exact session id", () => {
    expect(eventsForSession([
      { sessionId: "current", event: "READY_VALIDATED" },
      { sessionId: "old", event: "LIVE_VALIDATED" },
    ], "current")).toEqual([{ sessionId: "current", event: "READY_VALIDATED" }]);
  });

  it("attributes live, ready and heartbeat observations to the current session", async () => {
    const root = await workspace();
    const session = await createManualBurnInSession({
      workspaceRoot: root, baseline, findingsBefore: [], realLeaderBefore: leader,
    });
    await writeFile(join(root, ".local/ops/burn-in-events.jsonl"), [
      JSON.stringify({ sessionId: "old", event: "READY_VALIDATED" }),
      JSON.stringify({ sessionId: session.sessionId, event: "LIVE_VALIDATED" }),
      JSON.stringify({ sessionId: session.sessionId, event: "READY_VALIDATED" }),
      JSON.stringify({ sessionId: session.sessionId, event: "HEARTBEAT_OBSERVED" }),
    ].join("\n"), "utf8");
    await expect(readBurnInSessionObservations(root, session.sessionId)).resolves.toEqual({
      liveObserved: true,
      readyObserved: true,
      heartbeatObserved: true,
    });
  });

  it("completes once, preserves the report and makes stop idempotent", async () => {
    const root = await workspace();
    const session = await createManualBurnInSession({
      workspaceRoot: root, baseline, findingsBefore: [], realLeaderBefore: leader,
      reportSource: "MANUAL_TEST",
    });
    const report = {
      reportSource: "MANUAL_TEST", sessionId: session.sessionId,
      status: "BURN_IN_SUCCEEDED", finishedAt: "2026-08-05T19:30:00.000Z",
      businessFingerprintUnchanged: true, residualProcesses: 0, residualLocks: 0,
    };
    await expect(completeManualBurnInSession({
      workspaceRoot: root, session, report, reportFile: ".local/ops/burn-in-report.json",
    })).resolves.toEqual({ alreadyCompleted: false });
    const first = await readFile(join(root, ".local/ops/burn-in-report.json"), "utf8");
    await expect(completeManualBurnInSession({
      workspaceRoot: root, session, report: { ...report, status: "BROKEN" },
      reportFile: ".local/ops/burn-in-report.json",
    })).resolves.toEqual({ alreadyCompleted: true });
    expect(await readFile(join(root, ".local/ops/burn-in-report.json"), "utf8")).toBe(first);
    expect(sessionStatusView(await readManualBurnInSession(root), new Date("2030-01-01T00:00:00.000Z")))
      .toMatchObject({ state: "COMPLETED" });
  });
});
