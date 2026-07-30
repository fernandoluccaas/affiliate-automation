import { describe, expect, it } from "vitest";
import {
  workerControlsFromValue,
  workerStatusFromValue,
} from "./worker-operations";

describe("worker operational view", () => {
  const now = new Date("2026-07-30T12:02:00.000Z");

  it("classifies online, stale and explicitly offline workers", () => {
    expect(
      workerStatusFromValue(
        { state: "ONLINE", heartbeatAt: "2026-07-30T12:01:30.000Z" },
        now,
      ).state,
    ).toBe("ONLINE");
    expect(
      workerStatusFromValue(
        { state: "ONLINE", heartbeatAt: "2026-07-30T11:59:00.000Z" },
        now,
      ).state,
    ).toBe("STALE");
    expect(
      workerStatusFromValue(
        { state: "OFFLINE", heartbeatAt: "2026-07-30T12:01:59.000Z" },
        now,
      ).state,
    ).toBe("OFFLINE");
  });

  it("reads pause flags without trusting malformed values", () => {
    expect(
      workerControlsFromValue({
        discoveryPaused: true,
        publicationPaused: "true",
      }),
    ).toEqual({
      discoveryPaused: true,
      publicationPaused: false,
    });
    expect(workerControlsFromValue(null)).toEqual({
      discoveryPaused: false,
      publicationPaused: false,
    });
  });

  it("exposes bounded next-run and error fields", () => {
    expect(
      workerStatusFromValue(
        {
          state: "ONLINE",
          heartbeatAt: "2026-07-30T12:01:30.000Z",
          nextRuns: {
            discovery: "2026-07-30T12:30:00.000Z",
            publication: "2026-07-30T12:05:00.000Z",
          },
          lastError: {
            component: "retry",
            at: "2026-07-30T11:50:00.000Z",
          },
        },
        now,
      ),
    ).toMatchObject({
      nextDiscovery: "2026-07-30T12:30:00.000Z",
      nextPublication: "2026-07-30T12:05:00.000Z",
      lastErrorComponent: "retry",
    });
  });
});
