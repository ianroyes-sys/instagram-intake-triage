import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { decide, ingest, mediaFile, readIntake } from "@/lib/server/intake";
import { runnable, startRun } from "@/lib/server/triage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IS_SNAP = process.env.NEXT_PUBLIC_MODE === "snapshot";
const TRIAGE_LOOP = "intake-triage";

/**
 * GET /api/intake                    → batches + your decisions + the installed-skill arsenal
 * GET /api/intake?media=<batch>/<f>  → one downloaded slide image (path-checked)
 */
export async function GET(req: NextRequest) {
  if (IS_SNAP) return NextResponse.json({ batches: [], decisions: {}, counts: {}, arsenal: { skills: [], plugins: [] }, offline: true });
  const media = req.nextUrl.searchParams.get("media");
  if (media) {
    const [batch, name] = media.split("/");
    const file = mediaFile(batch || "", name || "");
    if (!file) return new NextResponse("not found", { status: 404 });
    return new NextResponse(fs.readFileSync(file), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
    });
  }
  return NextResponse.json(readIntake());
}

/**
 * POST { action: "ingest", text, label?, triage? } — fetch captions/slides for every link in
 *      the pasted text into a new batch; with triage:true also asks the intake-triage loop to run
 * POST { action: "decide", key, decision: keep|dismiss|revisit|clear, note? } — your call on
 *      one item (key = "<batch>:<n>"); never edits the batch evidence
 * POST { action: "triage" } — request one intake-triage run for untriaged batches
 */
export async function POST(req: NextRequest) {
  if (IS_SNAP) return NextResponse.json({ offline: true }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    text?: string;
    label?: string;
    triage?: boolean;
    key?: string;
    decision?: string;
    note?: string;
  };

  if (body.action === "ingest") {
    const text = String(body.text || "");
    if (!/https?:\/\//.test(text)) return NextResponse.json({ error: "Paste at least one link." }, { status: 400 });
    try {
      const batch = await ingest(text, String(body.label || "Link drop"));
      let triage: { requested: boolean; blockedBy?: string } = { requested: false };
      if (body.triage) {
        const can = runnable(TRIAGE_LOOP);
        if (can.ok) startRun(TRIAGE_LOOP);
        triage = { requested: can.ok, ...(can.ok ? {} : { blockedBy: can.why }) };
      }
      return NextResponse.json({ ok: true, batch, triage });
    } catch (e) {
      return NextResponse.json({ error: `Couldn't fetch those links: ${(e as Error).message}` }, { status: 502 });
    }
  }

  if (body.action === "decide") {
    const key = String(body.key || "");
    const decision = String(body.decision || "");
    if (!/^[\d-]+:\d+$/.test(key)) return NextResponse.json({ error: "bad-key" }, { status: 400 });
    if (!["keep", "dismiss", "revisit", "clear"].includes(decision)) return NextResponse.json({ error: "bad-decision" }, { status: 400 });
    decide(key, decision as "keep", body.note);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "triage") {
    const can = runnable(TRIAGE_LOOP);
    if (!can.ok) return NextResponse.json({ error: `Triage loop is ${can.why}.`, blockedBy: can.why }, { status: 409 });
    startRun(TRIAGE_LOOP);
    return NextResponse.json({ ok: true, requested: TRIAGE_LOOP }, { status: 202 });
  }

  return NextResponse.json({ error: "unknown-action" }, { status: 400 });
}
