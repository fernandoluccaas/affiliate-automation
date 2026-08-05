import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectShopeeCsv, importShopeeCsv, sanitizeShopeeOperationalError, shopeeAffiliateStatus, shopeeOpenApiPreflight } from "./index";

function option(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function output(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fileFromWorkspace(value: string) {
  if (value.split(/[\\/]/).includes("..")) throw new Error("SHOPEE_CSV_PATH_INVALID");
  if (isAbsolute(value)) return value;
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..", value);
}

async function main() {
  const command = process.argv[2];
  if (command === "status") return output(shopeeAffiliateStatus());
  if (command === "preflight") {
    const status = shopeeAffiliateStatus();
    return output(status.mode === "OPEN_API" ? shopeeOpenApiPreflight() : { ...status, csvReady: status.mode === "CSV" });
  }
  const file = option("--file");
  if (!file) throw new Error("SHOPEE_CSV_FILE_REQUIRED");
  const resolvedFile = fileFromWorkspace(file);
  if (command === "inspect-csv") {
    const result = await inspectShopeeCsv(resolvedFile);
    return output({ status: "SHOPEE_IMPORT_INSPECTED", checksum: result.checksum, columns: result.columns, ...result.summary });
  }
  if (command === "import-csv") {
    const confirm = process.argv.includes("--confirm-import");
    const dryRun = process.argv.includes("--dry-run") || !confirm;
    return output(await importShopeeCsv({ file: resolvedFile, confirm, dryRun }));
  }
  throw new Error("SHOPEE_AFFILIATE_COMMAND_INVALID");
}

main().catch((error) => {
  output({ status: "SHOPEE_IMPORT_FAILED", errorCode: sanitizeShopeeOperationalError(error) });
  process.exitCode = 2;
});
