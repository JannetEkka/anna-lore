# Lore for Anna

Who has worked on what in any public GitHub repo, with the pull requests behind it. An Anna App rebuilt from [Lore](https://github.com/JannetEkka/lore) (the Graph Hacks entry, which this repo doesn't change) for the [Anna AI App Builder Program](https://dorahacks.io/hackathon/2349/detail). Progress: [JannetEkka/DSProjects#46](https://github.com/JannetEkka/DSProjects/issues/46).

Paste `owner/repo`. Lore reads the last 12 months of pull requests, reviews, issues and comments, works out who has worked on which directories, and then:

- **Ask**: an agent picks graph queries (find areas, who has worked on them, search history, related issues…), shows each step under the hood, and answers with a citation for every claim.
- **People by area**: each area of the code and the people with the most public activity in it, with the PRs behind each ranking.
- **Triage an issue**: related past work, who has worked on that area (never the issue's author), and a draft reply for the user to edit. Nothing is posted, and the draft makes no promises.
- **Knowledge risk**: areas with recent work where at most one active person has much public activity, each with its PRs and everyone on them.

## How the port works

The original Lore runs on Render with FalkorDB and a Gemini key. On Anna none of that is needed:

| Original Lore | Lore for Anna |
|---|---|
| FalkorDB graph, Cypher queries | the same graph and scores in plain JS (`bundle/lore.js`) |
| Gemini function calling, our key | `anna.llm.complete` on the user's own Anna model and quota, with a JSON tool-call loop |
| GitHub Action snapshots + `git clone` for files | GitHub's REST API from the iframe (`ui.bundle.external_origins`), files per merged PR, about 40 calls per repo |
| FastAPI server on Render | none: a static bundle; Anna hosts it |
| Snapshot files | `anna.storage` (per user): a repo loaded in the last 24 h opens without calling GitHub |

Scoring is Lore's: a merged PR counts 1.0, a review 0.6, a comment 0.2, once per PR and area, halving every 180 days. Areas are directories two levels deep, split where one holds more than 6% of the files.

Without a token GitHub allows 60 calls an hour per connection. One repo takes about 40 (files are read for the 30 most recent merged PRs), and a second load within a day comes from storage.

## Activity, not understanding (v0.1.2)

Public GitHub activity is always partial evidence of who understands code, because people also learn it by reading it, in chat and in private work. v0.1.1 only worded things carefully when the load was partial. Anna's second App Review (Nov 17) showed the overclaiming on a full load too, so in v0.1.2 the careful wording is the default:

- **Every claim says what the history shows.** "@x authored 19 and reviewed 2 of the PRs in these areas; 33 merged PRs touch them in the history Lore read (Dec 7, 2025 – Oct 25, 2026)", never "only @x understands it". A standing note under the repo name says Lore shows who has worked on what, not who understands it. The model's prompt carries the same rules on every load (`EVIDENCE_RULES`).
- **Each PR counts once.** In v0.1.1 a PR touching three directories counted three times, so on the test fixture the model was told @gkorland "authored 34" PRs when the repo has 34 merged PRs in all. The real count is 19 of the 33 whose files Lore read.
- **Knowledge risk shows its evidence.** Each row lists the recent merged PRs (links and dates), says who did what on them, names everyone active on them, and ends with "That's what the public history shows. It doesn't mean nobody else understands it." (`riskText()`).
- **Every answer and draft is checked**, partial data or not. `overclaims()` catches claims about who understands the code ("the only person who understands", "nobody else knows", "bus factor", "knows it best"). `commitments()` catches promises in drafts ("we'll fix", "in the next release", "by Friday", "@x will take a look", assignments). When either finds something, Lore asks the model once to rewrite it. Anything still there is quoted in a "Read with care" or "Before you post" note.
- **Triage drafts are the user's.** The prompt no longer asks for a maintainer's voice, the draft is labelled "Draft for you to edit", and it says it doesn't speak for the project.

Tested: `tests/review-0.1.2.test.mjs` reproduces each of the reviewer's three findings on a complete load. All 8 tests failed on v0.1.1 and pass on v0.1.2. The browser run has 39 checks, 16 of them new on a complete load. On the v0.1.1 bundle, 16 of the 39 fail. The outputs and before/after screenshots are in `docs/review-0.1.2/`. The model in these runs is a scripted mock that reproduces what the reviewer saw, not a real model.

## Partial data (v0.1.1)

Who knows which area comes only from the files of merged PRs, so Lore's conclusions are only as complete as what it read. The data is partial when:

- **GitHub's rate limit cut the load short.** The limit is 60 calls an hour per connection without a token.
- **The repo has more than 30 merged PRs in the last 12 months.** Lore reads files for the 30 most recent, to fit that allowance.
- **The repo has more than 300 PRs in that time.** Older ones aren't listed at all.

`coverage()` in `bundle/lore.js` works this out from the snapshot. While it holds:

- Every result view (the summary, Ask answers, People by area, Triage, Knowledge risk) carries a banner inside it: "Based on partial data: files read for 14 of 34 merged PRs in the last 12 months. GitHub's rate limit stopped the rest. GitHub's limit resets at 05:45; press Refresh after that for a fuller run."
- Each People-by-area and Knowledge-risk row has a "partial data" badge, and the lists carry a watermark.
- Knowledge risk said "Based on fetched data, only @x knows it well" (v0.1.2 replaces this with the PRs themselves), and an empty list is no longer called good news.
- The model is told in its prompt, and again after each tool result, to say "based on the fetched data" and never to state a bus factor or "only X knows" as fact (`dataNote()`). Its text is then checked (`absoluteClaims()`, which v0.1.2 runs on every load as `overclaims()`), and a sentence that still states an absence as fact is quoted in a "Read with care" note above the answer or draft.
- A stored copy that was cut short by the rate limit is dropped once GitHub's limit has reset, so the next load reads the repo again.

Why it matters, on the test fixture (FalkorDB/falkordb-py): with the load stopped after 14 of 34 merged PRs, Knowledge risk lists two areas as known by one person; with 30 read, it lists none. Before and after screenshots of that run are in `docs/review-0.1.1/`. This answers Anna's App Review of Oct 28.

## Files

- `manifest.json`: schema 3, bundle-only (no executas), `llm.complete` and `storage.get/set`, `api.github.com` as the one external origin.
- `app.json`: store listing basics (slug `lore`, category `developer-tools`).
- `bundle/`: `index.html`, `app.js` (UI), `lore.js` (graph, queries, agent; no DOM), `style.css` (follows Anna's light/dark theme), `icon.svg`.
- `tests/`: `npm test` runs the engine tests on a real snapshot of FalkorDB/falkordb-py, served back as GitHub API responses. `npm run test:ui` drives the bundle in Chromium with a mock Anna SDK and writes screenshots to `tests/out/`. A second part replays a load that GitHub's rate limit cuts short, and a third is a complete load with a scripted model that overclaims and makes promises, as in Anna's review of Nov 17. `tests/review-0.1.2.test.mjs` has the engine tests for that review.

## Publish (needs developer access on anna.partners)

```bash
npm i -g @anna-ai/cli
anna-app login --host https://anna.partners --no-browser   # device code: approve it in the browser
anna-app account set-handle <handle>                        # once, before the first app
anna-app validate --strict
anna-app dev                    # optional: the local harness at http://localhost:5180
anna-app apps publish --dry-run # then without --dry-run: mints the version in app.json and uploads the bundle
anna-app apps sync-meta         # when app.json's listing text or screenshots changed
anna-app apps submit-review
anna-app apps release <version> # after approval: an approved version isn't live until it's released
```

Then fill the Listing tab in the Developer Console (description, logo, screenshots from `tests/out/`, homepage = this repo) and check **My Apps** for the review status.

## License

MIT, see [LICENSE](LICENSE).
