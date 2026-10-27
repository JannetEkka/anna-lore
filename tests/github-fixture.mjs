// Serves a Lore snapshot back as GitHub REST API responses, so fetchRepo can be tested offline.
import fs from "node:fs";

const iso = t => (t ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null);

export function loadFixture() {
  return JSON.parse(fs.readFileSync(new URL("./fixtures/falkordb-py.json", import.meta.url)));
}

/** Returns (url) => {status, body, headers} for the endpoints fetchRepo calls. */
export function githubRoutes(snap, { remaining = 60 } = {}) {
  const [owner, name] = snap.name.split("/");
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const user = login => ({ login, type: "User" });
  const pulls = [...snap.prs].sort((a, b) => b.created_at - a.created_at).map(p => ({
    number: p.number, title: p.title, body: p.body, user: user(p.author), state: p.state === "merged" ? "closed" : p.state,
    merged_at: iso(p.merged_at), created_at: iso(p.created_at), labels: p.labels.map(n => ({ name: n })),
    html_url: p.url,
  }));
  const issues = [...snap.issues].sort((a, b) => b.created_at - a.created_at).map(i => ({
    number: i.number, title: i.title, body: i.body, user: user(i.author), state: i.state,
    created_at: iso(i.created_at), closed_at: iso(i.closed_at), labels: i.labels.map(n => ({ name: n })), html_url: i.url,
  }));
  const comments = snap.comments.map(c => ({ issue_url: `${base}/issues/${c.number}`, user: user(c.author), created_at: iso(c.at) }));
  const reviews = snap.reviews.map(r => ({ pull_request_url: `${base}/pulls/${r.pr}`, user: user(r.author), created_at: iso(r.at) }));
  const page = (list, u) => {
    const p = +(u.searchParams.get("page") || 1), n = +(u.searchParams.get("per_page") || 30);
    return list.slice((p - 1) * n, p * n);
  };
  let left = remaining;
  return url => {
    const u = new URL(url);
    const path = u.origin + u.pathname;
    left = Math.max(0, left - 1);
    const headers = { "x-ratelimit-remaining": String(left), "x-ratelimit-limit": "60", "content-type": "application/json" };
    if (left === 0 && remaining < 60) return { status: 403, headers, body: { message: "API rate limit exceeded" } };
    let body;
    if (path === base) body = { full_name: snap.name, html_url: snap.url, description: snap.description, default_branch: "main", private: false };
    else if (path === `${base}/pulls`) body = page(pulls, u);
    else if (path === `${base}/issues`) body = page(issues, u);
    else if (path === `${base}/issues/comments`) body = page(comments, u);
    else if (path === `${base}/pulls/comments`) body = page(reviews, u);
    else {
      const m = path.match(/\/pulls\/(\d+)\/files$/);
      const pr = m && snap.prs.find(p => p.number === +m[1]);
      if (pr) body = (pr.files || []).map(f => ({ filename: f }));
      else return { status: 404, headers, body: { message: "Not Found" } };
    }
    return { status: 200, headers, body };
  };
}

export function fakeFetch(routes) {
  return async url => {
    const r = routes(url);
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      headers: { get: k => r.headers[k.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  };
}
