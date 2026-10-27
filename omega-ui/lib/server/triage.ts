// Starts the intake-triage agent run from the API route.
//
// In Omega this called the loop engine (run.sh with STOP/paused/concurrency gates). Standalone,
// it runs whatever command you put in INTAKE_TRIAGE_COMMAND, for example:
//   INTAKE_TRIAGE_COMMAND='claude -p "$(cat loops/intake-triage.md)" --permission-mode acceptEdits'
// A STOP file or loops/paused/intake-triage blocks the run, same as the engine did.

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.env.INTAKE_ROOT || process.cwd();
const LOCK = path.join(ROOT, "data/intake/.triage.pid");

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function runnable(slug: string): { ok: boolean; why?: string } {
  if (!process.env.INTAKE_TRIAGE_COMMAND) return { ok: false, why: "not configured (set INTAKE_TRIAGE_COMMAND)" };
  if (fs.existsSync(path.join(ROOT, "STOP"))) return { ok: false, why: "halted" };
  if (fs.existsSync(path.join(ROOT, "loops/paused", slug))) return { ok: false, why: "paused" };
  try {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    if (pid > 1 && alive(pid)) return { ok: false, why: "running" };
  } catch { /* never run */ }
  return { ok: true };
}

export function startRun(_slug: string) {
  const child = spawn("/bin/sh", ["-c", process.env.INTAKE_TRIAGE_COMMAND || "true"], { cwd: ROOT, detached: true, stdio: "ignore" });
  if (child.pid) { fs.mkdirSync(path.dirname(LOCK), { recursive: true }); fs.writeFileSync(LOCK, String(child.pid)); }
  child.unref();
}
