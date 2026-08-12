import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { parse } from "csv-parse";
import { identifyShopeeDatafeedSchema, rowObject } from "./schema";
import { LocalFileDatafeedSource } from "./source";
import type {
  DatafeedSource,
  ShopeeBrazilRow,
  ShopeeDatafeedFileSummary,
  ShopeeDatafeedIssue,
  ShopeeDatafeedProduct,
  ShopeeDatafeedSchema,
  ShopeeOfferProvider,
  ShopeeOfficialBrRow,
} from "./types";
import { normalizeShopeeDatafeedRow } from "./validation";

type ParsedRecord = {
  record: string[];
  info: { lines: number; records: number };
};

export type StreamShopeeDatafeedInput = {
  file: string;
  linksVerified: boolean;
  maxFileBytes: number;
  signal?: AbortSignal;
  source?: DatafeedSource;
  onProduct: (product: ShopeeDatafeedProduct) => Promise<void> | void;
  onIssue?: (issue: ShopeeDatafeedIssue) => Promise<void> | void;
};

export async function streamShopeeDatafeed(
  input: StreamShopeeDatafeedInput,
): Promise<ShopeeDatafeedFileSummary> {
  const startedAt = performance.now();
  const source = input.source ?? new LocalFileDatafeedSource();
  if (source.kind !== "LOCAL_FILE") {
    throw new Error("SHOPEE_REMOTE_DATAFEED_DISABLED");
  }
  const opened = await source.open({
    location: input.file,
    maxBytes: input.maxFileBytes,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const hash = createHash("sha256");
  let bytesRead = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.byteLength;
      if (bytesRead > input.maxFileBytes) {
        callback(new Error("SHOPEE_DATAFEED_FILE_TOO_LARGE"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const parser = parse({
    bom: true,
    columns: false,
    encoding: "utf8",
    info: true,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: 5 * 1024 * 1024,
  });
  opened.stream.pipe(meter).pipe(parser);
  let schema: ShopeeDatafeedSchema | null = null;
  let headers: string[] = [];
  let rowsProcessed = 0;
  let validRows = 0;
  let invalidRows = 0;
  let validProductUrls = 0;
  let candidateShortLinks = 0;
  let peakHeap = process.memoryUsage().heapUsed;
  try {
    for await (const entry of parser as AsyncIterable<ParsedRecord>) {
      if (input.signal?.aborted) throw new Error("SHOPEE_DATAFEED_ABORTED");
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      const values = entry.record;
      if (!schema) {
        headers = values;
        schema = identifyShopeeDatafeedSchema(headers);
        if (!schema) throw new Error("SHOPEE_DATAFEED_SCHEMA_UNSUPPORTED");
        continue;
      }
      rowsProcessed += 1;
      const line = entry.info.lines;
      if (values.length !== headers.length) {
        invalidRows += 1;
        await input.onIssue?.({
          source: opened.metadata.name,
          line,
          code: "COLUMN_COUNT_MISMATCH",
        });
        continue;
      }
      const raw = rowObject(headers, values) as
        ShopeeOfficialBrRow | ShopeeBrazilRow;
      const normalized = normalizeShopeeDatafeedRow({
        schema,
        row: raw,
        linksVerified: input.linksVerified,
      });
      if (!normalized.ok) {
        invalidRows += 1;
        await input.onIssue?.({
          source: opened.metadata.name,
          line,
          code: normalized.code,
        });
        continue;
      }
      validRows += 1;
      validProductUrls += 1;
      if (normalized.product.candidateAffiliateUrl) candidateShortLinks += 1;
      await input.onProduct(normalized.product);
    }
    if (!schema) throw new Error("SHOPEE_DATAFEED_HEADER_MISSING");
    return {
      name: opened.metadata.name,
      schema,
      size: opened.metadata.size,
      modifiedAt: opened.metadata.modifiedAt,
      fingerprint: opened.metadata.fingerprint,
      checksum: hash.digest("hex"),
      rowsProcessed,
      validRows,
      invalidRows,
      validProductUrls,
      candidateShortLinks,
      durationMs: Math.round(performance.now() - startedAt),
      approximatePeakHeapBytes: peakHeap,
    };
  } catch (error) {
    opened.stream.destroy();
    meter.destroy();
    parser.destroy();
    throw error;
  } finally {
    await opened.release();
  }
}

export class DatafeedOfferProvider implements ShopeeOfferProvider {
  readonly kind = "DATAFEED" as const;
  readonly available = true;

  async stream(input: {
    files: string[];
    linksVerified: boolean;
    maxFileBytes: number;
    signal?: AbortSignal;
    onProduct: (product: ShopeeDatafeedProduct) => Promise<void> | void;
    onIssue?: (issue: ShopeeDatafeedIssue) => Promise<void> | void;
  }) {
    const summaries: ShopeeDatafeedFileSummary[] = [];
    for (const file of input.files) {
      summaries.push(
        await streamShopeeDatafeed({
          file,
          linksVerified: input.linksVerified,
          maxFileBytes: input.maxFileBytes,
          ...(input.signal ? { signal: input.signal } : {}),
          onProduct: input.onProduct,
          ...(input.onIssue ? { onIssue: input.onIssue } : {}),
        }),
      );
    }
    return summaries;
  }
}
