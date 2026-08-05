import { startBurnInWorker } from "./burn-in";

startBurnInWorker()
  .then((result) => {
    if (result.status !== "COMPLETED") {
      process.stderr.write(`${result.status}\n`);
      process.exitCode = 2;
    }
  })
  .catch((error) => {
    const code =
      error instanceof Error && /^[A-Z0-9_,]+$/.test(error.message)
        ? error.message
        : "BURN_IN_WORKER_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  });
