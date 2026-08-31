import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const action = process.argv[2] ?? "Status";
if (!['Status', 'Preflight', 'Run'].includes(action)) {
  throw new Error('CLOUDFLARE_TUNNEL_ACTION_INVALID');
}
const script = resolve(process.cwd(), 'scripts/ops/cloudflare-named-tunnel.ps1');
const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true },
);
process.exitCode = result.status ?? 1;
