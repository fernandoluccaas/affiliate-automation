import { runShopeeRemoteDiscoveryCommand } from "./remote-discovery-command";

runShopeeRemoteDiscoveryCommand(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "FAILED") process.exitCode = 2;
    else if (result.status === "PARTIAL") process.exitCode = 1;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const errorCode = /^SHOPEE_[A-Z0-9_]+$/.test(message)
      ? message
      : "SHOPEE_REMOTE_DISCOVERY_FAILED";
    process.stdout.write(
      `${JSON.stringify({ status: "FAILED", errorCode, externalRequests: 0, writes: 0, stateModified: false }, null, 2)}\n`,
    );
    process.exitCode = 2;
  });
