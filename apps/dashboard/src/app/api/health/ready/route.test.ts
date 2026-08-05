import { beforeEach, describe, expect, it, vi } from "vitest";

const collectOperationalStatus = vi.fn();
vi.mock("@affiliate/operations", () => ({ collectOperationalStatus }));

describe("dashboard readiness", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fails safely when a shared dependency is unavailable", async () => {
    collectOperationalStatus.mockResolvedValue({
      status: "NOT_READY",
      checkedAt: "2026-08-03T12:00:00.000Z",
      database: "ERROR",
      redis: "OK",
      migrations: { status: "UP_TO_DATE" },
      build: "AVAILABLE",
      worker: { state: "ONLINE" },
      workerContext: { humanActionRequired: true },
    });
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/postgresql:\/\/|redis:\/\/|password|token|cookie/i);
  });

  it("fails readiness when migrations are pending", async () => {
    collectOperationalStatus.mockResolvedValue({
      status: "NOT_READY",
      checkedAt: "2026-08-03T12:00:00.000Z",
      database: "OK",
      redis: "OK",
      migrations: { status: "PENDING" },
      build: "AVAILABLE",
      worker: { state: "ONLINE" },
      workerContext: { humanActionRequired: true },
    });
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { migrations: "PENDING" },
    });
  });

  it("exposes a sanitized active burn-in without process identifiers", async () => {
    collectOperationalStatus.mockResolvedValue({
      status: "READY",
      checkedAt: "2026-08-05T12:00:00.000Z",
      database: "OK",
      redis: "OK",
      migrations: { status: "UP_TO_DATE" },
      build: "AVAILABLE",
      worker: {
        state: "ONLINE",
        mode: "BURN_IN",
        burnInActive: true,
        leaderStatus: "ACTIVE",
        blockedCycles: 4,
        externalEffectsObserved: 0,
        businessChangesObserved: 0,
      },
      workerContext: { humanActionRequired: false },
    });
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ mode: "BURN_IN", burnInActive: true, blockedCycles: 4 });
    expect(JSON.stringify(body)).not.toMatch(/\bpid\b|postgresql:\/\/|redis:\/\//i);
  });
});
