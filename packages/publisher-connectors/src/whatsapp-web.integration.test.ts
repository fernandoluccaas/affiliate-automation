import { describe, expect, it } from "vitest";
import {
  getWhatsAppWebRuntimeConfig,
  PlaywrightWhatsAppWebBrowserLauncher,
  resolveWhatsAppWebProfilePath,
} from "./index";

const enabled = process.env.WHATSAPP_WEB_REAL_TESTS === "true";

describe.skipIf(!enabled)("WhatsApp Web local browser smoke test", () => {
  it("opens Chromium with an isolated persistent profile without sending", async () => {
    const config = getWhatsAppWebRuntimeConfig(process.env);
    const launcher = new PlaywrightWhatsAppWebBrowserLauncher();
    expect(await launcher.isAvailable()).toBe(true);
    const session = await launcher.launchPersistent({
      userDataDir: resolveWhatsAppWebProfilePath(
        config.userDataRoot,
        "integration-test",
      ),
      headless: true,
      actionTimeoutMs: config.actionTimeoutMs,
      navigationTimeoutMs: config.navigationTimeoutMs,
      confirmationTimeoutMs: config.confirmationTimeoutMs,
    });
    try {
      await session.adapter.navigate();
      expect(["LOGIN_REQUIRED", "CONNECTED", "UNEXPECTED_STATE"]).toContain(
        await session.adapter.detectAuthenticationState(),
      );
    } finally {
      await session.close();
    }
  });
});
