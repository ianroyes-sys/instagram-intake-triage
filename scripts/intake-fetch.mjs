#!/usr/bin/env node
// INTAKE FETCH — turn a pile of shared links (mostly Instagram posts/reels) into a batch
// record the Intake room and the intake-triage loop can work from.
//
//   node scripts/intake-fetch.mjs --file links.txt [--label "IG drop"] [--json]
//   echo "<links>" | node scripts/intake-fetch.mjs --stdin
//
// Instagram hides captions from desktop fetches; the mobile-UA /embed/captioned/ page still
// carries the caption + carousel children in its contextJSON. Slide images are downloaded
// next to the batch because carousels usually hide the actual repo name/URL in the slides
// and Instagram CDN URLs expire within days. Non-Instagram links are recorded as-is.
//
// Writes data/intake/<id>.json atomically (override the folder with INTAKE_DIR). Never classifies — that is the triage loop's job,
// so every new item starts as verdict "untriaged".

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.INTAKE_DIR ? path.resolve(process.env.INTAKE_DIR) : path.join(ROOT, "data/intake");
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAX_LINKS = 80;
const MAX_SLIDES = 14;

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);

function readInput() {
  if (opt("--file")) return fs.readFileSync(opt("--file"), "utf8");
  if (flag("--stdin")) return fs.readFileSync(0, "utf8");
  throw new Error("usage: intake-fetch.mjs --file <links.txt> | --stdin");
}

export function extractLinks(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    const url = m[0].replace(/[.,;]+$/, "");
    const ig = url.match(/instagram\.com\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/);
    const key = ig ? `ig:${ig[2]}` : url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ig ? { url, platform: "instagram", shortcode: ig[2] } : { url, platform: "web" });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

const decode = (s) =>
  s
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, " ")
    .trim();

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function instagram(item, mediaDir) {
  const html = await fetchText(`https://www.instagram.com/p/${item.shortcode}/embed/captioned/`);
  let caption = "";
  let owner = "";
  let type = "";
  let images = [];
  const ctx = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/);
  if (ctx) {
    try {
      const sm = JSON.parse(JSON.parse(`"${ctx[1]}"`))?.gql_data?.shortcode_media || {};
      owner = sm.owner?.username || "";
      type = sm.__typename || "";
      caption = sm.edge_media_to_caption?.edges?.[0]?.node?.text || "";
      const kids = sm.edge_sidecar_to_children?.edges || [];
      images = (kids.length ? kids.map((k) => k.node?.display_url) : [sm.display_url]).filter(Boolean);
    } catch {
      /* fall through to the rendered caption */
    }
  }
  if (!caption) {
    const m = html.match(/class="Caption"([\s\S]*?)<\/div>/);
    if (m) caption = decode(m[1]);
    const o = caption.match(/^>?\s*([\w.]+)\s{2,}/);
    if (o && !owner) {
      owner = o[1];
      caption = caption.slice(o[0].length);
    }
    caption = caption.replace(/\s*View all( \d+)? comments\s*$/, "");
  }
  if (!images.length) {
    const m = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
    if (m) images = [m[1].replace(/&amp;/g, "&")];
  }
  const slides = [];
  for (const [i, src] of images.slice(0, MAX_SLIDES).entries()) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      fs.mkdirSync(mediaDir, { recursive: true });
      const name = `${item.shortcode}_${String(i).padStart(2, "0")}.jpg`;
      fs.writeFileSync(path.join(mediaDir, name), Buffer.from(await r.arrayBuffer()));
      slides.push(name);
    } catch {
      /* a missing slide is recorded by its absence; the caption still lands */
    }
  }
  return { owner, mediaType: type, caption: caption.trim(), slides, slideCount: images.length };
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export async function ingest(text, label = "Link drop") {
  const links = extractLinks(text);
  if (!links.length) throw new Error("no links found");
  const now = new Date();
  const id = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, "")}`;
  const mediaDir = path.join(DIR, "media", id);
  const items = [];
  let n = 0;
  for (const link of links) {
    n += 1;
    const base = { n, url: link.url, platform: link.platform, shortcode: link.shortcode || null, verdict: "untriaged" };
    if (link.platform !== "instagram") {
      items.push({ ...base, owner: "", caption: "", slides: [] });
      continue;
    }
    try {
      items.push({ ...base, ...(await instagram(link, mediaDir)) });
    } catch (e) {
      items.push({ ...base, owner: "", caption: "", slides: [], fetchError: String(e.message || e) });
    }
  }
  fs.mkdirSync(DIR, { recursive: true });
  const batch = { id, label, receivedAt: now.toISOString(), status: "untriaged", triagedAt: null, summary: null, items };
  writeAtomic(path.join(DIR, `${id}.json`), batch);
  return batch;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ingest(readInput(), opt("--label") || "Link drop")
    .then((b) => {
      const ok = b.items.filter((i) => i.caption).length;
      if (flag("--json")) console.log(JSON.stringify({ id: b.id, items: b.items.length, captioned: ok }));
      else console.log(`batch ${b.id}: ${b.items.length} links, ${ok} captioned → ${path.relative(process.cwd(), path.join(DIR, `${b.id}.json`))}`);
    })
    .catch((e) => {
      console.error(`intake-fetch: ${e.message || e}`);
      process.exit(1);
    });
}
