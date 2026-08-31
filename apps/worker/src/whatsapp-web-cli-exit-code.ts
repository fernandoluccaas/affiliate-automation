export function whatsappWebDryRunExitCode(
  status: "READY_TO_SEND" | "FAILED",
) {
  return status === "FAILED" ? 2 : 0;
}
