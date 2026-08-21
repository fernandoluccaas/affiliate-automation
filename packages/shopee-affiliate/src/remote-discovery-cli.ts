import {
  getShopeeRemoteDiscoveryExitCode,
  runShopeeRemoteDiscoveryCommand,
} from "./remote-discovery-command";

const args = process.argv.slice(2);

runShopeeRemoteDiscoveryCommand(args)
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = getShopeeRemoteDiscoveryExitCode(args, result);
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
