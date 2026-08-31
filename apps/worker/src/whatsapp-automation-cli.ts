import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  resolveWhatsAppAutomationConfiguration,
  type WhatsAppAutomationConfiguration,
} from "./whatsapp-automation";
import { runWithWorkerLeadership } from "./worker-leadership";

const RUNNER_LEADER_KEY = "affiliate:whatsapp-automation:leader";
const STOP_FILE = resolve(process.cwd(), ".local", "whatsapp-automation.stop");

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function stopRequested() {
  const supervisorStopFile = process.env.AFFILIATE_COMPONENT_STOP_FILE;
  const candidates = [STOP_FILE, ...(supervisorStopFile ? [supervisorStopFile] : [])];
  const states = await Promise.all(
    candidates.map((file) => access(file).then(() => true, () => false)),
  );
  return states.some(Boolean);
}

async function runOnce(
  configuration: WhatsAppAutomationConfiguration,
  instanceId: string,
  signal?: AbortSignal,
) {
  const { runWhatsAppAutomationRuntimeCycle } = await import(
    "./whatsapp-automation-runtime"
  );
  return runWhatsAppAutomationRuntimeCycle({
    configuration,
    runnerInstanceId: instanceId,
    ...(signal ? { signal } : {}),
  });
}

async function guardedRun(configuration: WhatsAppAutomationConfiguration) {
  return runWithWorkerLeadership({
    key: RUNNER_LEADER_KEY,
    run: (signal, instanceId) => runOnce(configuration, instanceId, signal),
  });
}

async function wait(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, ms);
    const abort = () => {
      clearTimeout(timer);
      resolveWait();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function start(configuration: WhatsAppAutomationConfiguration) {
  await rm(STOP_FILE, { force: true });
  return runWithWorkerLeadership({
    key: RUNNER_LEADER_KEY,
    run: async (signal, instanceId) => {
      const cycles = [];
      while (!signal.aborted && !(await stopRequested())) {
        cycles.push(await runOnce(configuration, instanceId, signal));
        await wait(configuration.intervalMs, signal);
      }
      return {
        status: "STOPPED",
        cycles: cycles.length,
        lastCycle: cycles.at(-1) ?? null,
      };
    },
  });
}

async function main() {
  const command = process.argv[2] ?? "status";
  const configuration = resolveWhatsAppAutomationConfiguration();
  if (command === "status") {
    return output({
      status: configuration.enabled ? configuration.mode : "OFF",
      ...configuration,
      browserOpened: false,
      sendCalled: false,
      stateModified: false,
    });
  }
  if (command === "stop") {
    await mkdir(dirname(STOP_FILE), { recursive: true });
    await writeFile(STOP_FILE, "stop\n", { encoding: "utf8", flag: "w" });
    return output({
      status: "STOP_REQUESTED",
      browserOpened: false,
      sendCalled: false,
      stateModified: true,
    });
  }
  if (!configuration.enabled || configuration.mode === "OFF") {
    return output({
      status: "OFF",
      blockers: configuration.blockers,
      browserOpened: false,
      sendCalled: false,
      stateModified: false,
    });
  }
  if (command === "preflight") {
    const dryRunConfiguration: WhatsAppAutomationConfiguration = {
      ...configuration,
      mode: "DRY_RUN",
      readyForLive: false,
    };
    return output(await guardedRun(dryRunConfiguration));
  }
  if (command === "once") return output(await guardedRun(configuration));
  if (command === "start") return output(await start(configuration));
  throw new Error("USAGE: status|preflight|once|start|stop");
}

main().catch((error) => {
  output({
    status: "FAILED",
    errorCode:
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "WHATSAPP_AUTOMATION_UNEXPECTED_FAILURE",
    browserOpened: false,
    sendCalled: false,
  });
  process.exitCode = 2;
});
