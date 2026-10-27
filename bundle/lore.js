// Lore for Anna: a public GitHub repo's history as a graph of who did what, the queries
// that answer "who knows this?", and the agent that picks those queries to answer a question.
// No DOM in here, so the same module runs in the app's iframe and under `node --test`.

export const CONFIG = {
  W_AUTHOR: 1.0,        // wrote a PR that was merged
  W_REVIEW: 0.6,        // reviewed a PR (review comment, or approval with a token)
  W_COMMENT: 0.2,       // commented on a PR, or on an issue a PR then fixed
  HALF_LIFE_DAYS: 180,  // work this old counts half
  ACTIVE_DAYS: 90,      // "active" = any activity in this many days
  MONTHS: 12,           // how much history is fetched
  AREA_DEPTH: 2,        // an area is the first two directories: src/index/x.c -> src/index
};

const DAY = 86400;
const DECAY_K = -Math.log(2) / (CONFIG.HALF_LIFE_DAYS * DAY);
export const ROOT = "(root)";

// --- Parsing --------------------------------------------------------------------------------------

const FIX_RE = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
const REF_RE = /(?<![\w/#&])#(\d+)\b/g;
const BOT_LOGINS = new Set(["dependabot", "github-actions", "renovate", "codecov", "coderabbitai", "copilot", "pre-commit-ci"]);

export function isBot(user) {
  if (!user) return true;
  const login = user.login || "";
  return user.type === "Bot" || login.endsWith("[bot]") || BOT_LOGINS.has(login.toLowerCase());
}

/** Issue/PR numbers a text fixes, and every number it mentions. */
export function parseRefs(text) {
  text = text || "";
  const fixes = new Set([...text.matchAll(FIX_RE)].map(m => +m[1]));
  const refs = new Set([...text.matchAll(REF_RE)].map(m => +m[1]));
  return { fixes: [...fixes].sort((a, b) => a - b), refs: [...refs].sort((a, b) => a - b) };
}

const toEpoch = s => (s ? Math.floor(Date.parse(s) / 1000) : null);

/** "owner/repo", "https://github.com/owner/repo/..." or "owner/repo.git" -> "owner/repo", else null. */
export function parseRepo(input) {
  const s = String(input || "").trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\.git$/, "");
  const m = s.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:[/?#].*)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// --- Areas ----------------------------------------------------------------------------------------

const VENDORED = ["deps/", "vendor/", "third_party/", "node_modules/", "external/", "build/", "dist/"];
const IGNORED_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock", "go.sum", "uv.lock", "Gemfile.lock", "composer.lock"]);

export function isIgnored(path) {
  const name = path.split("/").pop();
  return VENDORED.some(v => path.startsWith(v)) || IGNORED_NAMES.has(name);
}

export function areaFor(path, depth = CONFIG.AREA_DEPTH) {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length ? dirs.slice(0, depth).join("/") : ROOT;
}

/** The deepest planned area that contains the path. */
export function assign(path, areas) {
  const dirs = path.split("/").slice(0, -1);
  for (let d = dirs.length; d > 0; d--) {
    const prefix = dirs.slice(0, d).join("/");
    if (areas.has(prefix)) return prefix;
  }
  return ROOT;
}

/** Start at AREA_DEPTH directories, then split any area holding more than `share` of the files
 *  (and at least `minimum`) into its subdirectories, so a big src/ doesn't swallow everything. */
export function planAreas(paths, depth = CONFIG.AREA_DEPTH, share = 0.06, minimum = 30, maxDepth = 4) {
  paths = [...new Set(paths)].filter(p => !isIgnored(p));
  const limit = Math.max(minimum, share * paths.length);
  const areas = new Set(paths.map(p => areaFor(p, depth)));
  for (let d = depth + 1; d <= maxDepth; d++) {
    const counts = new Map();
    for (const p of paths) {
      const a = assign(p, areas);
      counts.set(a, (counts.get(a) || 0) + 1);
    }
    const big = new Set([...counts].filter(([a, n]) => n > limit && a !== ROOT).map(([a]) => a));
    if (!big.size) break;
    for (const p of paths) {
      if (big.has(assign(p, areas)) && p.split("/").length - 1 >= d) areas.add(areaFor(p, d));
    }
  }
  return areas;
}

// --- Fetching from GitHub -------------------------------------------------------------------------

export class GitHubError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/** A GitHub REST client for the browser: counts calls, reads the hourly allowance from the headers,
 *  and turns refusals into messages a person can act on. `fetchImpl` is injectable for tests. */
export function makeGitHub({ fetchImpl = fetch, token = null } = {}) {
  const gh = { calls: 0, remaining: null, limit: null, reset: null, hasToken: !!token };
  gh.get = async (path, params = {}) => {
    if (gh.remaining === 0) throw new GitHubError("rate", "GitHub's hourly allowance for your connection is used up.");
    const url = new URL(path.startsWith("http") ? path : "https://api.github.com" + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let r;
    try {
      r = await fetchImpl(url.toString(), { headers });
    } catch (e) {
      throw new GitHubError("network", `Couldn't reach GitHub (${e.message}).`);
    }
    gh.calls++;
    const rem = r.headers.get("x-ratelimit-remaining");
    if (rem !== null) gh.remaining = +rem;
    if (r.headers.get("x-ratelimit-limit")) gh.limit = +r.headers.get("x-ratelimit-limit");
    if (r.headers.get("x-ratelimit-reset")) gh.reset = +r.headers.get("x-ratelimit-reset");
    if ((r.status === 403 || r.status === 429) && gh.remaining === 0) {
      throw new GitHubError("rate", "GitHub's hourly allowance for your connection is used up.");
    }
    if (r.status === 404) throw new GitHubError("missing", "GitHub has no public repo by that name.");
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).message || ""; } catch { /* not JSON */ }
      throw new GitHubError("refused", `GitHub refused the request (${r.status}${msg ? ": " + msg : ""}).`);
    }
    return r.json();
  };
  gh.pages = async function* (path, params, maxPages) {
    for (let page = 1; page <= maxPages; page++) {
      const batch = await gh.get(path, { ...params, per_page: 100, page });
      yield* batch;
      if (batch.length < 100) return;
    }
  };
  return gh;
}

/** Budgets so one repo fits well inside GitHub's 60 calls an hour without a token. */
export function budgetFor(hasToken) {
  return hasToken
    ? { prPages: 5, issuePages: 4, commentPages: 4, reviewCommentPages: 4, fileCalls: 200, reviewCalls: 100 }
    : { prPages: 3, issuePages: 2, commentPages: 2, reviewCommentPages: 2, fileCalls: 30, reviewCalls: 0 };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch a public repo's last CONFIG.MONTHS of history into a plain-JSON snapshot.
 *  Only GitHub logins are kept: no emails, no names. */
export async function fetchRepo(full, { gh, onProgress = () => {}, now = Date.now() } = {}) {
  const budget = budgetFor(gh.hasToken);
  const since = new Date(now - CONFIG.MONTHS * 30 * DAY * 1000);
  const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, "Z");
  const step = (label, detail) => onProgress({ label, detail, calls: gh.calls, remaining: gh.remaining });

  step("repo", `Looking up ${full}`);
  const meta = await gh.get(`/repos/${full}`);
  if (meta.private) throw new GitHubError("refused", "Lore only reads public repos.");
  full = meta.full_name;

  const prs = [];
  for await (const p of gh.pages(`/repos/${full}/pulls`, { state: "all", sort: "created", direction: "desc" }, budget.prPages)) {
    if (p.created_at < sinceIso) break;
    if (isBot(p.user)) continue;
    const { fixes, refs } = parseRefs(`${p.title}\n${p.body || ""}`);
    prs.push({
      number: p.number, title: p.title, body: (p.body || "").slice(0, 1200), author: p.user.login,
      state: p.merged_at ? "merged" : p.state, created_at: toEpoch(p.created_at), merged_at: toEpoch(p.merged_at),
      labels: (p.labels || []).map(l => l.name), fixes, refs: refs.filter(n => n !== p.number), url: p.html_url, files: [],
    });
  }
  step("prs", `${prs.length} pull requests`);

  const issues = [];
  for await (const i of gh.pages(`/repos/${full}/issues`, { state: "all", sort: "created", direction: "desc" }, budget.issuePages)) {
    if (i.created_at < sinceIso) break;
    if (i.pull_request || isBot(i.user)) continue;
    const body = (i.body || "").slice(0, 1500);
    const { refs } = parseRefs(`${i.title}\n${body}`);
    issues.push({
      number: i.number, title: i.title, body, author: i.user.login, state: i.state,
      created_at: toEpoch(i.created_at), closed_at: toEpoch(i.closed_at),
      labels: (i.labels || []).map(l => (typeof l === "string" ? l : l.name)), refs: refs.filter(n => n !== i.number), url: i.html_url,
    });
  }
  step("issues", `${issues.length} issues`);

  const comments = [];
  for await (const c of gh.pages(`/repos/${full}/issues/comments`, { since: sinceIso, sort: "created", direction: "desc" }, budget.commentPages)) {
    if (!isBot(c.user)) comments.push({ number: +c.issue_url.split("/").pop(), author: c.user.login, at: toEpoch(c.created_at) });
  }
  const reviews = [];
  for await (const c of gh.pages(`/repos/${full}/pulls/comments`, { since: sinceIso, sort: "created", direction: "desc" }, budget.reviewCommentPages)) {
    if (!isBot(c.user)) reviews.push({ pr: +c.pull_request_url.split("/").pop(), author: c.user.login, state: "COMMENTED", at: toEpoch(c.created_at) });
  }
  step("comments", `${comments.length} comments, ${reviews.length} review comments`);

  // Files per merged PR: one call each, newest first, within the budget.
  const merged = prs.filter(p => p.state === "merged").slice(0, budget.fileCalls);
  let done = 0;
  let stoppedEarly = false;
  await mapLimit(merged, 6, async p => {
    if (stoppedEarly) return;
    try {
      const files = await gh.get(`/repos/${full}/pulls/${p.number}/files`, { per_page: 100 });
      p.files = files.map(f => f.filename).filter(f => !isIgnored(f));
    } catch (e) {
      if (e.kind === "rate") stoppedEarly = true; else throw e;
    }
    done++;
    if (done % 5 === 0 || done === merged.length) step("files", `files for ${done} of ${merged.length} merged PRs`);
  });

  if (gh.hasToken) {
    await mapLimit(merged.slice(0, budget.reviewCalls), 6, async p => {
      if (stoppedEarly) return;
      try {
        for (const r of await gh.get(`/repos/${full}/pulls/${p.number}/reviews`, { per_page: 100 })) {
          if (!isBot(r.user) && r.user.login !== p.author && r.submitted_at) {
            reviews.push({ pr: p.number, author: r.user.login, state: r.state, at: toEpoch(r.submitted_at) });
          }
        }
      } catch (e) {
        if (e.kind === "rate") stoppedEarly = true; else throw e;
      }
    });
  }

  return {
    name: full, url: meta.html_url, description: meta.description || "", default_branch: meta.default_branch,
    since: Math.floor(since.getTime() / 1000), fetched_at: Math.floor(now / 1000),
    files_for: merged.length, merged_total: prs.filter(p => p.state === "merged").length,
    partial: stoppedEarly, prs, issues, comments, reviews, calls: gh.calls,
  };
}

/** A smaller copy for storage: shorter bodies. */
export function compactSnapshot(snap) {
  return {
    ...snap,
    prs: snap.prs.map(p => ({ ...p, body: p.body.slice(0, 400) })),
    issues: snap.issues.map(i => ({ ...i, body: i.body.slice(0, 600) })),
  };
}

// --- The graph ------------------------------------------------------------------------------------

/** Turn a snapshot into an in-memory graph and compute KNOWS(person, area). */
export function buildGraph(snap, now = Math.floor(Date.now() / 1000)) {
  const repo = snap.name;
  const id = n => `${repo}#${n}`;
  const g = {
    repo, url: snap.url, description: snap.description, since: snap.since, fetchedAt: snap.fetched_at, now,
    partial: !!snap.partial, filesFor: snap.files_for, mergedTotal: snap.merged_total,
    items: new Map(), people: new Map(), areas: new Map(), byNumber: new Map(),
    reviews: new Map(),   // prId -> Map(login -> {count, at})
    comments: new Map(),  // itemId -> Map(login -> {count, at})
    fixedBy: new Map(),   // issueId -> Set(prId)
    knows: new Map(),     // areaPath -> Map(login -> {score, authored, reviewed, commented, last_at})
  };
  const seen = (login, at) => {
    if (!login) return;
    const p = g.people.get(login) || { login, last_active: 0 };
    p.last_active = Math.max(p.last_active, at || 0);
    g.people.set(login, p);
  };

  const areaSet = planAreas(snap.prs.flatMap(p => p.files || []));
  for (const p of snap.prs) {
    const item = {
      id: id(p.number), kind: "PR", number: p.number, title: p.title, body: p.body, state: p.state, url: p.url,
      author: p.author, created_at: p.created_at, merged_at: p.merged_at, labels: p.labels,
      fixes: p.fixes.map(id), refs: p.refs.map(id), files: p.files || [], areas: new Set(),
    };
    for (const f of item.files) {
      const a = assign(f, areaSet);
      item.areas.add(a);
      const area = g.areas.get(a) || { path: a, files: new Set(), prs: new Set() };
      area.files.add(f);
      area.prs.add(item.id);
      g.areas.set(a, area);
    }
    g.items.set(item.id, item);
    g.byNumber.set(p.number, item.id);
    seen(p.author, p.merged_at || p.created_at);
  }
  for (const i of snap.issues) {
    g.items.set(id(i.number), {
      id: id(i.number), kind: "Issue", number: i.number, title: i.title, body: i.body, state: i.state, url: i.url,
      author: i.author, created_at: i.created_at, closed_at: i.closed_at, labels: i.labels, refs: i.refs.map(id), fixes: [],
    });
    g.byNumber.set(i.number, id(i.number));
    seen(i.author, i.created_at);
  }
  for (const item of g.items.values()) {
    if (item.kind !== "PR" || item.state !== "merged") continue;
    for (const f of item.fixes) {
      if (g.items.get(f)?.kind !== "Issue") continue;
      if (!g.fixedBy.has(f)) g.fixedBy.set(f, new Set());
      g.fixedBy.get(f).add(item.id);
    }
  }
  const bump = (map, key, login, at) => {
    if (!map.has(key)) map.set(key, new Map());
    const cur = map.get(key).get(login) || { count: 0, at: 0 };
    cur.count++;
    cur.at = Math.max(cur.at, at || 0);
    map.get(key).set(login, cur);
    seen(login, at);
  };
  for (const r of snap.reviews) if (g.items.has(id(r.pr))) bump(g.reviews, id(r.pr), r.author, r.at);
  for (const c of snap.comments) if (g.items.has(id(c.number))) bump(g.comments, id(c.number), c.author, c.at);

  for (const p of g.people.values()) p.active = p.last_active >= now - CONFIG.ACTIVE_DAYS * DAY;

  // KNOWS: each kind of work counts once per PR and area, and older work counts less.
  const add = (login, area, kind, weight, at) => {
    if (!g.knows.has(area)) g.knows.set(area, new Map());
    const k = g.knows.get(area).get(login) || { score: 0, authored: 0, reviewed: 0, commented: 0, last_at: 0 };
    k.score += weight * Math.exp(DECAY_K * (now - at));
    k[kind]++;
    k.last_at = Math.max(k.last_at, at);
    g.knows.get(area).set(login, k);
  };
  for (const pr of g.items.values()) {
    if (pr.kind !== "PR" || !pr.areas.size) continue;
    const touched = [...pr.areas];
    if (pr.merged_at) for (const a of touched) add(pr.author, a, "authored", CONFIG.W_AUTHOR, pr.merged_at);
    for (const [login, r] of g.reviews.get(pr.id) || []) {
      if (login !== pr.author) for (const a of touched) add(login, a, "reviewed", CONFIG.W_REVIEW, r.at);
    }
    // Comments on the PR itself, and on issues it fixed.
    const commentSources = [pr.id, ...(pr.state === "merged" ? pr.fixes : [])];
    const commenters = new Map();
    for (const src of commentSources) {
      for (const [login, c] of g.comments.get(src) || []) {
        if (login !== pr.author) commenters.set(login, Math.max(commenters.get(login) || 0, c.at));
      }
    }
    for (const [login, at] of commenters) for (const a of touched) add(login, a, "commented", CONFIG.W_COMMENT, at);
  }
  return g;
}

// --- Queries (the agent's tools) ------------------------------------------------------------------

const STOPWORDS = new Set(`a an and are as at be but by can cannot could did do does doesn't don't each for from get got
had has have how i if in into is isn't it its it's just like make may more most my no not of on or our out
over same should so some such than that the their them then there these they this to too up use used using
very was we were what when where which while who why will with would you your after before between both
error issue problem bug fails failed failing crash work works working add support new knows know about
code part people person repo project anyone someone best`.split(/\s+/));

export function tokens(text) {
  const words = (text || "").toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [];
  return new Set(words.filter(w => !STOPWORDS.has(w)));
}

const iso = t => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);
const brief = item => ({ id: item.id, kind: item.kind, title: item.title, state: item.state, url: item.url });

export function projectOverview(g) {
  const items = [...g.items.values()];
  const created = items.map(i => i.created_at).filter(Boolean);
  return {
    repo: g.repo, url: g.url, description: g.description,
    people: g.people.size, active_people: [...g.people.values()].filter(p => p.active).length,
    prs: items.filter(i => i.kind === "PR").length, merged_prs: items.filter(i => i.state === "merged").length,
    issues: items.filter(i => i.kind === "Issue").length, areas: g.areas.size,
    history_from: iso(Math.min(...created)), history_to: iso(Math.max(...created)),
    note: `Files are known for ${g.filesFor} of ${g.mergedTotal} merged PRs (the most recent ones).`,
  };
}

/** Areas whose directory or files mention any of the words, busiest first. */
export function findAreas(g, text, limit = 8) {
  const words = [...new Set([...tokens(text), ...((text || "").toLowerCase().match(/[a-z0-9_]{3,}/g) || [])])]
    .filter(w => !STOPWORDS.has(w));
  if (!words.length) return [];
  const out = [];
  for (const a of g.areas.values()) {
    const path = a.path.toLowerCase();
    const files = [...a.files].filter(f => words.some(w => f.toLowerCase().includes(w)));
    if (words.some(w => path.includes(w)) || files.length) {
      out.push({ area: a.path, files: a.files.size, matching_files: files.slice(0, 3), prs: a.prs.size });
    }
  }
  return out.sort((x, y) => y.prs - x.prs).slice(0, limit);
}

function evidence(g, login, areas, limit = 3) {
  const out = [];
  for (const item of g.items.values()) {
    if (item.kind !== "PR" || ![...item.areas].some(a => areas.has(a))) continue;
    let role = null;
    if (item.author === login && item.merged_at) role = "authored";
    else if (g.reviews.get(item.id)?.has(login)) role = "reviewed";
    if (role) out.push({ role, ...brief(item), at: iso(item.merged_at || item.created_at), t: item.merged_at || item.created_at });
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit).map(({ t, ...rest }) => rest);
}

/** People ranked by KNOWS across the given areas, each with the PRs behind it. */
export function whoKnows(g, areaIds, { activeOnly = false, limit = 5, exclude = [] } = {}) {
  const areas = new Set((areaIds || []).filter(a => g.areas.has(a)));
  const totals = new Map();
  for (const a of areas) {
    for (const [login, k] of g.knows.get(a) || []) {
      const t = totals.get(login) || { login, score: 0, authored: 0, reviewed: 0, commented: 0, areas: [], last_at: 0 };
      t.score += k.score; t.authored += k.authored; t.reviewed += k.reviewed; t.commented += k.commented;
      t.areas.push(a); t.last_at = Math.max(t.last_at, k.last_at);
      totals.set(login, t);
    }
  }
  return [...totals.values()]
    .filter(t => !exclude.includes(t.login) && (!activeOnly || g.people.get(t.login)?.active))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(t => ({ ...t, score: +t.score.toFixed(2), last_at: iso(t.last_at), active: !!g.people.get(t.login)?.active, evidence: evidence(g, t.login, areas) }));
}

export function resolveItem(g, ref) {
  const s = String(ref ?? "").trim();
  const m = s.match(/(\d+)\s*$/) || s.match(/#(\d+)/);
  return m ? g.byNumber.get(+m[1]) || null : null;
}

export function getItem(g, ref) {
  const item = g.items.get(resolveItem(g, ref));
  if (!item) return null;
  return {
    ...brief(item), author: item.author, labels: item.labels, body: (item.body || "").slice(0, 1200),
    created: iso(item.created_at), merged: iso(item.merged_at), areas: item.areas ? [...item.areas] : undefined,
    fixed_by: [...(g.fixedBy.get(item.id) || [])],
  };
}

/** Word search over titles and descriptions, titles weighted higher. */
export function searchHistory(g, text, limit = 8) {
  const words = [...tokens(text)].slice(0, 10);
  if (!words.length) return [];
  const out = [];
  for (const item of g.items.values()) {
    const title = item.title.toLowerCase();
    const body = (item.body || "").toLowerCase();
    let score = 0;
    for (const w of words) score += (title.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0);
    if (score) out.push({ ...brief(item), author: item.author, at: iso(item.merged_at || item.created_at), excerpt: (item.body || "").slice(0, 300), score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The areas an issue is about, each with its reasons: PRs that fixed it, labels whose past
 *  fixes landed there, and words in its text that name the area or a file in it. */
export function issueAreas(g, issueId, top = 3) {
  const issue = g.items.get(issueId);
  if (!issue) return [];
  const scores = new Map();
  const add = (area, s, reason) => {
    const cur = scores.get(area) || { area, score: 0, reasons: [] };
    cur.score += s;
    cur.reasons.push(reason);
    scores.set(area, cur);
  };
  const fixers = [...(g.fixedBy.get(issueId) || [])].map(id => g.items.get(id));
  const perArea = new Map();
  for (const pr of fixers) for (const a of pr.areas) perArea.set(a, (perArea.get(a) || 0) + 1);
  for (const [a, n] of perArea) add(a, 3 * n, `fixed by ${n} PR(s) touching it`);

  for (const label of issue.labels || []) {
    const counts = new Map();
    let total = 0;
    for (const [other, prs] of g.fixedBy) {
      if (other === issueId || !(g.items.get(other).labels || []).includes(label)) continue;
      for (const prId of prs) {
        total++;
        for (const a of g.items.get(prId).areas) counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
    for (const [a, n] of counts) {
      const share = n / total;
      if (share >= 0.2) add(a, 2 * share, `${Math.round(100 * share)}% of past '${label}' fixes touched it`);
    }
  }

  const words = tokens(`${issue.title} ${issue.body}`);
  for (const a of g.areas.values()) {
    const segs = new Set(a.path.toLowerCase().split("/").filter(s => !["src", "lib", ROOT].includes(s)));
    const stemWords = new Set();
    for (const f of a.files) {
      const stem = f.split("/").pop().replace(/\.\w+$/, "").toLowerCase();
      for (const w of stem.split(/[_\-.]/)) if (w.length > 3 && !STOPWORDS.has(w)) stemWords.add(w);
    }
    const hitSegs = [...words].filter(w => segs.has(w));
    const hitFiles = [...words].filter(w => stemWords.has(w));
    if (hitSegs.length || hitFiles.length) {
      add(a.path, hitSegs.length + 0.5 * Math.min(hitFiles.length, 3), "mentions " + [...new Set([...hitSegs, ...hitFiles])].sort().join(", "));
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, top).map(s => ({ ...s, score: +s.score.toFixed(2) }));
}

/** Past issues and PRs related to this one, each with the reason. */
export function related(g, issueId, limit = 5) {
  const issue = g.items.get(issueId);
  if (!issue) return { areas: [], related: [] };
  const areas = issueAreas(g, issueId);
  const found = new Map();
  const add = (item, s, why) => {
    if (!item || item.id === issueId) return;
    const cur = found.get(item.id) || { ...brief(item), score: 0, why: [] };
    cur.score += s;
    cur.why.push(why);
    found.set(item.id, cur);
  };
  // Direct links, both ways, and what those link to (two hops).
  const neighbours = id => {
    const it = g.items.get(id);
    const out = new Set([...(it?.refs || []), ...(it?.fixes || []), ...(g.fixedBy.get(id) || [])]);
    for (const other of g.items.values()) if (other.refs.includes(id) || other.fixes.includes(id)) out.add(other.id);
    return out;
  };
  const first = neighbours(issueId);
  for (const id of first) add(g.items.get(id), 3, "linked directly");
  for (const id of first) for (const id2 of neighbours(id)) if (!first.has(id2)) add(g.items.get(id2), 1.5, `linked through #${id.split("#")[1]}`);

  const areaIds = new Set(areas.map(a => a.area));
  for (const [other, prs] of g.fixedBy) {
    if (other === issueId) continue;
    const via = [...prs].filter(p => [...g.items.get(p).areas].some(a => areaIds.has(a)));
    if (via.length) add(g.items.get(other), 1.5, `fixed in the same area by ${via.slice(0, 2).map(v => "#" + v.split("#")[1]).join(", ")}`);
  }
  const mine = tokens(issue.title);
  if (mine.size) {
    for (const other of g.items.values()) {
      if (other.kind !== "Issue" || other.id === issueId) continue;
      const theirs = tokens(other.title);
      const common = [...mine].filter(w => theirs.has(w));
      const overlap = theirs.size ? common.length / new Set([...mine, ...theirs]).size : 0;
      if (overlap >= 0.25) add(other, 2 * overlap, "similar title: " + common.sort().join(", "));
    }
  }
  const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { areas, related: ranked.map(r => ({ ...r, score: +r.score.toFixed(2) })) };
}

/** Active people who know an issue's areas best, never its author. */
export function suggestReviewers(g, issueId, limit = 3) {
  const issue = g.items.get(issueId);
  const areas = issueAreas(g, issueId);
  return { areas, reviewers: whoKnows(g, areas.map(a => a.area), { activeOnly: true, limit, exclude: issue ? [issue.author] : [] }) };
}

const NOT_KNOWLEDGE = new Set(["images", "img", "assets", "static", "_includes", ".github", "public", "fonts", ROOT]);

/** Areas with recent work that at most one active person knows well. */
export function knowledgeRisk(g, { days = 180, minPrs = 3, minScore = 1.0 } = {}) {
  const since = g.now - days * DAY;
  const out = [];
  for (const a of g.areas.values()) {
    if (a.path.split("/").some(s => NOT_KNOWLEDGE.has(s))) continue;
    const recent = [...a.prs].filter(id => (g.items.get(id).merged_at || 0) >= since).length;
    if (recent < minPrs) continue;
    const knowers = [...(g.knows.get(a.path) || [])]
      .filter(([login, k]) => g.people.get(login)?.active && k.score >= minScore)
      .sort((x, y) => y[1].score - x[1].score)
      .map(([login]) => login);
    if (knowers.length <= 1) out.push({ area: a.path, recent_prs: recent, knowers });
  }
  return out.sort((x, y) => y.recent_prs - x.recent_prs);
}

const BEGINNER = ["good first issue", "good-first-issue", "help wanted", "beginner", "easy", "first-timers-only", "starter"];

/** Open beginner-labelled issues; with areas given, those closest to them come first. */
export function goodFirstIssues(g, areaIds = [], limit = 5) {
  const wanted = new Set(areaIds);
  const issues = [...g.items.values()]
    .filter(i => i.kind === "Issue" && i.state === "open" && (i.labels || []).some(l => BEGINNER.some(b => l.toLowerCase().includes(b))))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 25)
    .map(i => {
      const areas = wanted.size ? issueAreas(g, i.id) : [];
      return { ...brief(i), labels: i.labels, areas: areas.map(a => a.area), match: areas.filter(a => wanted.has(a.area)).length };
    });
  return issues.sort((a, b) => b.match - a.match).slice(0, limit);
}

export function openIssues(g, limit = 40) {
  return [...g.items.values()].filter(i => i.kind === "Issue" && i.state === "open")
    .sort((a, b) => b.created_at - a.created_at).slice(0, limit).map(brief);
}

/** Areas by recent activity, with their top person: the Experts view. */
export function areaDirectory(g, limit = 30) {
  return [...g.areas.values()]
    .filter(a => a.path !== ROOT || g.areas.size === 1)
    .map(a => {
      const top = whoKnows(g, [a.path], { limit: 3 });
      return { area: a.path, prs: a.prs.size, files: a.files.size, top: top.map(t => ({ login: t.login, score: t.score, active: t.active })) };
    })
    .sort((x, y) => y.prs - x.prs)
    .slice(0, limit);
}

// --- The agent ------------------------------------------------------------------------------------

export const TOOLS = [
  { name: "project_overview", args: "{}", description: "The repo as a whole: people, active people, PRs, issues, areas, time span." },
  { name: "find_areas", args: '{"text": string}', description: "Areas of the code (directories) whose path or files mention the words. Turns a topic into area ids." },
  { name: "who_knows", args: '{"area_ids": string[], "active_only"?: boolean}', description: "People ranked by how well they know the given areas (merged PRs, reviews, comments, recent counts more), with the PRs that prove it." },
  { name: "get_item", args: '{"ref": string}', description: "One issue or PR: title, description, state, author, labels, areas. Accepts '#12' or '12'." },
  { name: "search_history", args: '{"text": string}', description: "Search PR and issue titles and descriptions: where something was discussed or decided." },
  { name: "related", args: '{"issue_ref": string}', description: "Past issues and PRs related to an issue, each with the reason, plus the areas the issue is about." },
  { name: "suggest_reviewers", args: '{"issue_ref": string}', description: "Active people who know an issue's areas best (never its author), with evidence." },
  { name: "knowledge_risk", args: "{}", description: "Areas with recent work that at most one active person knows well (bus factor of one)." },
  { name: "good_first_issues", args: '{"area_ids"?: string[]}', description: "Open beginner-friendly issues, closest to the given areas first." },
];

export function runTool(g, name, args = {}) {
  switch (name) {
    case "project_overview": return projectOverview(g);
    case "find_areas": return findAreas(g, args.text || "");
    case "who_knows": return whoKnows(g, args.area_ids || [], { activeOnly: !!args.active_only });
    case "get_item": return getItem(g, args.ref) || { error: "no such issue or PR in the loaded history" };
    case "search_history": return searchHistory(g, args.text || "");
    case "related":
    case "suggest_reviewers": {
      const id = resolveItem(g, args.issue_ref);
      if (!id || g.items.get(id).kind !== "Issue") return { error: "no such issue in the loaded history" };
      return name === "related" ? related(g, id) : suggestReviewers(g, id);
    }
    case "knowledge_risk": return knowledgeRisk(g);
    case "good_first_issues": return goodFirstIssues(g, args.area_ids || []);
    default: return { error: `unknown tool ${name}` };
  }
}

export function systemPrompt(g) {
  return `You are Lore. You know the GitHub repo ${g.repo} through a graph of its public history since ${iso(g.since)}:
people (GitHub logins), pull requests, reviews, issues, comments, and areas of the code (directories).

You work in steps. Each reply must be ONE JSON object and nothing else:
- to use a tool: {"tool": "<name>", "args": {...}}
- to answer:     {"answer": "<markdown>"}

Tools:
${TOOLS.map(t => `- ${t.name} ${t.args}: ${t.description}`).join("\n")}

Rules:
- Answer only from tool results. Never invent people, PRs, issues, dates or reasons.
- Cite a source for every person, claim or decision as [${g.repo}#123]. Write people as @login.
- Who knows something: find_areas to turn the topic into area ids, then who_knows with those ids.
- Why something is the way it is: search_history, then get_item on the best one or two, then explain with citations.
- About an issue: get_item, then related and suggest_reviewers. You only draft; nothing is posted anywhere.
- Where to start / first contribution: find_areas for the interest, good_first_issues with those ids, then who_knows.
- If the history does not hold the answer, say so plainly and say what you looked for.
- Keep answers short: a few sentences or a short list.`;
}

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function parseStep(text) {
  const t = String(text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(body.slice(start, i + 1));
          if (obj && (typeof obj.tool === "string" || typeof obj.answer === "string")) return obj;
        } catch { /* fall through */ }
        break;
      }
    }
  }
  return t ? { answer: t } : null;
}

export function summarize(result) {
  if (Array.isArray(result)) return `${result.length} result(s)`;
  if (result?.error) return result.error;
  if (result?.related) return `${result.related.length} related; areas: ${result.areas.map(a => a.area).join(", ") || "none found"}`;
  if (result?.reviewers) return `${result.reviewers.length} reviewer(s)`;
  if (result?.title) return `${result.id}: ${result.title}`;
  return "done";
}

function collectEvidence(result, out) {
  if (Array.isArray(result)) return result.forEach(r => collectEvidence(r, out));
  if (!result || typeof result !== "object") return;
  if (result.id && result.url) out.items.set(result.id, { id: result.id, title: result.title, url: result.url });
  if (result.login) out.people.add(result.login);
  for (const login of result.knowers || []) out.people.add(login);
  for (const v of Object.values(result)) if (v && typeof v === "object") collectEvidence(v, out);
}

/** Run the agent. `complete({systemPrompt, messages})` returns the model's text.
 *  Events: {type:"call", tool, args} · {type:"result", tool, summary} · {type:"answer", text, evidence} · {type:"error", message} */
export async function runAgent(g, question, { complete, onEvent = () => {}, maxSteps = 7 }) {
  const messages = [{ role: "user", content: question }];
  const evidence = { items: new Map(), people: new Set() };
  const finish = text => {
    const ev = { items: [...evidence.items.values()], people: [...evidence.people] };
    onEvent({ type: "answer", text, evidence: ev });
    return { text, evidence: ev };
  };
  for (let stepNo = 0; stepNo < maxSteps; stepNo++) {
    const reply = await complete({ systemPrompt: systemPrompt(g), messages });
    const step = parseStep(reply);
    if (!step) {
      onEvent({ type: "error", message: "The model returned an empty reply." });
      return null;
    }
    if (typeof step.answer === "string") return finish(step.answer.trim());
    const args = step.args && typeof step.args === "object" ? step.args : {};
    onEvent({ type: "call", tool: step.tool, args });
    let result;
    try {
      result = runTool(g, step.tool, args);
    } catch (e) {
      result = { error: `${e.name}: ${e.message}` };
    }
    collectEvidence(result, evidence);
    onEvent({ type: "result", tool: step.tool, summary: summarize(result) });
    messages.push({ role: "assistant", content: JSON.stringify({ tool: step.tool, args }) });
    let payload = JSON.stringify(result);
    if (payload.length > 7000) payload = payload.slice(0, 7000) + "…(truncated)";
    const last = stepNo === maxSteps - 2;
    messages.push({ role: "user", content: `Result of ${step.tool}: ${payload}${last ? "\n\nThis was the last tool call. Reply with {\"answer\": ...} now." : ""}` });
  }
  onEvent({ type: "error", message: "Stopped after too many steps without an answer." });
  return null;
}

/** A dry-run triage note for an open issue: related work, who knows the area, a drafted reply. */
export async function triage(g, issueRef, { complete }) {
  const id = resolveItem(g, issueRef);
  const issue = id && g.items.get(id);
  if (!issue || issue.kind !== "Issue") return { error: "That issue isn't in the loaded history." };
  const rel = related(g, id);
  const rev = suggestReviewers(g, id);
  const prompt = `Draft a short, friendly first reply to this GitHub issue, as a maintainer would write it.
Point to the related past issues/PRs that matter, as [${g.repo}#n], and say who knows this area best as @login with why.
Do not promise fixes or dates. Do not invent anything not in the data. Under 120 words. Plain markdown.

Issue: ${JSON.stringify(getItem(g, id))}
Related: ${JSON.stringify(rel.related)}
Areas: ${JSON.stringify(rel.areas)}
People who know these areas: ${JSON.stringify(rev.reviewers.map(r => ({ login: r.login, score: r.score, evidence: r.evidence })))}`;
  const draft = await complete({ systemPrompt: `You help maintainers of ${g.repo} triage issues. You only draft; nothing is posted.`, messages: [{ role: "user", content: prompt }] });
  return { issue: getItem(g, id), related: rel.related, areas: rel.areas, reviewers: rev.reviewers, draft: String(draft || "").trim() };
}
