import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { DatafeedSource } from "./types";

const LOCK_DIRECTORY = join(tmpdir(), "affiliate-shopee-datafeed-locks");

function safeLocation(location: string) {
  const trimmed = location.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error("SHOPEE_DATAFEED_PATH_INVALID");
  }
  if (!isAbsolute(trimmed) && trimmed.split(/[\\/]/).includes("..")) {
    throw new Error("SHOPEE_DATAFEED_PATH_TRAVERSAL");
  }
  const absolutePath = resolve(trimmed);
  if (extname(absolutePath).toLowerCase() !== ".csv") {
    throw new Error("SHOPEE_DATAFEED_CSV_REQUIRED");
  }
  return absolutePath;
}

async function acquireLocalLock(fingerprint: string) {
  await mkdir(LOCK_DIRECTORY, { recursive: true });
  const lockPath = join(LOCK_DIRECTORY, `${fingerprint}.lock`);
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(String(process.pid), "utf8");
    return async () => {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("SHOPEE_DATAFEED_ALREADY_PROCESSING");
    }
    throw error;
  }
}

export class LocalFileDatafeedSource implements DatafeedSource {
  readonly kind = "LOCAL_FILE" as const;

  async open(input: {
    location: string;
    maxBytes: number;
    signal?: AbortSignal;
  }) {
    const absolutePath = safeLocation(input.location);
    const information = await stat(absolutePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("SHOPEE_DATAFEED_FILE_NOT_FOUND");
      }
      throw error;
    });
    if (!information.isFile()) throw new Error("SHOPEE_DATAFEED_FILE_REQUIRED");
    if (information.size === 0) throw new Error("SHOPEE_DATAFEED_FILE_EMPTY");
    if (information.size > input.maxBytes) {
      throw new Error("SHOPEE_DATAFEED_FILE_TOO_LARGE");
    }
    const fingerprint = createHash("sha256")
      .update(`${absolutePath}\0${information.size}\0${information.mtimeMs}`)
      .digest("hex");
    const release = await acquireLocalLock(fingerprint);
    try {
      const stream = createReadStream(absolutePath, {
        highWaterMark: 64 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        metadata: {
          kind: "LOCAL_FILE" as const,
          name: basename(absolutePath),
          absolutePath,
          size: information.size,
          modifiedAt: information.mtime.toISOString(),
          fingerprint,
        },
        stream,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
}

export class RemoteUrlDatafeedSource implements DatafeedSource {
  readonly kind = "REMOTE_URL" as const;

  async open(): Promise<never> {
    throw new Error("SHOPEE_REMOTE_DATAFEED_DISABLED");
  }
}
