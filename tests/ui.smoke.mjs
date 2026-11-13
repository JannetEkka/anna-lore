// Drives the bundle in Chromium with a mock Anna SDK and GitHub's API served from the fixture.
// Run: node tests/ui.smoke.mjs  (writes screenshots to tests/out/)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadFixture, githubRoutes } from "./github-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(new URL(import.meta.url).pathname);
// LORE_BUNDLE / LORE_OUT point the same run at another copy of the bundle (the before/after screenshots).
const bundle = process.env.LORE_BUNDLE || path.join(here, "..", "bundle");
const out = process.env.LORE_OUT || path.join(here, "out");
fs.mkdirSync(out, { recursive: true });

const snap = loadFixture();
let routes = githubRoutes(snap, { remaining: 60 });
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const browser = await chromium.launch();
const errors = [];

/** A fresh Lore window: its own storage, a fixed clock, GitHub and the Anna SDK served from here. */
async function openLore({ overstates = false } = {}) {
const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, timezoneId: "UTC", locale: "en-GB", deviceScaleFactor: 2 });
page.on("pageerror", e => errors.push(e.message));
// The browser logs GitHub's own 403 when the rate limit hits; that one is the scenario, not a fault.
page.on("console", m => { if (m.type() === "error" && !/status of 403/.test(m.text())) errors.push(m.text()); });
if (overstates) await page.addInitScript(() => { window.__mockOverstates = true; });
await page.addInitScript(fixedNow => {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixedNow])); }
    static now() { return fixedNow; }
  };
}, snap.fetched_at * 1000);

await page.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.hostname === "api.github.com") {
    // Like GitHub, expose the rate-limit headers to the page, or the app can't tell a rate limit from a refusal.
    const r = routes(url.toString());
    return route.fulfill({ status: r.status, headers: { ...r.headers, "access-control-allow-origin": "*", "access-control-expose-headers": "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset" }, body: JSON.stringify(r.body) });
  }
  if (url.pathname === "/static/anna-apps/_sdk/latest/index.js") {
    return route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(here, "mock-sdk.js")) });
  }
  const m = url.pathname.match(/^\/anna-apps\/lore\/dev\/(.*)$/);
  if (m) {
    const file = path.join(bundle, m[1] || "index.html");
    if (fs.existsSync(file)) return route.fulfill({ status: 200, contentType: types[path.extname(file)], body: fs.readFileSync(file) });
  }
  return route.fulfill({ status: 404, body: "not found" });
});
return page;
}
const page = await openLore();

const check = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

await page.goto("http://lore.test/anna-apps/lore/dev/index.html?wid=w-test&t=x");
await page.waitForSelector("#examples .chip");
await page.screenshot({ path: path.join(out, "1-start.png") });

await page.fill("#repo-input", "https://github.com/FalkorDB/falkordb-py");
await page.click("#repo-load");
await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
check((await page.textContent("#summary")).includes("52 PRs"), "summary shows the loaded history");
check(/Based on partial data: files read for 30 of 34 merged PRs.*30 most recent merged PRs only/.test(await page.textContent("#summary")), "the 30-PR cap is stated as partial data");
check(!(await page.textContent("#summary")).includes("rate limit stopped"), "a load that wasn't rate limited doesn't blame the rate limit");
await page.screenshot({ path: path.join(out, "2-loaded.png") });

await page.click("#suggestions .chip");
await page.waitForSelector(".answer:not(.pending)", { timeout: 20000 });
const answer = await page.innerHTML(".answer");
check(answer.includes('href="https://github.com/gkorland"'), "answer links people");
check(answer.includes("/pull/236") && answer.includes("/pull/198") && !answer.includes("["), "answer links grouped citations and drops the brackets");
check((await page.$$(".trace li")).length === 2, "under the hood shows two tool calls");
await page.screenshot({ path: path.join(out, "3-ask.png"), fullPage: true });

await page.click('.tabs button[data-tab="experts"]');
await page.click("#experts-out details summary");
await page.waitForSelector(".area-body .expert");
await page.screenshot({ path: path.join(out, "4-experts.png"), fullPage: true });

await page.click('.tabs button[data-tab="triage"]');
await page.click("#triage-go");
await page.waitForSelector(".draft", { timeout: 20000 });
check((await page.textContent("#triage-out")).includes("Related past work"), "triage shows related work");
await page.screenshot({ path: path.join(out, "5-triage.png"), fullPage: true });

await page.click('.tabs button[data-tab="risk"]');
await page.screenshot({ path: path.join(out, "6-risk.png"), fullPage: true });

// Second load comes from storage, without GitHub.
const callsBefore = await page.evaluate(() => window.__annaCalls.filter(c => c[0] === "storage.set").length);
await page.fill("#repo-input", "FalkorDB/falkordb-py");
await page.click("#repo-load");
await page.waitForSelector("#app:not([hidden])");
check((await page.textContent("#loading-steps")).includes("Using the copy"), "a second load uses the stored copy");
check(callsBefore >= 2, "snapshot and recent list were stored");

// Bad input shows an error, not a crash.
await page.fill("#repo-input", "not a repo");
await page.click("#repo-load");
check(!(await page.isHidden("#error")), "bad input shows an error");

await page.close();

// --- A load cut short by GitHub's rate limit (Anna's App Review, Oct 28) ---------------------------
routes = githubRoutes(snap, { remaining: 20, reset: snap.fetched_at + 1800 });
const p2 = await openLore({ overstates: true });
await p2.goto("http://lore.test/anna-apps/lore/dev/index.html?wid=w-test&t=x");
await p2.fill("#repo-input", "FalkorDB/falkordb-py");
await p2.click("#repo-load");
await p2.waitForSelector("#app:not([hidden])", { timeout: 20000 });
const banner = /Based on partial data: files read for \d+ of 34 merged PRs in the last 12 months\. GitHub's rate limit stopped the rest\. GitHub's limit resets at \d\d:\d\d; press Refresh after that/;
check(banner.test(await p2.textContent("#summary")), "rate-limited: the summary says how much was read and when GitHub resets");
await p2.screenshot({ path: path.join(out, "partial-1-loaded.png") });

await p2.click('.tabs button[data-tab="experts"]');
check(banner.test(await p2.textContent("#experts-out")), "rate-limited: Experts carries the banner inside the results");
const areaRows = await p2.$$("#experts-out details");
check(areaRows.length > 0 && (await p2.$$("#experts-out summary .partial-badge")).length === areaRows.length, "rate-limited: every Experts row has a partial-data badge");
check(await p2.$eval("#experts-out", el => el.classList.contains("partial-list")), "rate-limited: the Experts list is watermarked");
await p2.click("#experts-out details summary");
await p2.waitForSelector(".area-body .expert");
await p2.screenshot({ path: path.join(out, "partial-2-experts.png"), fullPage: true });

await p2.click('.tabs button[data-tab="risk"]');
const risk = await p2.textContent("#risk-out");
check(banner.test(risk) && risk.includes("don't read this as the project's bus factor"), "rate-limited: Knowledge risk carries the banner inside the results");
const riskRows = await p2.$$eval("#risk-out .risk li", els => els.map(e => e.textContent));
check(riskRows.length > 0 && riskRows.every(t => /Based on fetched data, (only @[\w-]+|no active person) knows it well/.test(t) && /partial data/i.test(t)),
  `rate-limited: each of the ${riskRows.length} risk rows says "Based on fetched data" and has a badge`);
check((await p2.textContent(".panel[data-panel=risk] .hint")).includes("in the data Lore fetched"), "rate-limited: the Knowledge risk hint is softened");
await p2.screenshot({ path: path.join(out, "partial-3-risk.png"), fullPage: true });

await p2.click('.tabs button[data-tab="ask"]');
await p2.click("#suggestions .chip:nth-child(3)");
await p2.waitForSelector(".answer:not(.pending)", { timeout: 20000 });
const llm = await p2.evaluate(() => window.__annaCalls.filter(c => c[0] === "llm.complete").map(c => c[1]));
check(/The data is PARTIAL: files read for \d+ of 34 merged PRs/.test(llm[0].systemPrompt), "rate-limited: the model's prompt says the data is partial");
check(/Reminder: the data is partial/.test(llm[1].messages.at(-1).content.text), "rate-limited: each tool result repeats it");
const askOut = await p2.textContent("#ask-out");
check(banner.test(askOut), "rate-limited: the answer carries the banner");
check(askOut.includes("Read with care") && askOut.includes("bus factor of one") && (await p2.$$(".caveat li")).length === 1,
  "rate-limited: an answer that overstates is flagged, and its hedged sentence is not");
await p2.screenshot({ path: path.join(out, "partial-4-ask.png"), fullPage: true });

await p2.click('.tabs button[data-tab="triage"]');
await p2.click("#triage-go");
await p2.waitForSelector(".draft", { timeout: 20000 });
check(banner.test(await p2.textContent("#triage-out")), "rate-limited: Triage carries the banner");
check(/The data is PARTIAL/.test(await p2.evaluate(() => window.__annaCalls.filter(c => c[0] === "llm.complete").at(-1)[1].messages[0].content.text)), "rate-limited: the triage prompt says the data is partial");
await p2.screenshot({ path: path.join(out, "partial-5-triage.png"), fullPage: true });

check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
