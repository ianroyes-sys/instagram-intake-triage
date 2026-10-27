# Instagram Intake Triage

Paste the Instagram posts and reels you saved "for later", and an agent reads each one (caption and carousel slides), checks it against the tools you already run, and records a verdict: install this skill, track this opportunity, keep it as reference, or skip it with a reason.

It is the Intake tab of Omega, Ian's local dashboard, published as a standalone fetcher, an agent spec, and the extracted Next.js page and API route.

## Why

Saved posts are where good finds go to die. A carousel says "7 agent skills you need" or "paid fellowship, apply now", you save it, and it never gets looked at again. The useful part is usually hidden: the repo name is on slide 4, the "fellowship" costs $299 to attend, or the tool overlaps something already installed.

Intake splits the job in two. A plain script does the fetching, because Instagram hides captions from normal desktop requests and its image URLs expire within days. An agent does the judgment, and it has to ground every verdict in evidence: the official page, the actual repo, or what is already loaded.

## Features

- **Link extraction**: pulls every URL out of pasted text, dedupes Instagram posts by shortcode (so `/p/X`, `/reel/X` and `/<user>/p/X` count once), strips trailing punctuation, caps a drop at 80 links.
- **Caption and slide fetch**: reads the mobile `/embed/captioned/` page, parses its `contextJSON` for owner, media type, caption and every carousel child, and falls back to the rendered caption when that JSON is missing.
- **Slides saved locally**: up to 14 slide images per post are downloaded next to the batch, since the CDN links expire and the repo name or URL is often only in the images.
- **Failures recorded, not fatal**: a post that cannot be fetched keeps its URL and a `fetchError`; other links in the drop still land. Non-Instagram links are recorded as-is.
- **Atomic batch files**: each drop becomes `data/intake/<timestamp>.json` with every item at verdict `untriaged`. The fetcher never classifies.
- **Agent triage spec** (`loops/intake-triage.md`): classifies each item as `skill`, `opportunity`, `tool`, `course`, `news`, `reference` or `ad`; verifies opportunities on the official source and skips anything with a fee; confirms repos with `gh api`, reads clones without running them, and proposes an exact install command plus a security note.
- **Your decisions stay separate**: keep / dismiss / revisit calls go to `data/intake-decisions.json`, so a re-triage never overwrites them and a decision never edits the evidence.
- **Arsenal view**: the API lists every skill Claude Code can load from `~/.claude/skills` (and an optional second root), with provenance when an intake batch installed it, plus enabled plugins.

## How it works

```mermaid
flowchart LR
  P[Paste links<br/>/intake page or CLI] --> F[intake-fetch.mjs]
  F -->|mobile embed page| IG[(Instagram)]
  F --> B[(data/intake/&lt;id&gt;.json<br/>+ media/&lt;id&gt;/*.jpg)]
  B --> T[intake-triage agent<br/>loops/intake-triage.md]
  T -->|official pages, gh api,<br/>read-only clones| E[evidence]
  T -->|kind, verdict, reason,<br/>repos, followups| B
  B --> UI[/intake page]
  UI -->|keep / dismiss / revisit| D[(intake-decisions.json)]
  A[~/.claude/skills + plugins] --> UI
```

Verdicts the agent can write: `proposed` (fills a real gap; install command and security note in `followups`), `queued` / `watch` (verified opportunity, open now or later), `reference` (overlaps something that wins), `skipped` (fee, ineligible, bait, unsafe or off-mission). `installed` and `ported` are for work a human session finished afterwards. The agent has `outbound: none`: it never installs, never submits, and treats captions and READMEs as data, not instructions.

## Tech stack

- Node.js 20+ ES modules, built-in `fetch`, `node:test`; no npm dependencies
- Claude Code (or any agent runner) for the triage pass
- Next.js App Router + React + Tailwind classes + CSS Modules for the optional page (`omega-ui/`)

## Getting started

```bash
git clone https://github.com/ianroyes-sys/instagram-intake-triage.git
cd instagram-intake-triage
npm test                                   # 5 tests, Instagram faked, no network
node scripts/intake-fetch.mjs --file examples/links.txt --label "First drop"
echo "https://www.instagram.com/p/<shortcode>/" | node scripts/intake-fetch.mjs --stdin --json
```

Then run one triage pass over the oldest untriaged batch:

```bash
claude -p "$(cat loops/intake-triage.md)"
```

`examples/intake/2026-01-05-120000.json` shows a finished batch with fictional posts. Copy `.env.example` to `.env` for the variables below.

| Variable | Used by | Purpose |
|---|---|---|
| `INTAKE_DIR` | fetcher | Where batches and slides go (default `data/intake`) |
| `INTAKE_ROOT` | Next.js route | Project root holding `data/intake` and `scripts/` |
| `INTAKE_TRIAGE_COMMAND` | Next.js route | Shell command the "Run triage" button starts |
| `VAULT_PATH` | Arsenal view | Optional second folder with `.claude/skills` |
| `OPPORTUNITY_PROFILE` | triage agent | Your eligibility profile for opportunities |

### The page

`omega-ui/` is extracted source for a Next.js App Router project, not a standalone app: `app/intake/page.tsx`, `app/api/intake/route.ts`, `lib/server/intake.ts` (batches, decisions, path-checked slide serving, Arsenal scan) and `lib/server/triage.ts` (starts `INTAKE_TRIAGE_COMMAND`, blocked by a `STOP` file, `loops/paused/intake-triage`, or a run already in progress). It uses Omega's Tailwind theme tokens (`text-fog`, `border-hairline`, …), so expect to map those colors in your own config. It type-checks against Next.js and React types.

## Project structure

```
scripts/
  intake-fetch.mjs         Link extraction, Instagram caption/slide fetch, batch writer, CLI
  intake-fetch.test.mjs    node:test suite with a faked Instagram
loops/
  intake-triage.md         Agent spec: classify, verify, propose, write verdicts back
examples/
  links.txt                Fake link drop
  intake/                  A finished, fictional batch
  intake-decisions.json    Decision file shape
omega-ui/                  Next.js page, API route, server helpers, tsconfig + CSS module shim
```

## Status

Used in Omega on Ian's Mac since October 2026 as a manual lane: paste a drop, press "Fetch + triage". The fetcher depends on Instagram's public embed page, which Instagram can change without notice; when it does, items land with a `fetchError` or an empty caption instead of failing the batch. No login or cookies are used, so private posts cannot be read. All bundled data is fictional.

Built by [Ian Royes](https://github.com/ianroyes-sys)
