"use client";

// INTAKE — every link you share to yourself (Instagram reels/carousels, repos, programs) and
// what the system did with it: installed, ported into an existing skill, queued with the
// opportunity tracker, kept as reference, or skipped with a reason. Paste new links at the top;
// the intake-triage loop does the reading. The Arsenal tab shows what Claude can actually load.

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../operations.module.css";

type Verdict = "untriaged" | "proposed" | "installed" | "ported" | "queued" | "watch" | "reference" | "skipped";
type Item = {
  n: number;
  url: string;
  owner?: string;
  caption?: string;
  slides?: string[];
  fetchError?: string;
  kind?: string;
  title?: string;
  verdict: Verdict;
  reason?: string;
  actions?: string[];
  repos?: { name: string; url: string }[];
  installed?: { name: string; path: string }[];
  followups?: string[];
};
type Batch = { id: string; label: string; receivedAt: string; status: string; triagedAt: string | null; summary: string | null; items: Item[] };
type Decision = { decision: "keep" | "dismiss" | "revisit"; at: string };
type Skill = { name: string; description: string; scope: string; path: string; source?: { repo: string; batch?: string; commit?: string } };
type Data = { batches: Batch[]; decisions: Record<string, Decision>; counts: Record<string, number>; arsenal: { skills: Skill[]; plugins: string[] } };

const VERDICT: Record<Verdict, { label: string; color: string; blurb: string }> = {
  installed: { label: "INSTALLED", color: "#7ef0b2", blurb: "Copied into Claude's skills and adapted to your setup." },
  ported: { label: "PORTED", color: "#b18cff", blurb: "The useful idea was merged into a system you already run." },
  queued: { label: "QUEUED", color: "#ffc861", blurb: "Handed to your opportunity tracker with verified evidence." },
  watch: { label: "WATCH", color: "#7cc8ff", blurb: "Real, but not open yet." },
  proposed: { label: "PROPOSED", color: "#ffc861", blurb: "Worth installing. The exact install and its security notes are listed; a session or you runs it." },
  untriaged: { label: "UNTRIAGED", color: "#d8cdea", blurb: "Fetched, waiting for the triage loop." },
  reference: { label: "REFERENCE", color: "#9fb4c9", blurb: "Worth knowing; no change to the system." },
  skipped: { label: "SKIPPED", color: "#ff8f8c", blurb: "Fee-based, ineligible, unsafe, or not worth it — reason given." },
};
const ORDER: Verdict[] = ["untriaged", "proposed", "installed", "ported", "queued", "watch", "reference", "skipped"];
const KINDS = ["all", "skill", "opportunity", "tool", "course", "news", "reference", "ad"] as const;

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export default function IntakePage() {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<"drops" | "arsenal">("drops");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const [verdict, setVerdict] = useState<Verdict | "all">("all");
  const [search, setSearch] = useState("");
  const [paste, setPaste] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    fetch("/api/intake", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d: Data) => {
        setLoadError(false);
        setData(d);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 45_000);
    return () => clearInterval(t);
  }, [load]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3500);
  };

  const batch = useMemo(() => {
    if (!data?.batches.length) return null;
    return data.batches.find((b) => b.id === batchId) ?? data.batches[0];
  }, [data, batchId]);

  const items = useMemo(() => {
    if (!batch) return [];
    const q = search.trim().toLowerCase();
    return batch.items.filter(
      (it) =>
        (kind === "all" || it.kind === kind) &&
        (verdict === "all" || it.verdict === verdict) &&
        (!q || `${it.title} ${it.owner} ${it.reason} ${it.caption} ${(it.repos || []).map((r) => r.name).join(" ")}`.toLowerCase().includes(q)),
    );
  }, [batch, kind, verdict, search]);

  const groups = useMemo(() => ORDER.map((v) => [v, items.filter((i) => i.verdict === v)] as const).filter(([, l]) => l.length), [items]);

  async function ingest(triage: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ingest", text: paste, label: label || "Link drop", triage }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Fetch failed");
      setPaste("");
      setLabel("");
      setBatchId(d.batch.id);
      flash(
        `${d.batch.items} links fetched (${d.batch.captioned} with captions).` +
          (triage ? (d.triage.requested ? " Triage loop started." : ` Triage loop ${d.triage.blockedBy}.`) : ""),
      );
      load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTriage() {
    const r = await fetch("/api/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "triage" }) });
    const d = await r.json().catch(() => ({}));
    flash(r.ok ? "Triage loop requested — check the triage log." : d.error || "Couldn't start triage.");
  }

  async function decide(key: string, decision: string) {
    setData((d) => {
      if (!d) return d;
      const next = { ...d.decisions };
      if (decision === "clear") delete next[key];
      else next[key] = { decision: decision as Decision["decision"], at: new Date().toISOString() };
      return { ...d, decisions: next };
    });
    await fetch("/api/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decide", key, decision }) }).catch(() => {});
  }

  const tally = (v: Verdict) => batch?.items.filter((i) => i.verdict === v).length ?? 0;
  const linkCount = (paste.match(/https?:\/\//g) || []).length;
  const skills = data?.arsenal.skills ?? [];
  const fromIntake = skills.filter((s) => s.source);

  return (
    <div className={styles.page} style={{ ["--ops-accent" as string]: "#7cc8ff" }}>
      <header className={`${styles.hero} fade-up`}>
        <div>
          <p className={styles.eyebrow}>Intake</p>
          <h1>Everything you sent yourself, sorted.</h1>
          <p className={styles.intro}>
            Paste links from Instagram, X, or GitHub. The fetcher reads the captions and the slides, compares each find against the system you
            already run, and then installs it, ports it, queues it as an opportunity, or explains why it was skipped.
          </p>
        </div>
        <div className={styles.heroActions}>
          <span className={styles.live}>{loadError ? "CONNECTION NEEDS ATTENTION" : data === null ? "READING INTAKE" : `${data.batches.length} DROP${data.batches.length === 1 ? "" : "S"} · ${skills.length} SKILLS LOADED`}</span>
        </div>
      </header>

      <section className="card mb-7 rounded-[20px] border border-hairline bg-[#0c0912] p-5" aria-label="New link drop">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-medium text-[#f3eef9]">New drop</h2>
          <span className="font-mono text-[10px] tracking-widest text-fog">{linkCount ? `${linkCount} LINK${linkCount === 1 ? "" : "S"} DETECTED` : "PASTE A MESSAGE, A FILE, OR BARE LINKS"}</span>
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={4}
          placeholder="https://www.instagram.com/p/…  https://github.com/owner/repo  …"
          className="mt-3 w-full resize-y rounded-xl border border-hairline bg-panel px-4 py-3 font-mono text-[12px] leading-relaxed text-white placeholder-fog/50 outline-none focus:border-[#7cc8ff]/50"
          aria-label="Links to ingest"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional) — e.g. IG saves, Oct 20" className={styles.search} style={{ marginLeft: 0, maxWidth: 360 }} aria-label="Drop label" />
          <button className={styles.filter} disabled={!linkCount || busy} onClick={() => ingest(false)}>
            {busy ? "Fetching…" : "Fetch only"}
          </button>
          <button className={styles.filter} aria-pressed disabled={!linkCount || busy} onClick={() => ingest(true)}>
            {busy ? "Fetching…" : "Fetch + triage"}
          </button>
        </div>
      </section>

      <div className={styles.toolbar} role="tablist" aria-label="Intake views">
        <button role="tab" className={styles.filter} aria-pressed={tab === "drops"} onClick={() => setTab("drops")}>Drops</button>
        <button role="tab" className={styles.filter} aria-pressed={tab === "arsenal"} onClick={() => setTab("arsenal")}>Arsenal · {skills.length}</button>
        {tab === "drops" && data && data.batches.length > 1 && (
          <select className={styles.filter} value={batch?.id} onChange={(e) => setBatchId(e.target.value)} aria-label="Choose drop">
            {data.batches.map((b) => (
              <option key={b.id} value={b.id}>{b.label} · {b.items.length} · {b.receivedAt.slice(0, 10)}</option>
            ))}
          </select>
        )}
      </div>

      {loadError && <div className={styles.error} role="alert">Could not refresh intake. Anything already shown is still there.<button onClick={load}>Retry</button></div>}
      {data === null && !loadError && <div className={styles.queue} role="status" aria-label="Loading intake"><div className={styles.skeleton} /><div className={styles.skeleton} /></div>}

      {tab === "drops" && data && !batch && (
        <div className={styles.empty}><strong>No drops yet.</strong><p>Paste a batch of links above to start.</p></div>
      )}

      {tab === "drops" && batch && (
        <>
          <div className={styles.telemetry} aria-label="Drop overview">
            {[
              { label: "Links", value: batch.items.length },
              { label: "Installed", value: tally("installed") },
              { label: "Ported", value: tally("ported") },
              { label: "Queued", value: tally("queued") },
              { label: "Skipped", value: tally("skipped") },
            ].map((m) => (
              <div className={styles.metric} key={m.label}><strong>{m.value}</strong><span>{m.label}</span></div>
            ))}
          </div>

          <div className="mb-6 rounded-2xl border border-hairline bg-[#0e0b15] px-5 py-4">
            <p className="font-mono text-[10px] tracking-widest text-fog">{batch.label.toUpperCase()} · RECEIVED {ago(batch.receivedAt).toUpperCase()} · {batch.status.toUpperCase()}{batch.triagedAt ? ` ${ago(batch.triagedAt).toUpperCase()}` : ""}</p>
            {batch.summary ? <p className="mt-2 text-[14px] leading-relaxed text-mist">{batch.summary}</p> : (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <p className="text-[13px] text-fog">Not triaged yet. The intake-triage loop reads every caption and slide, then decides.</p>
                <button className={styles.filter} aria-pressed onClick={runTriage}>Run triage</button>
              </div>
            )}
          </div>

          <div className={styles.toolbar} aria-label="Filter items">
            {KINDS.map((k) => (
              <button key={k} className={styles.filter} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {k === "all" ? `All · ${batch.items.length}` : `${k[0].toUpperCase()}${k.slice(1)} · ${batch.items.filter((i) => i.kind === k).length}`}
              </button>
            ))}
            <select className={styles.filter} value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict | "all")} aria-label="Filter by verdict">
              <option value="all">Any verdict</option>
              {ORDER.map((v) => <option key={v} value={v}>{VERDICT[v].label.toLowerCase()}</option>)}
            </select>
            <input className={styles.search} placeholder="Find a repo, program, creator…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />
          </div>

          {items.length === 0 ? (
            <div className={styles.empty}><strong>Nothing matches.</strong><p>Try another filter.</p><button className={`${styles.filter} mt-4`} onClick={() => { setKind("all"); setVerdict("all"); setSearch(""); }}>Clear filters</button></div>
          ) : (
            <div className={styles.groups}>
              {groups.map(([v, list]) => (
                <section key={v} className={styles.group} aria-labelledby={`g-${v}`}>
                  <div className={styles.groupHead}>
                    <h2 id={`g-${v}`} style={{ color: VERDICT[v].color }}>{VERDICT[v].label}</h2>
                    <span className={styles.groupCount}>{list.length}</span>
                    <p>{VERDICT[v].blurb}</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {list.map((it) => {
                      const key = `${batch.id}:${it.n}`;
                      const dec = data?.decisions[key];
                      const expanded = open.has(it.n);
                      return (
                        <article key={it.n} className="card fade-up flex min-w-0 flex-col rounded-2xl border border-hairline bg-[#0e0b15] p-4" style={{ borderLeft: `2px solid ${VERDICT[it.verdict].color}`, opacity: dec?.decision === "dismiss" ? 0.5 : 1 }}>
                          <div className="flex min-w-0 gap-3.5">
                            {it.slides?.[0] ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={`/api/intake?media=${batch.id}/${it.slides[0]}`} alt="" loading="lazy" className="h-[84px] w-[68px] shrink-0 rounded-lg border border-hairline object-cover" />
                            ) : (
                              <div className="flex h-[84px] w-[68px] shrink-0 items-center justify-center rounded-lg border border-hairline font-mono text-[9px] text-fog">#{it.n}</div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-[9px] tracking-widest text-fog">#{it.n} · {(it.kind || "link").toUpperCase()} · @{it.owner || "?"}{it.slides && it.slides.length > 1 ? ` · ${it.slides.length} SLIDES` : ""}</p>
                              <h3 className="mt-1 text-[14px] font-medium leading-snug text-[#f3eef9]">{it.title || it.caption?.slice(0, 90) || it.url}</h3>
                              {it.reason && <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">{it.reason}</p>}
                            </div>
                          </div>
                          {(it.installed?.length || it.actions?.length || it.followups?.length) ? (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {it.installed?.map((s) => <span key={s.name} title={s.path} className="rounded-full border border-[#7ef0b2]/40 bg-[#7ef0b2]/10 px-2 py-0.5 font-mono text-[10px] text-[#7ef0b2]">+ {s.name}</span>)}
                              {it.actions?.map((a) => <span key={a} className="rounded-full border border-[#b18cff]/35 bg-[#b18cff]/10 px-2 py-0.5 text-[11px] text-[#d8c6ff]">{a}</span>)}
                              {it.followups?.map((a) => <span key={a} className="rounded-full border border-[#ffc861]/40 bg-[#ffc861]/10 px-2 py-0.5 text-[11px] text-[#ffc861]">⚑ {a}</span>)}
                            </div>
                          ) : null}
                          {expanded && (
                            <div className="mt-3 space-y-3 border-t border-hairline pt-3">
                              {it.repos?.length ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {it.repos.map((r) => <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer" className="rounded-md border border-hairline px-2 py-1 font-mono text-[10.5px] text-[#9fd6ff] hover:border-[#7cc8ff]/50">{r.name} ↗</a>)}
                                </div>
                              ) : null}
                              {it.caption && <p className="max-h-48 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-fog">{it.caption}</p>}
                              {it.slides && it.slides.length > 1 && (
                                <div className="flex gap-2 overflow-x-auto pb-1">
                                  {it.slides.map((s) => (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <a key={s} href={`/api/intake?media=${batch.id}/${s}`} target="_blank" rel="noopener noreferrer"><img src={`/api/intake?media=${batch.id}/${s}`} alt="" loading="lazy" className="h-40 w-auto rounded-md border border-hairline" /></a>
                                  ))}
                                </div>
                              )}
                              {it.fetchError && <p className="text-[12px] text-[#ffafad]">Fetch failed: {it.fetchError}</p>}
                            </div>
                          )}
                          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                            <button onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(it.n)) n.delete(it.n); else n.add(it.n); return n; })} className="rounded-full border border-hairline px-3 py-1 font-mono text-[10px] tracking-widest text-mist" aria-expanded={expanded}>{expanded ? "LESS" : "DETAILS"}</button>
                            <a href={it.url} target="_blank" rel="noopener noreferrer" className="rounded-full border border-hairline px-3 py-1 font-mono text-[10px] tracking-widest text-mist">POST ↗</a>
                            <span className="ml-auto" />
                            {(["keep", "revisit", "dismiss"] as const).map((d) => (
                              <button key={d} onClick={() => decide(key, dec?.decision === d ? "clear" : d)} aria-pressed={dec?.decision === d} className={`rounded-full border px-2.5 py-1 font-mono text-[9.5px] tracking-widest ${dec?.decision === d ? "border-[#7cc8ff]/60 bg-[#7cc8ff]/15 text-[#bfe4ff]" : "border-hairline text-fog"}`}>{d.toUpperCase()}</button>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "arsenal" && data && (
        <>
          <div className={styles.telemetry} aria-label="Arsenal overview">
            {[
              { label: "Global skills", value: skills.filter((s) => s.scope === "global").length },
              { label: "Vault skills", value: skills.filter((s) => s.scope === "vault").length },
              { label: "Plugins on", value: data.arsenal.plugins.length },
              { label: "From intake", value: fromIntake.length },
            ].map((m) => <div className={styles.metric} key={m.label}><strong>{m.value}</strong><span>{m.label}</span></div>)}
          </div>
          <div className={styles.toolbar}>
            <input className={styles.search} style={{ marginLeft: 0 }} placeholder="Find a skill…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search skills" />
          </div>
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {skills
              .filter((s) => !search || `${s.name} ${s.description}`.toLowerCase().includes(search.toLowerCase()))
              .map((s) => (
                <div key={`${s.scope}:${s.path}`} className="min-w-0 rounded-xl border border-hairline bg-[#0e0b15] px-4 py-3" style={{ borderLeft: `2px solid ${s.source ? "#7ef0b2" : s.scope === "vault" ? "#b18cff" : "#7cc8ff"}` }}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate font-mono text-[12.5px] text-[#f3eef9]">{s.name}</p>
                    <span className="shrink-0 font-mono text-[9px] tracking-widest text-fog">{s.scope.toUpperCase()}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-fog">{s.description || "—"}</p>
                  {s.source && <p className="mt-1.5 font-mono text-[10px] text-[#7ef0b2]">from {s.source.repo}{s.source.commit ? `@${s.source.commit}` : ""}</p>}
                </div>
              ))}
          </div>
          <h2 className="mb-3 mt-9 font-mono text-[11px] tracking-[.18em] text-[#e6dcf3]">PLUGINS ENABLED</h2>
          <div className="flex flex-wrap gap-2">
            {data.arsenal.plugins.map((p) => <span key={p} className="rounded-full border border-hairline px-3 py-1 font-mono text-[11px] text-mist">{p}</span>)}
          </div>
        </>
      )}

      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-[#7cc8ff]/30 bg-panel-2/95 px-5 py-2.5 text-[13px] text-mist backdrop-blur-xl" role="status">{toast}</div>}
    </div>
  );
}
