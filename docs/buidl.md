# BUIDL draft for DoraHacks (Anna AI App Builder Program)

Field by field, in the order of the "Create a new Build" form. Paste the plain text; the description box takes Markdown.

## Logo

Upload `docs/logo.png` (512×512).

## Name of your Build

Lore

## Brief description

Who knows what in any public GitHub repo, with the pull requests to prove it.

## Tags

GitHub, Developer Tools, Open Source, AI Agent

## Links

- GitHub Repo: https://github.com/JannetEkka/anna-lore
- Video: none yet (add if one is recorded)
- Website: the Anna app link, once the app exists on Anna

## Description (Markdown)

Every open-source project has people who know a part of the code inside out, and newcomers have no way to find them. CODEOWNERS files go stale. The commit log shows who typed, not who reviewed or who answers questions about it.

Lore reads a repo's last 12 months of pull requests, reviews, issues and comments and works out who knows which directories. Then it answers from that history, with a PR or issue linked for every claim.

### What you can do

- **Ask.** "Who knows the query planner?" "Why was the retry logic changed?" "I'm new, where should I start?" An agent picks queries over the repo's history, shows each step it took, and answers with sources.
- **Experts.** Every area of the code, the people who know it best, and the PRs behind each ranking.
- **Triage an issue.** Pick an open issue and get the related past issues and PRs, who knows that area (never the issue's author), and a drafted first reply. Nothing is posted anywhere.
- **Knowledge risk.** Areas with recent work that only one active person knows well.

### How it works

Paste `owner/repo`. Lore calls GitHub's public API from the app (about 40 calls, inside the free 60 an hour), builds a graph of people, PRs, issues, files and areas, and scores each person per area: a merged PR counts 1.0, a review 0.6, a comment 0.2, and work counts half as much every 180 days. An area is a directory two levels deep, split further where one directory holds more than 6% of the files.

The Ask tab is an agent loop on Anna's LLM (`anna.llm.complete`). The model chooses from nine tools (find areas, who knows them, search history, get an issue or PR, related work, suggested reviewers, knowledge risk, good first issues, overview), reads the results and answers only from them. A loaded repo is cached in Anna storage for a day, so opening it again costs no GitHub calls.

### Built on Anna

Lore is a bundle-only Anna App: the UI and the graph code run in Anna's app window, and the model, storage and hosting are Anna's. The app needs no API key and no server of its own, and every answer runs on the user's own Anna model and credits.

It started as Lore for Graph Hacks (FalkorDB, Oct 2026), which ran on a Python server with FalkorDB and a Gemini key. For Anna I rewrote the graph and scoring in JavaScript and moved the agent onto Anna's LLM.

### Tech

Anna App SDK (`llm.complete`, `storage`), manifest schema 3, GitHub REST API, plain JavaScript and HTML with no framework. Tests: engine tests on a real snapshot of FalkorDB/falkordb-py, and a Chromium test that drives the app with a mock Anna SDK.

## Organizer question: link to your App on the Anna platform

The app's Anna link, once it's created (fill in after `anna-app apps publish`).
