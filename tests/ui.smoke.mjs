// Drives the bundle in Chromium with a mock Anna SDK and GitHub's API served from the fixture.
// Run: node tests/ui.smoke.mjs  (writes screenshots to tests/out/)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadFixture, githubRoutes } from "./github-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(new URL(import.meta.url).pathname);
const bundle = path.join(here, "..", "bundle");
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });

const snap = loadFixture();
const routes = githubRoutes(snap, { remaining: 60 });
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
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
    const r = routes(url.toString());
    return route.fulfill({ status: r.status, headers: { ...r.headers, "access-control-allow-origin": "*" }, body: JSON.stringify(r.body) });
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

const check = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

await page.goto("http://lore.test/anna-apps/lore/dev/index.html?wid=w-test&t=x");
await page.waitForSelector("#examples .chip");
await page.screenshot({ path: path.join(out, "1-start.png") });

await page.fill("#repo-input", "https://github.com/FalkorDB/falkordb-py");
await page.click("#repo-load");
await page.waitForSelector("#app:not([hidden])", { timeout: 20000 });
check((await page.textContent("#summary")).includes("52 PRs"), "summary shows the loaded history");
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

check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
