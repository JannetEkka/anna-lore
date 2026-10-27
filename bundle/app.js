import * as L from "./lore.js";

const $ = sel => document.querySelector(sel);
const EXAMPLES = ["pallets/flask", "encode/httpx", "FalkorDB/falkordb-py", "fastapi/typer"];
const SUGGESTIONS = [
  "Who knows the most about this project overall?",
  "I'm new here. Where should I start?",
  "Which parts of the code depend on a single person?",
  "What changed recently, and who did it?",
];
const FRESH_SECONDS = 24 * 3600;

let anna = null;
let graph = null;
let busy = false;

// --- Host ------------------------------------------------------------------------------------------

/** The SDK has returned both bare results and {ok, result|error} envelopes; accept either. */
function unwrap(r) {
  if (r && typeof r === "object" && "ok" in r && ("result" in r || "error" in r)) {
    if (r.ok) return r.result;
    const e = new Error(r.error?.message || "Anna returned an error");
    e.code = r.error?.code;
    throw e;
  }
  return r;
}

async function complete({ systemPrompt, messages }) {
  const r = unwrap(await anna.llm.complete({
    systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: { type: "text", text: m.content } })),
    maxTokens: 1500,
    temperature: 0.2,
  }, { timeoutMs: 120000 }));
  const content = r?.content;
  return Array.isArray(content) ? content.map(c => c.text || "").join("") : content?.text ?? "";
}

function llmMessage(e) {
  if (e?.code === "quota_exceeded") return "Your Anna usage limit is reached for now, so Lore can't ask the model. The Experts and Knowledge risk tabs still work.";
  if (e?.code === "permission_denied") return "Lore isn't allowed to use the model in this install. Reinstall the app and allow model access.";
  return `The model call failed: ${e?.message || e}`;
}

async function store(key, value) {
  try { unwrap(await anna.storage.set({ key, value })); return true; } catch { return false; }
}
async function load(key) {
  try {
    const r = unwrap(await anna.storage.get({ key }));
    return r && r.exists !== false ? r.value ?? null : null;
  } catch { return null; }
}
const snapKey = repo => `snap/${repo.replace("/", "__")}`;

// --- Rendering helpers -----------------------------------------------------------------------------

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function itemLink(id) {
  const m = id.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  const item = graph?.items.get(id);
  const href = item?.url || (m ? `https://github.com/${m[1]}/issues/${m[2]}` : "#");
  return `<a href="${esc(href)}" target="_blank" rel="noopener" title="${esc(item?.title || "")}">#${m ? m[2] : esc(id)}</a>`;
}
const person = login => `<a class="who" href="https://github.com/${esc(login)}" target="_blank" rel="noopener">@${esc(login)}</a>`;

/** A small, safe Markdown subset: paragraphs, lists, bold, code, citations, @logins. */
function md(text) {
  // Links go in as placeholders, so a later pattern can't match inside a link's own markup.
  const inline = s => {
    const links = [];
    const hold = html => `\u0000${links.push(html) - 1}\u0000`;
    return esc(s)
      .replace(/([\w.-]+\/[\w.-]+#\d+)\b/g, (_, id) => hold(itemLink(id)))
      .replace(/(^|[\s(\[,])#(\d+)\b/g, (_, pre, n) => pre + hold(itemLink(`${graph.repo}#${n}`)))
      .replace(/\[((?:\u0000\d+\u0000|[\s,;])+)\]/g, "$1") // "[a, b]" around links -> "a, b"
      .replace(/(^|[\s(*_])@([A-Za-z0-9-]{1,39})\b/g, (_, pre, login) => pre + hold(person(login)))
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\u0000(\d+)\u0000/g, (_, i) => links[+i]);
  };
  const out = [];
  let list = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      if (!list) { list = []; out.push(list); }
      list.push(`<li>${inline(bullet[1])}</li>`);
    } else if (!line.trim()) {
      list = null;
    } else {
      list = null;
      const h = line.match(/^#{1,4}\s+(.*)$/);
      out.push(h ? `<p><strong>${inline(h[1])}</strong></p>` : `<p>${inline(line)}</p>`);
    }
  }
  return out.map(x => (Array.isArray(x) ? `<ul>${x.join("")}</ul>` : x)).join("");
}

function show(id) {
  for (const s of ["start", "loading", "app"]) $("#" + s).hidden = s !== id;
}
function showError(message) {
  const el = $("#error");
  el.hidden = !message;
  el.innerHTML = message ? `<strong>Something went wrong.</strong> ${esc(message)}` : "";
}
function setBusy(on) {
  busy = on;
  for (const b of document.querySelectorAll("button")) if (!b.closest(".tabs")) b.disabled = on;
}

function chips(el, values, onClick) {
  el.innerHTML = "";
  for (const v of values) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = v;
    b.addEventListener("click", () => onClick(v));
    el.appendChild(b);
  }
}

// --- Loading a repo --------------------------------------------------------------------------------

async function loadRepo(input, { refresh = false } = {}) {
  if (busy) return;
  showError("");
  const repo = L.parseRepo(input);
  if (!repo) return showError("That doesn't look like a GitHub repo. Use owner/repo, like pallets/flask.");
  $("#repo-input").value = repo;
  setBusy(true);
  show("loading");
  $("#loading-title").textContent = `Reading ${repo}…`;
  const steps = $("#loading-steps");
  steps.innerHTML = "";
  try {
    let snap = refresh ? null : await load(snapKey(repo));
    if (snap && Date.now() / 1000 - snap.fetched_at < FRESH_SECONDS) {
      steps.innerHTML = `<li>Using the copy loaded ${ago(snap.fetched_at)}.</li>`;
    } else {
      const gh = L.makeGitHub();
      snap = await L.fetchRepo(repo, {
        gh,
        onProgress: p => {
          const li = document.createElement("li");
          li.textContent = p.detail + (p.remaining != null ? `  ·  ${p.remaining} GitHub calls left this hour` : "");
          if (p.label === "files" && steps.lastElementChild?.dataset.label === "files") steps.lastElementChild.remove();
          li.dataset.label = p.label;
          steps.appendChild(li);
        },
      });
      await store(snapKey(snap.name), L.compactSnapshot(snap));
    }
    graph = L.buildGraph(snap);
    const recent = [snap.name, ...((await load("recent")) || []).filter(r => r !== snap.name)].slice(0, 6);
    await store("recent", recent);
    try { await anna.window.set_title({ title: `Lore · ${snap.name}` }); } catch { /* optional */ }
    renderRepo(snap);
    show("app");
  } catch (e) {
    show("start");
    const hint = e.kind === "rate"
      ? " GitHub allows 60 calls an hour per connection; one repo takes about 40. Try again after the hour, or pick a repo you loaded before."
      : "";
    showError((e.message || String(e)) + hint);
    console.error(e);
  } finally {
    setBusy(false);
  }
}

function ago(t) {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

function renderRepo(snap) {
  const o = L.projectOverview(graph);
  $("#summary").innerHTML = `
    <div><a href="${esc(o.url)}" target="_blank" rel="noopener"><strong>${esc(o.repo)}</strong></a>
      ${o.description ? `<span class="muted"> · ${esc(o.description)}</span>` : ""}</div>
    <div class="stats">
      <span><b>${o.people}</b> people (${o.active_people} active)</span>
      <span><b>${o.prs}</b> PRs</span><span><b>${o.issues}</b> issues</span><span><b>${o.areas}</b> areas</span>
      <span class="muted">${esc(o.history_from)} → ${esc(o.history_to)} · loaded ${ago(snap.fetched_at)}</span>
      <button type="button" class="link" id="refresh">Refresh</button>
    </div>
    ${graph.filesFor < graph.mergedTotal ? `<div class="muted small">Files are read for the ${graph.filesFor} most recent of ${graph.mergedTotal} merged PRs, to stay within GitHub's free allowance.</div>` : ""}
    ${graph.partial ? `<div class="warn small">GitHub's hourly allowance ran out while loading, so this history is partial.</div>` : ""}`;
  $("#refresh").addEventListener("click", () => loadRepo(graph.repo, { refresh: true }));
  $("#ask-out").innerHTML = "";
  $("#triage-out").innerHTML = "";
  chips($("#suggestions"), SUGGESTIONS, q => { $("#ask-input").value = q; ask(q); });
  renderExperts();
  renderRisk();
  renderTriageOptions();
  selectTab("ask");
}

// --- Tabs ------------------------------------------------------------------------------------------

function selectTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.dataset.panel !== name;
}

function evidenceList(ev) {
  if (!ev?.length) return "";
  return `<ul class="evidence">${ev.map(e => `<li><span class="role">${esc(e.role)}</span> ${itemLink(e.id)} ${esc(e.title)} <span class="muted">${esc(e.at || "")}</span></li>`).join("")}</ul>`;
}

function renderExperts() {
  const rows = L.areaDirectory(graph);
  $("#experts-out").innerHTML = rows.length ? rows.map(a => `
    <details class="area">
      <summary><code>${esc(a.area)}</code> <span class="muted">${a.prs} PRs · ${a.files} files</span>
        <span class="people">${a.top.map(t => person(t.login) + (t.active ? "" : ' <span class="muted">(inactive)</span>')).join(", ")}</span></summary>
      <div class="area-body" data-area="${esc(a.area)}"></div>
    </details>`).join("")
    : `<p class="muted">No merged PRs with known files in the loaded history, so there's nothing to rank yet.</p>`;
  for (const d of document.querySelectorAll("#experts-out details")) {
    d.addEventListener("toggle", () => {
      const body = d.querySelector(".area-body");
      if (!d.open || body.dataset.done) return;
      body.dataset.done = "1";
      body.innerHTML = L.whoKnows(graph, [body.dataset.area]).map(p => `
        <div class="expert">${person(p.login)} <span class="muted">score ${p.score} · ${p.authored} merged, ${p.reviewed} reviewed, ${p.commented} commented · last ${esc(p.last_at)}${p.active ? "" : " · inactive"}</span>
        ${evidenceList(p.evidence)}</div>`).join("");
    });
  }
}

function renderRisk() {
  const rows = L.knowledgeRisk(graph);
  $("#risk-out").innerHTML = rows.length
    ? `<ul class="risk">${rows.map(r => `<li><code>${esc(r.area)}</code> · ${r.recent_prs} merged PRs in six months · ${r.knowers.length ? "only " + person(r.knowers[0]) + " knows it well" : "<strong>no active person</strong> knows it well"}</li>`).join("")}</ul>`
    : `<p class="muted">No area with recent work depends on a single active person. Good news.</p>`;
}

function renderTriageOptions() {
  const open = L.openIssues(graph);
  $("#triage-select").innerHTML = open.length
    ? open.map(i => `<option value="${esc(i.id)}">#${esc(i.id.split("#")[1])} ${esc(i.title.slice(0, 90))}</option>`).join("")
    : `<option value="">No open issues in the loaded history</option>`;
  $("#triage-go").disabled = !open.length;
}

// --- Ask -------------------------------------------------------------------------------------------

async function ask(question) {
  question = question.trim();
  if (!question || busy || !graph) return;
  setBusy(true);
  const out = $("#ask-out");
  out.innerHTML = `<div class="q">${esc(question)}</div>
    <details class="hood" open><summary>Under the hood</summary><ol class="trace"></ol></details>
    <div class="answer pending"><div class="spinner small"></div> Thinking…</div>`;
  const trace = out.querySelector(".trace");
  const answer = out.querySelector(".answer");
  try {
    const res = await L.runAgent(graph, question, {
      complete,
      onEvent: ev => {
        if (ev.type === "call") {
          const li = document.createElement("li");
          li.innerHTML = `<code>${esc(ev.tool)}</code> <span class="muted">${esc(JSON.stringify(ev.args))}</span> <span class="res"></span>`;
          trace.appendChild(li);
        } else if (ev.type === "result") {
          const res = trace.lastElementChild?.querySelector(".res");
          if (res) res.textContent = "→ " + ev.summary;
        }
      },
    });
    answer.classList.remove("pending");
    if (!res) {
      answer.innerHTML = `<p class="warn">Lore couldn't finish this one. Try asking it more simply.</p>`;
    } else {
      out.querySelector(".hood").open = false;
      answer.innerHTML = md(res.text) + (res.evidence.items.length
        ? `<div class="sources"><span class="muted">Looked at:</span> ${res.evidence.items.slice(0, 12).map(i => itemLink(i.id)).join(" ")}</div>` : "");
    }
  } catch (e) {
    answer.classList.remove("pending");
    answer.innerHTML = `<p class="warn">${esc(llmMessage(e))}</p>`;
    console.error(e);
  } finally {
    setBusy(false);
  }
}

// --- Triage ----------------------------------------------------------------------------------------

async function runTriage(id) {
  if (!id || busy) return;
  setBusy(true);
  const out = $("#triage-out");
  out.innerHTML = `<div class="answer pending"><div class="spinner small"></div> Looking through the history…</div>`;
  try {
    const r = await L.triage(graph, id, { complete });
    if (r.error) { out.innerHTML = `<p class="warn">${esc(r.error)}</p>`; return; }
    out.innerHTML = `
      <h3>${itemLink(r.issue.id)} ${esc(r.issue.title)}</h3>
      <div class="grid">
        <div><h4>Areas it's about</h4>${r.areas.length ? `<ul>${r.areas.map(a => `<li><code>${esc(a.area)}</code> <span class="muted">${esc(a.reasons.join("; "))}</span></li>`).join("")}</ul>` : `<p class="muted">No area stands out.</p>`}</div>
        <div><h4>Who knows it</h4>${r.reviewers.length ? r.reviewers.map(p => `<div class="expert">${person(p.login)} <span class="muted">score ${p.score}</span>${evidenceList(p.evidence)}</div>`).join("") : `<p class="muted">Nobody active stands out.</p>`}</div>
      </div>
      <h4>Related past work</h4>
      ${r.related.length ? `<ul>${r.related.map(x => `<li>${itemLink(x.id)} ${esc(x.title)} <span class="muted">${esc(x.why.join("; "))}</span></li>`).join("")}</ul>` : `<p class="muted">Nothing related in the last 12 months.</p>`}
      <h4>Drafted reply <span class="muted small">(not posted)</span></h4>
      <div class="draft">${md(r.draft)}</div>
      <button type="button" class="link" id="copy-draft">Copy draft</button>`;
    $("#copy-draft").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(r.draft); $("#copy-draft").textContent = "Copied"; } catch { $("#copy-draft").textContent = "Select the text to copy it"; }
    });
  } catch (e) {
    out.innerHTML = `<p class="warn">${esc(llmMessage(e))}</p>`;
    console.error(e);
  } finally {
    setBusy(false);
  }
}

// --- Boot ------------------------------------------------------------------------------------------

async function boot() {
  try {
    const sdk = await import("/static/anna-apps/_sdk/latest/index.js");
    anna = await sdk.AnnaAppRuntime.connect();
  } catch (e) {
    showError("Lore runs inside Anna. Open it from the Anna App Store.");
    console.error(e);
    return;
  }
  if (anna.onThemeChange) anna.onThemeChange(({ theme }) => { document.documentElement.dataset.theme = theme; });
  else if (anna.theme) document.documentElement.dataset.theme = anna.theme;

  chips($("#examples"), EXAMPLES, r => loadRepo(r));
  const recent = (await load("recent")) || [];
  if (recent.length) { $("#recent-wrap").hidden = false; chips($("#recent"), recent, r => loadRepo(r)); }

  $("#repo-form").addEventListener("submit", e => { e.preventDefault(); loadRepo($("#repo-input").value); });
  $("#ask-form").addEventListener("submit", e => { e.preventDefault(); ask($("#ask-input").value); });
  $("#ask-input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(e.target.value); } });
  $("#triage-form").addEventListener("submit", e => { e.preventDefault(); runTriage($("#triage-select").value); });
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => selectTab(b.dataset.tab));

  // Opened from chat with a repo (open_app_view payload), or a repo the person asked about.
  const payload = anna.entryPayload || {};
  if (payload.repo) loadRepo(payload.repo);
  anna.on?.("entry_payload", p => { if (p?.repo) loadRepo(p.repo); else if (p?.question && graph) ask(p.question); });
}

boot();
