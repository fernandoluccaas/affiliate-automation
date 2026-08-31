import { describe, expect, it } from "vitest";
import { whatsappWebDryRunExitCode } from "./whatsapp-web-cli-exit-code";

describe("WhatsApp Web dry-run CLI exit code", () => {
  it("returns a non-zero exit code for a semantic failure", () => {
    expect(whatsappWebDryRunExitCode("FAILED")).toBe(2);
  });

  it("returns zero only for a valid dry-run", () => {
    expect(whatsappWebDryRunExitCode("READY_TO_SEND")).toBe(0);
  });
});
