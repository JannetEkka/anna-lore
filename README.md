# Lore for Anna

Who knows what in any public GitHub repo, with the pull requests to prove it. An Anna App rebuilt from [Lore](https://github.com/JannetEkka/lore) (the Graph Hacks entry, which this repo doesn't change) for the [Anna AI App Builder Program](https://dorahacks.io/hackathon/2349/detail). Progress: [JannetEkka/DSProjects#46](https://github.com/JannetEkka/DSProjects/issues/46).

Paste `owner/repo`. Lore reads the last 12 months of pull requests, reviews, issues and comments, works out which people know which directories, and then:

- **Ask**: an agent picks graph queries (find areas, who knows them, search history, related issues…), shows each step under the hood, and answers with a citation for every claim.
- **Experts**: each area of the code and the people who know it, with the PRs behind each ranking.
- **Triage an issue**: related past work, who knows that area (never the issue's author), and a drafted first reply. Nothing is posted.
- **Knowledge risk**: areas with recent work that at most one active person knows well.

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

## Files

- `manifest.json`: schema 3, bundle-only (no executas), `llm.complete` and `storage.get/set`, `api.github.com` as the one external origin.
- `app.json`: store listing basics (slug `lore`, category `developer-tools`).
- `bundle/`: `index.html`, `app.js` (UI), `lore.js` (graph, queries, agent; no DOM), `style.css` (follows Anna's light/dark theme), `icon.svg`.
- `tests/`: `npm test` runs the engine tests on a real snapshot of FalkorDB/falkordb-py, served back as GitHub API responses. `npm run test:ui` drives the bundle in Chromium with a mock Anna SDK and writes screenshots to `tests/out/`.

## Publish (needs developer access on anna.partners)

```bash
npm i -g @anna-ai/cli
anna-app login --host https://anna.partners --no-browser   # device code: approve it in the browser
anna-app account set-handle <handle>                        # once, before the first app
anna-app validate --strict
anna-app dev                    # optional: the local harness at http://localhost:5180
anna-app apps publish --dry-run # then without --dry-run: mints the version and uploads the bundle
anna-app apps submit-review
```

Then fill the Listing tab in the Developer Console (description, logo, screenshots from `tests/out/`, homepage = this repo) and check **My Apps** for the review status.

## License

MIT, see [LICENSE](LICENSE).
