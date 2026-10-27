// INTAKE — links you share to yourself (Instagram reels/carousels, repos, programs) and what
// the system did with each one. Source records are the batch files in data/intake/*.json,
// written by scripts/intake-fetch.mjs and filled in by the intake-triage loop. Your own
// keep/dismiss/revisit calls live separately in data/intake-decisions.json, so a re-triage
// never overwrites a decision and a decision never edits the evidence.
//
// The Arsenal half answers "what is actually installed": every skill Claude Code can load,
// where it came from, and whether an intake batch put it there (a .intake.json beside SKILL.md).

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

const ROOT = process.env.INTAKE_ROOT || process.cwd();
const DIR = path.join(ROOT, "data/intake");
const DECISIONS = path.join(ROOT, "data/intake-decisions.json");
const HOME = os.homedir();

export type IntakeVerdict =
  | "untriaged"
  | "installed"
  | "ported"
  | "queued"
  | "watch"
  | "proposed"
  | "reference"
  | "skipped";

export type IntakeItem = {
  n: number;
  url: string;
  platform: string;
  shortcode?: string | null;
  owner?: string;
  caption?: string;
  slides?: string[];
  fetchError?: string;
  kind?: string;
  title?: string;
  verdict: IntakeVerdict;
  reason?: string;
  actions?: string[];
  repos?: { name: string; url: string; stars?: number }[];
  installed?: { name: string; path: string }[];
  followups?: string[];
};

export type IntakeBatch = {
  id: string;
  label: string;
  receivedAt: string;
  status: "untriaged" | "triaging" | "triaged";
  triagedAt: string | null;
  summary: string | null;
  items: IntakeItem[];
};

export type Decision = { decision: "keep" | "dismiss" | "revisit"; at: string; note?: string };

export type ArsenalSkill = {
  name: string;
  description: string;
  scope: "global" | "vault" | "shared";
  path: string;
  source?: { repo: string; batch?: string; commit?: string };
};

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export function readBatches(): IntakeBatch[] {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(f))
    .map((f) => readJson<IntakeBatch | null>(path.join(DIR, f), null))
    .filter((b): b is IntakeBatch => !!b && Array.isArray(b.items))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export function readDecisions(): Record<string, Decision> {
  return readJson<Record<string, Decision>>(DECISIONS, {});
}

export function decide(key: string, decision: Decision["decision"] | "clear", note?: string) {
  const all = readDecisions();
  if (decision === "clear") delete all[key];
  else all[key] = { decision, at: new Date().toISOString(), ...(note ? { note: note.slice(0, 500) } : {}) };
  writeAtomic(DECISIONS, all);
}

/** A slide image, only if it is really one of ours — no path escapes out of data/intake/media. */
export function mediaFile(batch: string, name: string): string | null {
  if (!/^[\d-]+$/.test(batch) || !/^[\w-]+\.jpg$/.test(name)) return null;
  const file = path.join(DIR, "media", batch, name);
  return fs.existsSync(file) ? file : null;
}

function frontmatter(file: string): { name?: string; description?: string } {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return {};
  }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const get = (k: string) => {
    const line = m[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    if (!line) return undefined;
    let v = line[1].trim();
    if (v === "|" || v === ">" || v === ">-" || v === "|-") {
      const after = m[1].slice(m[1].indexOf(line[0]) + line[0].length).split("\n");
      v = after.filter((l) => /^\s+\S/.test(l)).slice(0, 4).map((l) => l.trim()).join(" ");
    }
    return v.replace(/^["']|["']$/g, "");
  };
  return { name: get("name"), description: get("description") };
}

function scan(dir: string, scope: ArsenalSkill["scope"]): ArsenalSkill[] {
  if (!fs.existsSync(dir)) return [];
  const out: ArsenalSkill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = path.join(dir, entry.name);
    const file = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = frontmatter(file);
    const prov = readJson<ArsenalSkill["source"] | null>(path.join(skillDir, ".intake.json"), null);
    out.push({
      name: fm.name || entry.name,
      description: (fm.description || "").slice(0, 240),
      scope,
      path: skillDir.replace(HOME, "~"),
      ...(prov ? { source: prov } : {}),
    });
  }
  return out;
}

export function readArsenal() {
  // Optional second skills root, e.g. a notes vault with its own .claude/skills folder.
  const vault = process.env.VAULT_PATH;
  const skills = [
    ...scan(path.join(HOME, ".claude/skills"), "global"),
    ...(vault ? scan(path.join(vault, ".claude/skills"), "vault") : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(HOME, ".claude/settings.json"), {});
  const plugins = Object.entries(settings.enabledPlugins || {})
    .filter(([, on]) => on)
    .map(([id]) => id)
    .sort();
  return { skills, plugins };
}

export function readIntake() {
  const batches = readBatches();
  const decisions = readDecisions();
  const counts: Record<string, number> = {};
  for (const b of batches) for (const it of b.items) counts[it.verdict] = (counts[it.verdict] || 0) + 1;
  return { batches, decisions, counts, arsenal: readArsenal() };
}

/** Run the fetcher out of process: it does network I/O and writes the batch atomically itself. */
export function ingest(text: string, label: string): Promise<{ id: string; items: number; captioned: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(ROOT, "scripts/intake-fetch.mjs"), "--stdin", "--json", "--label", label.slice(0, 80) || "Link drop"],
      { cwd: ROOT, timeout: 280_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split("\n").pop() || "fetch failed"));
        try {
          resolve(JSON.parse(stdout.trim().split("\n").pop() || "{}"));
        } catch {
          reject(new Error("fetcher returned no batch"));
        }
      },
    );
    child.stdin?.end(text.slice(0, 40_000));
  });
}
