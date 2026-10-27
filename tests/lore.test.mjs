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
