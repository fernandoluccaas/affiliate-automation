import { runShopeeScheduledDiscoveryCommand } from "./scheduled-discovery-command";

const args = process.argv.slice(2);

runShopeeScheduledDiscoveryCommand(args)
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "FAILED" ? 2 : 0;
  })
  .catch(() => {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "FAILED",
          errorCode: "SHOPEE_SCHEDULED_DISCOVERY_STATUS_FAILED",
          externalRequests: 0,
          writes: 0,
          stateModified: false,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 2;
  });
