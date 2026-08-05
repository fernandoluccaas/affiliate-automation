import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const component = option("--component");
const script = option("--script");
const instanceId = option("--instance-id");
const repository = resolve(option("--repository") || process.cwd());
const stopFile = resolve(option("--stop-file") || "");

if (!['dashboard', 'worker'].includes(component) ||
    !['production:dashboard', 'production:worker', 'production:worker:burn-in'].includes(script) ||
    !/^[a-z0-9-]{8,}$/i.test(instanceId || '') ||
    !stopFile.startsWith(join(repository, ".local", "ops"))) {
  process.exitCode = 2;
  throw new Error("PROCESS_HOST_ARGUMENTS_INVALID");
}

const logDirectory = join(repository, ".local", "logs");
mkdirSync(logDirectory, { recursive: true });
const logFiles = {
  stdout: join(logDirectory, `${component}.stdout.jsonl`),
  stderr: join(logDirectory, `${component}.stderr.jsonl`),
};
const maxBytes = Math.max(1, Number(process.env.AFFILIATE_LOG_MAX_MB || 20)) * 1_048_576;
const retentionMs = Math.max(1, Number(process.env.AFFILIATE_LOG_RETENTION_DAYS || 14)) * 86_400_000;
const burnInEventFile = join(repository, ".local", "ops", "burn-in-events.jsonl");

function burnInEvent(event) {
  if (process.env.AFFILIATE_SUPERVISOR_MODE !== "BURN_IN") return;
  appendFileSync(
    burnInEventFile,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      component,
      event,
      instanceId: instanceId.slice(0, 12),
    })}\n`,
    "utf8",
  );
}

for (const name of readdirSync(logDirectory)) {
  if (!name.includes(".jsonl.")) continue;
  const file = join(logDirectory, name);
  try {
    if (Date.now() - statSync(file).mtimeMs > retentionMs) rmSync(file);
  } catch {
    // Active or concurrently managed files are never forced.
  }
}

function appendStructured(stream, entry) {
  const file = logFiles[stream];
  try {
    if (existsSync(file) && statSync(file).size >= maxBytes) {
      renameSync(file, `${file}.${new Date().toISOString().slice(0, 10)}.${Date.now()}`);
    }
  } catch {
    // A concurrent status/rotation operation must not stop the application.
  }
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function write(stream, level, event, line = "") {
  const normalized = String(line).replace(/[\r\n]+/g, " ").trim();
  const entry = {
    timestamp: new Date().toISOString(),
    component,
    level,
    event,
    instanceId: instanceId.slice(0, 12),
    stream,
    contentLength: normalized.length,
    contentHash: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
  };
  appendStructured(stream, entry);
}

function consume(stream, name) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) write(name, name === "stderr" ? "error" : "info", "APPLICATION_OUTPUT", line);
  });
  stream.on("end", () => {
    if (pending) write(name, name === "stderr" ? "error" : "info", "APPLICATION_OUTPUT", pending);
  });
}

const child = spawn(process.env.ComSpec || "cmd.exe", [
  "/d",
  "/s",
  "/c",
  `npm.cmd run ${script}`,
], {
  cwd: repository,
  env: { ...process.env, AFFILIATE_COMPONENT_STOP_FILE: stopFile },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
burnInEvent("PROCESS_HOST_STARTED");
consume(child.stdout, "stdout");
consume(child.stderr, "stderr");

let stopping = false;
let forcedStopTimer = null;
function stop() {
  if (stopping) return;
  stopping = true;
  if (script === "production:worker:burn-in" || script === "production:worker") {
    forcedStopTimer = setTimeout(() => {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }, 7_000);
    forcedStopTimer.unref();
    return;
  }
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const stopMonitor = setInterval(() => {
  if (existsSync(stopFile)) stop();
}, 250);
stopMonitor.unref();

child.once("error", () => {
  write("stderr", "error", "APPLICATION_PROCESS_ERROR");
  burnInEvent("PROCESS_HOST_ERROR");
  process.exitCode = 1;
});
child.once("close", (code) => {
  clearInterval(stopMonitor);
  if (forcedStopTimer) clearTimeout(forcedStopTimer);
  write("stdout", code === 0 ? "info" : "error", "APPLICATION_PROCESS_EXIT");
  burnInEvent(code === 0 ? "PROCESS_HOST_STOPPED" : "PROCESS_HOST_FAILED");
  process.exitCode = code ?? 1;
});
