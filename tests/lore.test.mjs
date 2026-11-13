import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../bundle/lore.js";
import { loadFixture, githubRoutes, fakeFetch } from "./github-fixture.mjs";

const snap = loadFixture();
const g = L.buildGraph(snap, snap.fetched_at);

test("parseRepo accepts owner/repo and GitHub URLs", () => {
  assert.equal(L.parseRepo("pallets/flask"), "pallets/flask");
  assert.equal(L.parseRepo("https://github.com/pallets/flask/pulls?q=1"), "pallets/flask");
  assert.equal(L.parseRepo(" github.com/encode/httpx.git "), "encode/httpx");
  assert.equal(L.parseRepo("https://github.com/encode/httpx.git"), "encode/httpx");
  assert.equal(L.parseRepo("flask"), null);
});

test("parseRefs finds fixes and mentions", () => {
  const r = L.parseRefs("Fixes #12, see #7 and owner/repo#99 and http://x/#5");
  assert.deepEqual(r.fixes, [12]);
  assert.deepEqual(r.refs, [7, 12]);
});

test("planAreas splits a big directory", () => {
  const paths = Array.from({ length: 40 }, (_, i) => `src/core/mod${i % 4}/f${i}.py`).concat(["README.md", "docs/a.md"]);
  const areas = L.planAreas(paths);
  assert.ok(areas.has("src/core/mod0"), [...areas].join(","));
  assert.equal(L.assign("src/core/mod1/x.py", areas), "src/core/mod1");
});

test("the graph ranks people per area with evidence", () => {
  const o = L.projectOverview(g);
  assert.equal(o.prs, 52);
  assert.ok(o.areas > 3);
  const areas = L.findAreas(g, "asyncio").map(a => a.area);
  assert.ok(areas.includes("falkordb/asyncio"));
  const people = L.whoKnows(g, ["falkordb/asyncio"]);
  assert.ok(people.length >= 2);
  assert.ok(people[0].score >= people[1].score);
  assert.ok(people[0].evidence.length > 0);
  for (const e of people[0].evidence) assert.match(e.id, /^FalkorDB\/falkordb-py#\d+$/);
});

test("triage pieces: related work and reviewers who aren't the author", () => {
  const issue = L.openIssues(g)[0];
  const rel = L.related(g, issue.id);
  assert.ok(rel.related.length > 0);
  const rev = L.suggestReviewers(g, issue.id);
  assert.ok(!rev.reviewers.some(r => r.login === g.items.get(issue.id).author));
});

test("parseStep reads JSON from fenced or chatty replies", () => {
  assert.deepEqual(L.parseStep('```json\n{"tool":"find_areas","args":{"text":"x"}}\n```'), { tool: "find_areas", args: { text: "x" } });
  assert.deepEqual(L.parseStep('Sure! {"answer": "a {b} c"} done'), { answer: "a {b} c" });
  assert.deepEqual(L.parseStep("plain words"), { answer: "plain words" });
});

test("the agent calls tools, then answers with evidence", async () => {
  const replies = [
    '{"tool": "find_areas", "args": {"text": "asyncio"}}',
    '{"tool": "who_knows", "args": {"area_ids": ["falkordb/asyncio"]}}',
    '{"answer": "@gkorland knows it [FalkorDB/falkordb-py#236]."}',
  ];
  const seen = [];
  const res = await L.runAgent(g, "Who knows the async client?", {
    complete: async ({ messages, systemPrompt }) => {
      assert.match(systemPrompt, /FalkorDB\/falkordb-py/);
      seen.push(messages.length);
      return replies.shift();
    },
  });
  assert.deepEqual(seen, [1, 3, 5]);
  assert.match(res.text, /gkorland/);
  assert.ok(res.evidence.items.length > 0);
});

test("unknown tools come back as errors the model can read", () => {
  assert.deepEqual(L.runTool(g, "nope"), { error: "unknown tool nope" });
  assert.ok(L.runTool(g, "related", { issue_ref: "#999999" }).error);
});

test("fetchRepo builds the same history from GitHub's API within 60 calls", async () => {
  const gh = L.makeGitHub({ fetchImpl: fakeFetch(githubRoutes(snap, { remaining: 60 })) });
  const progress = [];
  const fetched = await L.fetchRepo("FalkorDB/falkordb-py", { gh, now: snap.fetched_at * 1000, onProgress: p => progress.push(p.label) });
  assert.equal(fetched.prs.length, snap.prs.length);
  assert.equal(fetched.issues.length, snap.issues.length);
  assert.ok(gh.calls <= 45, `used ${gh.calls} calls`);
  assert.ok(progress.includes("files"));
  const g2 = L.buildGraph(fetched, snap.fetched_at);
  assert.equal(L.whoKnows(g2, ["falkordb/asyncio"])[0].login, L.whoKnows(g, ["falkordb/asyncio"])[0].login);
});

test("fetchRepo stops cleanly when the hourly allowance runs out", async () => {
  const gh = L.makeGitHub({ fetchImpl: fakeFetch(githubRoutes(snap, { remaining: 12 })) });
  const fetched = await L.fetchRepo("FalkorDB/falkordb-py", { gh, now: snap.fetched_at * 1000 });
  assert.equal(fetched.partial, true);
  assert.ok(fetched.files_for < fetched.merged_total);
});

test("a missing repo is a clear error", async () => {
  const gh = L.makeGitHub({ fetchImpl: fakeFetch(() => ({ status: 404, headers: {}, body: { message: "Not Found" } })) });
  await assert.rejects(L.fetchRepo("nobody/nothing", { gh }), e => e.kind === "missing");
});

// --- Partial data (v0.1.1, from Anna's App Review) ------------------------------------------------

async function rateLimitedGraph(remaining = 12) {
  const gh = L.makeGitHub({ fetchImpl: fakeFetch(githubRoutes(snap, { remaining, reset: snap.fetched_at + 1800 })) });
  const fetched = await L.fetchRepo("FalkorDB/falkordb-py", { gh, now: snap.fetched_at * 1000 });
  return { fetched, graph: L.buildGraph(fetched, snap.fetched_at) };
}
/** A small repo read in full: every merged PR's files, no rate limit. */
function completeGraph() {
  const prs = snap.prs.slice(0, 20);
  const merged = prs.filter(p => p.state === "merged").length;
  return L.buildGraph({ ...snap, prs, files_for: merged, merged_total: merged, files_read: merged, partial: false }, snap.fetched_at);
}

test("a rate-limited load records how much was read and when GitHub resets", async () => {
  const { fetched, graph } = await rateLimitedGraph();
  assert.equal(fetched.partial, true);
  assert.ok(fetched.files_read > 0 && fetched.files_read < fetched.merged_total, `read ${fetched.files_read}`);
  assert.equal(fetched.files_read, fetched.prs.filter(p => p.files.length).length);
  assert.equal(fetched.rate_reset, snap.fetched_at + 1800);
  const c = L.coverage(graph);
  assert.equal(c.partial, true);
  assert.equal(c.rateLimited, true);
  assert.equal(c.resetAt, snap.fetched_at + 1800);
  assert.equal(c.headline, `files read for ${fetched.files_read} of ${fetched.merged_total} merged PRs in the last 12 months`);
  assert.match(c.detail, /rate limit stopped the rest/);
});

test("the free allowance's 30-PR cap counts as partial data too, and a full read does not", async () => {
  const gh = L.makeGitHub({ fetchImpl: fakeFetch(githubRoutes(snap, { remaining: 60 })) });
  const fetched = await L.fetchRepo("FalkorDB/falkordb-py", { gh, now: snap.fetched_at * 1000 });
  const capped = L.coverage(L.buildGraph(fetched, snap.fetched_at));
  assert.equal(fetched.partial, false);
  assert.equal(capped.partial, true);
  assert.equal(capped.rateLimited, false);
  assert.match(capped.headline, /^files read for 30 of 34 merged PRs/);
  assert.match(capped.detail, /30 most recent merged PRs only/);
  assert.equal(capped.resetAt, null);

  const full = completeGraph();
  assert.equal(L.coverage(full).partial, false);
  assert.equal(L.dataNote(full), "");
  assert.doesNotMatch(L.systemPrompt(full), /PARTIAL/);
  assert.deepEqual(L.absoluteClaims(full, "Only @a knows it."), []);
});

test("a repo with more PRs than Lore lists says 'at least'", () => {
  const c = L.coverage(L.buildGraph({ ...snap, pr_cap_hit: true }, snap.fetched_at));
  assert.match(c.headline, /of at least 34 merged PRs/);
  assert.match(c.detail, /older ones are missing/);
});

test("a snapshot stored by v0.1.0 (no files_read) still reports its coverage", () => {
  const old = { ...snap, partial: true, prs: snap.prs.map((p, i) => ({ ...p, files: i < 8 ? p.files : [] })) };
  const c = L.coverage(L.buildGraph(old, snap.fetched_at));
  assert.equal(c.rateLimited, true);
  assert.equal(c.filesRead, old.prs.filter(p => p.files.length).length);
});

test("the model is told the data is partial, in the prompt and after every tool result", async () => {
  const { graph } = await rateLimitedGraph();
  assert.match(L.systemPrompt(graph), /The data is PARTIAL: files read for \d+ of 34 merged PRs/);
  assert.match(L.systemPrompt(graph), /Never state as fact that only one person knows/);
  const seen = [];
  const replies = ['{"tool": "knowledge_risk", "args": {}}', '{"answer": "Only @gkorland knows falkordb/asyncio. Based on the fetched data, @swilly22 reviewed it too."}'];
  const res = await L.runAgent(graph, "Which code depends on one person?", {
    complete: async ({ messages }) => { seen.push(messages.at(-1).content); return replies.shift(); },
  });
  assert.match(seen[1], /Reminder: the data is partial/);
  assert.deepEqual(res.caveats, ["Only @gkorland knows falkordb/asyncio."]);
  assert.match(L.projectOverview(graph).note, /^Partial data:/);

  let prompt = "";
  const t = await L.triage(graph, L.openIssues(graph)[0].id, { complete: async ({ messages }) => { prompt = messages[0].content; return "@gkorland is the sole maintainer of this area."; } });
  assert.match(prompt, /The data is PARTIAL/);
  assert.equal(t.caveats.length, 1);
});

test("absoluteClaims flags unhedged absolutes and lets hedged ones through", async () => {
  const { graph } = await rateLimitedGraph();
  const flagged = [
    "Only @eps1lon knows it well.",
    "**@eps1lon** is the only active maintainer of packages/react-dom.",
    "Nobody else has touched the scheduler.",
    "This area has a bus factor of 1.",
    "The compiler is a single point of failure.",
    "The docs depend entirely on @rickhanlonii.",
  ];
  for (const s of flagged) assert.equal(L.absoluteClaims(graph, s).length, 1, s);
  const fine = [
    "Based on the fetched data, only @eps1lon knows it well.",
    "@eps1lon knows it best [facebook/react#1], and @acdlite reviewed #2.",
    "In the partial data Lore read, nobody else shows up for this area.",
    "The full history may show more people; only @a appears here.",
  ];
  for (const s of fine) assert.deepEqual(L.absoluteClaims(graph, s), [], s);
});

test("what the review saw: a rate-limited load shows knowledge risk that the fuller data doesn't", async () => {
  // 14 of 34 merged PRs read: two areas look like they depend on one person. With 30 read, none does.
  const { graph } = await rateLimitedGraph(20);
  assert.equal(L.coverage(graph).filesRead, 14);
  assert.deepEqual(L.knowledgeRisk(graph).map(r => r.area).sort(), ["falkordb", "tests"]);
  assert.deepEqual(L.knowledgeRisk(g), []);
});
