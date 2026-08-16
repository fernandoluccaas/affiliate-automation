import {
  runShopeeOpenApiSmoke,
  serializeShopeeOpenApiSmokeResult,
  type ShopeeOpenApiSmokeInput,
} from "./open-api-smoke";

function parseArguments(argv: readonly string[]): ShopeeOpenApiSmokeInput {
  const input: ShopeeOpenApiSmokeInput = {
    confirmLiveCall: false,
    subIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-live-call") {
      input.confirmLiveCall = true;
      continue;
    }
    if (["--origin-url", "--item-id", "--sub-id"].includes(argument ?? "")) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("SHOPEE_OPEN_API_SMOKE_ARGUMENT_MISSING");
      }
      index += 1;
      if (argument === "--origin-url") input.originUrl = value;
      if (argument === "--item-id") input.itemId = value;
      if (argument === "--sub-id") input.subIds?.push(value);
      continue;
    }
    throw new Error("SHOPEE_OPEN_API_SMOKE_ARGUMENT_INVALID");
  }
  return input;
}

async function main() {
  let input: ShopeeOpenApiSmokeInput;
  try {
    input = parseArguments(process.argv.slice(2));
  } catch (error) {
    const errorCode =
      error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SHOPEE_OPEN_API_SMOKE_ARGUMENT_INVALID";
    process.stdout.write(
      serializeShopeeOpenApiSmokeResult({
        success: false,
        requestAttempts: 0,
        errorCode,
        stateModified: false,
      }),
    );
    process.exitCode = 2;
    return;
  }
  const result = await runShopeeOpenApiSmoke(input);
  process.stdout.write(serializeShopeeOpenApiSmokeResult(result));
  if (!result.success) process.exitCode = 2;
}

void main();
