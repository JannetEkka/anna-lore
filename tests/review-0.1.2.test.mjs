// Anna's second App Review (Nov 17) found three things on a load that was NOT partial. Each test here
// reproduces one of them on a complete load. They failed on v0.1.1 and pass on v0.1.2.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as L from "../bundle/lore.js";
import { loadFixture, githubRoutes, fakeFetch } from "./github-fixture.mjs";

const snap = loadFixture();

/** The whole fixture, treated as read in full (every merged PR's files known, no rate limit). */
function fullGraph() {
  const prs = snap.prs.filter(p => p.state !== "merged" || p.files.length);
  const merged = prs.filter(p => p.state === "merged").length;
  return L.buildGraph({ ...snap, prs, files_for: merged, merged_total: merged, files_read: merged, partial: false }, snap.fetched_at);
}

/** A smaller repo read in full: the 14 merged PRs a rate-limited load reads, as if they were all there is.
 *  It has two areas with recent work where one active person has most of the activity. */
async function smallFullGraph() {
  const gh = L.makeGitHub({ fetchImpl: fakeFetch(githubRoutes(snap, { remaining: 20, reset: snap.fetched_at + 1800 })) });
  const f = await L.fetchRepo("FalkorDB/falkordb-py", { gh, now: snap.fetched_at * 1000 });
  const prs = f.prs.filter(p => p.state !== "merged" || p.files.length);
  const merged = prs.filter(p => p.state === "merged").length;
  return L.buildGraph({ ...f, prs, partial: false, rate_reset: null, files_for: merged, merged_total: merged, files_read: merged }, snap.fetched_at);
}

// --- Finding 1: "described a contributor as the only person who broadly understood the repository" ---

test("finding 1: on a complete load, an answer calling someone the only person who understands the repo is caught", async () => {
  const g = fullGraph();
  assert.equal(L.coverage(g).partial, false);
  const said = "@gkorland is the only person who broadly understands the repository [FalkorDB/falkordb-py#307].";
  const calls = [];
  const res = await L.runAgent(g, "Who knows the most about this project overall?", {
    complete: async ({ messages }) => {
      calls.push(messages);
      if (calls.length === 1) return '{"tool": "project_overview", "args": {}}';
      if (calls.length === 2) return JSON.stringify({ answer: said });
      // Lore asks once for a rewrite that says what the PRs show.
      return JSON.stringify({ answer: "@gkorland authored 19 of the 33 merged PRs Lore read [FalkorDB/falkordb-py#307]." });
    },
  });
  assert.ok(res, "the agent answered");
  assert.notEqual(res.text, said, "the overclaiming answer is not shown as it was written");
  assert.doesNotMatch(res.text, /only person|understands/i);
});

test("finding 1: the model is told on every load to describe activity, not understanding", () => {
  const p = L.systemPrompt(fullGraph());
  assert.match(p, /public GitHub activity/i);
  assert.match(p, /never say who understands/i);
});

test("finding 1: who_knows counts each PR once, so nobody seems to have written more PRs than exist", () => {
  const g = fullGraph();
  const merged = [...g.items.values()].filter(i => i.kind === "PR" && i.merged_at && i.areas.size).length;
  const top = L.runTool(g, "who_knows", { area_ids: [...g.areas.keys()] })[0];
  assert.equal(top.login, "gkorland");
  assert.ok(top.authored <= merged, `authored ${top.authored} of ${merged} merged PRs`);
  assert.equal(top.authored, 19);
});

// --- Finding 2: "treated limited public activity as proof that no one else understood certain areas" ---

test("finding 2: on a complete load, Knowledge risk lists the PRs and everyone on them, not 'only @x knows it'", async () => {
  const g = await smallFullGraph();
  assert.equal(L.coverage(g).partial, false);
  const rows = L.knowledgeRisk(g);
  const row = rows.find(r => r.area === "falkordb");
  assert.ok(row, `rows: ${rows.map(r => r.area)}`);
  // The supporting PRs, with links and dates.
  assert.deepEqual(row.prs?.map(p => p.id).sort(), ["FalkorDB/falkordb-py#267", "FalkorDB/falkordb-py#276", "FalkorDB/falkordb-py#307"]);
  for (const p of row.prs) assert.match(p.url, /^https:\/\/github\.com\/FalkorDB\/falkordb-py\/pull\/\d+$/);
  // Everyone active on those PRs, not only the top scorer.
  assert.deepEqual(row.people.map(p => p.login).sort(), ["Naseem77", "SantoshDhaladhuli", "barakb", "dudizimber", "swilly22"]);
  const text = L.riskText(row);
  const caveat = "It doesn't mean nobody else understands it.";
  assert.ok(text.includes(caveat), text);
  assert.doesNotMatch(text.replace(caveat, ""), /\bonly\b|nobody|no one|knows it well/i);
  assert.match(text, /3 merged PRs/);
  for (const n of [267, 276, 307]) assert.match(text, new RegExp(`#${n}\\b`));
});

test("finding 2: the app's own wording makes no claim about who understands the code", () => {
  const src = ["../bundle/app.js", "../bundle/index.html"].map(f => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  for (const bad of [/nobody else does/, /"only " \+ person/, /only \$\{person/, /knows it well/, /to prove it/, /bus factor of one/i, /Who knows the most/]) {
    assert.doesNotMatch(src, bad);
  }
});

test("finding 2: the sentence check runs on complete loads too, and a hedge doesn't excuse 'only @x knows'", () => {
  const g = fullGraph();
  for (const s of [
    "Only @gkorland knows falkordb/asyncio.",
    "Based on the fetched data, only @Naseem77 knows it well.",
    "@gkorland is the only person who broadly understands the repository.",
    "No one else understands the asyncio client.",
    "If @gkorland leaves, nobody else does.",
  ]) assert.equal(L.absoluteClaims(g, s).length, 1, s);
});

// --- Finding 3: "drafted an issue reply that made a commitment on behalf of the project team" ---

test("finding 3: on a complete load, a triage draft that promises a fix or volunteers someone is caught", async () => {
  const g = fullGraph();
  const issue = L.openIssues(g)[0].id;
  const promised = "Thanks for the report! We'll fix this in the next release. @gkorland will take a look this week.";
  let prompt = "";
  let n = 0;
  const t = await L.triage(g, issue, {
    complete: async ({ messages }) => {
      n++;
      if (n === 1) { prompt = messages[0].content; return promised; }
      return "Thanks for the report. [FalkorDB/falkordb-py#307] changed the same retry code, which @gkorland authored.";
    },
  });
  assert.doesNotMatch(prompt, /as a maintainer would write it/);
  assert.match(prompt, /no promises/i);
  assert.notEqual(t.draft, promised, "the promising draft is not shown as it was written");
  assert.doesNotMatch(t.draft, /we'll fix|next release|will take a look/i);
});

test("finding 3: commitments() flags promises, timelines and assignments, and leaves plain facts alone", () => {
  for (const s of [
    "We'll fix this in the next release.",
    "We will look into it.",
    "This will be fixed soon.",
    "It should land in 1.4.",
    "@gkorland will take a look.",
    "I'll pick this up by Friday.",
    "A fix is on its way.",
    "I've assigned this to @swilly22.",
  ]) assert.equal(L.commitments(s).length, 1, s);
  for (const s of [
    "Thanks for the report.",
    "[FalkorDB/falkordb-py#307] changed the same retry code.",
    "@gkorland authored #267, which touched this file.",
    "A maintainer may be able to say more.",
  ]) assert.deepEqual(L.commitments(s), [], s);
});
