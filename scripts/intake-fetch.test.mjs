import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-test-"));
process.env.INTAKE_DIR = tmp;
const { extractLinks, ingest } = await import("./intake-fetch.mjs");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("IG posts/reels dedupe by shortcode, other links pass through, trailing punctuation dropped", () => {
  const links = extractLinks(`
    Posts shared:
    https://www.instagram.com/p/EXAMPLEpost1/
    https://www.instagram.com/reel/EXAMPLEreel2/,
    https://www.instagram.com/example_creator/p/EXAMPLEpost1/
    see https://github.com/example-org/example-skill.
  `);
  assert.deepEqual(
    links.map((l) => [l.platform, l.shortcode || l.url]),
    [
      ["instagram", "EXAMPLEpost1"],
      ["instagram", "EXAMPLEreel2"],
      ["web", "https://github.com/example-org/example-skill"],
    ],
  );
});

test("text without links yields nothing", () => {
  assert.equal(extractLinks("no links here").length, 0);
});

test("link list is capped at 80", () => {
  const text = Array.from({ length: 120 }, (_, i) => `https://example.com/${i}`).join("\n");
  assert.equal(extractLinks(text).length, 80);
});

// Fake Instagram: an /embed/captioned/ page whose contextJSON carries a two-slide carousel.
function fakeFetch(calls) {
  const media = {
    gql_data: {
      shortcode_media: {
        __typename: "GraphSidecar",
        owner: { username: "example_creator" },
        edge_media_to_caption: { edges: [{ node: { text: "5 agent skills worth installing. Slide 3 has the repo." } }] },
        edge_sidecar_to_children: { edges: [{ node: { display_url: "https://cdn.example.test/a.jpg" } }, { node: { display_url: "https://cdn.example.test/b.jpg" } }] },
      },
    },
  };
  const escaped = JSON.stringify(JSON.stringify(media)).slice(1, -1);
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes("/embed/captioned/")) {
      if (String(url).includes("BROKEN")) return new Response("nope", { status: 404 });
      return new Response(`<html><script>{"contextJSON":"${escaped}"}</script></html>`, { status: 200 });
    }
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
  };
}

test("ingest writes an untriaged batch with caption, owner and downloaded slides; fetch errors are recorded, not fatal", async (t) => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = fakeFetch(calls);
  t.after(() => { globalThis.fetch = real; });

  const batch = await ingest(
    "https://www.instagram.com/p/EXAMPLEpost1/ https://www.instagram.com/p/BROKEN123/ https://example.com/program",
    "Test drop",
  );
  assert.equal(batch.status, "untriaged");
  assert.equal(batch.items.length, 3);
  const [ok, broken, web] = batch.items;
  assert.equal(ok.owner, "example_creator");
  assert.match(ok.caption, /agent skills/);
  assert.deepEqual(ok.slides, ["EXAMPLEpost1_00.jpg", "EXAMPLEpost1_01.jpg"]);
  assert.ok(fs.existsSync(path.join(tmp, "media", batch.id, "EXAMPLEpost1_01.jpg")));
  assert.match(broken.fetchError, /HTTP 404/);
  assert.equal(web.platform, "web");
  assert.ok(batch.items.every((i) => i.verdict === "untriaged"));
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, `${batch.id}.json`), "utf8"));
  assert.equal(saved.items.length, 3);
  assert.ok(!calls.some((u) => u.includes("example.com/program")), "non-Instagram links are recorded, not fetched");
});

test("ingest refuses input with no links", async () => {
  await assert.rejects(() => ingest("nothing to see"), /no links found/);
});
