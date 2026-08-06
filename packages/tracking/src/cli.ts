import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attributionConfiguration,
  attributionPreflight,
  collectTrackingRetentionReport,
  importFinancialCsv,
  inspectFinancialCsv,
  sanitizeFinancialOperationError,
  trackingConfiguration,
  trackingPreflight,
  type FinancialCsvMarketplace,
  type FinancialImportType,
} from "./index";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function workspaceFile(value: string) {
  if (value.split(/[\\/]/).includes("..")) throw new Error("FINANCIAL_CSV_PATH_INVALID");
  return isAbsolute(value)
    ? value
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../..", value);
}

function marketplace(): FinancialCsvMarketplace {
  const value = option("--marketplace");
  if (value !== "MERCADO_LIVRE" && value !== "SHOPEE") {
    throw new Error("MARKETPLACE_MUST_BE_MERCADO_LIVRE_OR_SHOPEE");
  }
  return value;
}

function formatOptions() {
  const date = option("--date-format");
  const decimal = option("--decimal-format");
  if (date && date !== "ISO" && date !== "BR") throw new Error("DATE_FORMAT_MUST_BE_ISO_OR_BR");
  if (decimal && decimal !== "DOT" && decimal !== "BR") throw new Error("DECIMAL_FORMAT_MUST_BE_DOT_OR_BR");
  return {
    ...(date ? { dateFormat: date as "ISO" | "BR" } : {}),
    ...(decimal ? { decimalFormat: decimal as "DOT" | "BR" } : {}),
  };
}

function financialType(command: string): FinancialImportType {
  return command.startsWith("conversions") ? "CONVERSION" : "COMMISSION";
}

function usage() {
  return {
    status: "USAGE",
    commands: [
      "tracking-status",
      "tracking-preflight",
      "tracking-retention-report",
      "attribution-status",
      "attribution-preflight",
      "conversions-inspect-csv --file <CSV> --marketplace <MARKETPLACE>",
      "conversions-import-csv --file <CSV> --marketplace <MARKETPLACE> (--dry-run|--confirm-import)",
      "commissions-inspect-csv --file <CSV> --marketplace <MARKETPLACE>",
      "commissions-import-csv --file <CSV> --marketplace <MARKETPLACE> (--dry-run|--confirm-import)",
    ],
    stateModified: false,
  };
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "help" || process.argv.includes("--help")) return output(usage());
  if (command === "tracking-status") return output({ status: "TRACKING_STATUS", ...trackingConfiguration(), stateModified: false });
  if (command === "tracking-preflight") return output({ status: "TRACKING_PREFLIGHT", ...(await trackingPreflight()), stateModified: false });
  if (command === "tracking-retention-report") return output(await collectTrackingRetentionReport());
  if (command === "attribution-status") return output({ status: "ATTRIBUTION_STATUS", ...attributionConfiguration(), stateModified: false });
  if (command === "attribution-preflight") return output({ status: "ATTRIBUTION_PREFLIGHT", ...(await attributionPreflight()), stateModified: false });
  if (!/^(conversions|commissions)-(inspect|import)-csv$/.test(command)) throw new Error("ATTRIBUTION_COMMAND_INVALID");
  const file = option("--file");
  if (!file) throw new Error("FINANCIAL_CSV_FILE_REQUIRED");
  const type = financialType(command);
  const input = { file: workspaceFile(file), marketplace: marketplace(), type, ...formatOptions() };
  if (command.includes("-inspect-")) {
    const inspected = await inspectFinancialCsv(input);
    return output({
      event: type === "CONVERSION" ? "CONVERSION_IMPORT_INSPECTED" : "COMMISSION_IMPORT_INSPECTED",
      checksum: inspected.checksum,
      columns: inspected.columns,
      adapter: inspected.adapter,
      ...inspected.summary,
      stateModified: false,
    });
  }
  const dryRun = process.argv.includes("--dry-run");
  const confirmImport = process.argv.includes("--confirm-import");
  return output(await importFinancialCsv({ ...input, dryRun, confirmImport }));
}

main().catch((error) => {
  const command = process.argv[2] ?? "";
  const event = command.startsWith("conversions")
    ? "CONVERSION_IMPORT_FAILED"
    : command.startsWith("commissions")
      ? "COMMISSION_IMPORT_FAILED"
      : "FINANCIAL_OPERATION_FAILED";
  output({ event, status: "FAILED", errorCode: sanitizeFinancialOperationError(error), stateModified: false });
  process.exitCode = 2;
});
