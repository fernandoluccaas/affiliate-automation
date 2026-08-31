import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveWhatsAppAutomationConfiguration,
  runWhatsAppAutomationCycle,
  type WhatsAppAutomationCycleDependencies,
} from "./whatsapp-automation";

function dependencies(
  overrides: Partial<WhatsAppAutomationCycleDependencies> = {},
): WhatsAppAutomationCycleDependencies {
  return {
    now: () => new Date("2026-08-28T15:00:00.000Z"),
    sentToday: vi.fn().mockResolvedValue(0),
    nextPublication: vi.fn().mockResolvedValue({ publicationId: "publication-1" }),
    preflight: vi.fn().mockResolvedValue({
      ready: true,
      reason: null,
      browserOpened: true,
    }),
    authorize: vi.fn().mockResolvedValue(undefined),
    dispatch: vi.fn().mockResolvedValue({
      status: "PUBLISHED",
      errorCode: null,
      browserOpened: true,
      sendCalled: true,
    }),
    ...overrides,
  };
}

describe("WhatsApp automation configuration", () => {
  it("keeps the Playwright runtime outside the main worker and OFF startup", () => {
    const mainWorker = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
    const pureRunner = readFileSync(
      resolve(process.cwd(), "src/whatsapp-automation.ts"),
      "utf8",
    );
    const cli = readFileSync(
      resolve(process.cwd(), "src/whatsapp-automation-cli.ts"),
      "utf8",
    );
    expect(mainWorker).not.toContain("whatsapp-automation-runtime");
    expect(pureRunner).not.toContain("publisher-connectors");
    expect(cli).toMatch(
      /await import\(\s*"\.\/whatsapp-automation-runtime"/u,
    );
  });

  it("defaults to OFF and never infers LIVE", () => {
    expect(resolveWhatsAppAutomationConfiguration({})).toMatchObject({
      enabled: false,
      mode: "OFF",
      readyForLive: false,
    });
    expect(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "unexpected",
      }),
    ).toMatchObject({ mode: "OFF", readyForLive: false });
  });

  it("requires both legacy real-send guards in LIVE", () => {
    expect(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "LIVE",
      }).readyForLive,
    ).toBe(false);
    expect(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "LIVE",
        WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED: "true",
        WHATSAPP_WEB_DRY_RUN: "false",
      }).readyForLive,
    ).toBe(true);
  });
});

describe("WhatsApp automation cycle", () => {
  it("does nothing in OFF without preflight or dispatch", async () => {
    const deps = dependencies();
    const result = await runWhatsAppAutomationCycle(
      resolveWhatsAppAutomationConfiguration({}),
      deps,
    );
    expect(result).toMatchObject({ status: "OFF", browserOpened: false, sendCalled: false });
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("runs preflight but cannot authorize or click in DRY_RUN", async () => {
    const deps = dependencies();
    const result = await runWhatsAppAutomationCycle(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "DRY_RUN",
      }),
      deps,
    );
    expect(result).toMatchObject({ status: "DRY_RUN", sendCalled: false });
    expect(deps.preflight).toHaveBeenCalledWith("publication-1");
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("authorizes and dispatches only one queue head in explicit LIVE", async () => {
    const deps = dependencies();
    const result = await runWhatsAppAutomationCycle(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "LIVE",
        WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED: "true",
        WHATSAPP_WEB_DRY_RUN: "false",
      }),
      deps,
    );
    expect(result).toMatchObject({ status: "PUBLISHED", sendCalled: true });
    expect(deps.authorize).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("blocks the cycle after DELIVERY_UNCERTAIN without retry", async () => {
    const deps = dependencies({
      dispatch: vi.fn().mockResolvedValue({
        status: "DELIVERY_UNCERTAIN",
        errorCode: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
        browserOpened: true,
        sendCalled: true,
      }),
    });
    const result = await runWhatsAppAutomationCycle(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "LIVE",
        WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED: "true",
        WHATSAPP_WEB_DRY_RUN: "false",
      }),
      deps,
    );
    expect(result).toMatchObject({
      status: "BLOCKED",
      reason: "WHATSAPP_WEB_DELIVERY_UNCERTAIN",
    });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("stops safely when singleton leadership is lost after preflight", async () => {
    let aborted = false;
    const deps = dependencies({
      aborted: () => aborted,
      preflight: vi.fn().mockImplementation(async () => {
        aborted = true;
        return { ready: true, reason: null, browserOpened: true };
      }),
    });
    const result = await runWhatsAppAutomationCycle(
      resolveWhatsAppAutomationConfiguration({
        WHATSAPP_AUTOMATION_ENABLED: "true",
        WHATSAPP_AUTOMATION_MODE: "LIVE",
        WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED: "true",
        WHATSAPP_WEB_DRY_RUN: "false",
      }),
      deps,
    );
    expect(result).toMatchObject({
      status: "BLOCKED",
      reason: "WHATSAPP_AUTOMATION_LEADERSHIP_LOST",
      sendCalled: false,
    });
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
