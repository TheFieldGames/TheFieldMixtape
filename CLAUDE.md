# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is not a software project in the usual sense — it's the source for **TheFieldMixtape**, a Thunderstore package (mod) for the game **PEAK**. It's a crowd-sourced playlist consumed by the `onlystar-sPEAKer` mod, which plays `.ogg` tracks in-game. The repo root *is* the package: everything at root (minus dot-prefixed files/dirs) gets zipped and uploaded to Thunderstore.

It now *also* hosts the source for `.contribute-app/`, a small Node/Express web app that lets a trusted friend group add tracks without a PR — see "The contribute-app web application" below. That subdirectory is dot-prefixed specifically so it's excluded from the Thunderstore package (verified empirically, see that section).

## Layout

- `README.md` — the numbered tracklist, between `<!-- TRACKLIST:START -->`/`<!-- TRACKLIST:END -->` sentinel comments. Auto-generated (by the app now; historically by `.github/workflows/sync-tracklist.yml` on PRs) from whatever `.ogg` files currently exist — don't hand-edit the list itself.
- `my mixtape/` — one `.ogg` file per track, plus `mixtape.json` (mixtape display metadata: `name`, `author`, consumed by the sPEAKer mod at runtime). **These `.ogg` files are legacy/vestigial as of the R2 migration** (see below) — they're still git-tracked and still get zipped into the package (via `thunderstore.toml`'s `[[build.copy]]`), but going forward, new tracks added via the app live in Cloudflare R2, not here. Don't add new tracks to this folder directly; that's what the app is for.
- `icon.png` — Thunderstore listing icon. Must stay a 256x256 PNG.
- `sPEAKer.json` — currently empty; reserved by the sPEAKer mod loader.
- `thunderstore.toml` — **new**, replaces the old GitHub Actions `with:` block as the source of truth for package metadata (namespace, name, description, dependencies, communities, categories, build file mappings). Read by `tcli` directly (see below). Update namespace/name/deps/communities/categories *here*, not anywhere else.
- There is **no `manifest.json`** in this repo on purpose. `tcli build` auto-generates one from `thunderstore.toml`'s `[package]` fields. A committed one would collide with the CLI-generated one at the package root and break the build. Do not add one back.
- `.contribute-app/` — the web app (see its own section below). Dot-prefixed so it's excluded from the Thunderstore package.
- `MixTapeWebPlan.md` (**untracked, gitignored, local-only**) — the full design history/decision log for the web app, far more detailed than this file. If it's missing from your working directory, it never made it to this machine/clone and this CLAUDE.md is the only summary left; ask the user before assuming any design detail not written here.
- `PLAN.md` (**untracked, gitignored, local-only**) — separate, unrelated notes about a copyright-risk concern: most of the 56+ tracks already in `my mixtape/` are uncleared commercial music. Not acted on. The R2 migration (below) was partly motivated by this (decouples "how many tracks" from "how big/slow is every git operation"), but does **not** address the underlying copyright exposure — that's a deliberately separate, not-yet-triggered decision (a full git-history purge via `git filter-repo`/BFG).

## Publishing: `thunderstore.toml` + the contribute-app, not GitHub Actions

**`.github/workflows/main.yml` has been deleted.** There is no longer a CI pipeline that auto-publishes on push to `main`. Publishing is now done directly by `.contribute-app` calling `tcli` (Thunderstore's official CLI), one track submission at a time. If you're looking for "what happens when someone pushes to main" — the answer is now "nothing publishes automatically," which is a deliberate, load-bearing change from the old behavior. Do not reintroduce an Actions-based publish workflow without understanding this app now owns that responsibility.

Mechanics (implemented in `.contribute-app/src/publish.js` + `tcli.js`):
- The app always builds first (`tcli build --config-path thunderstore.toml --package-version X.Y.Z`), then publishes the exact resulting zip (`tcli publish --config-path thunderstore.toml --file <that zip>`) — verified that `--file` skips tcli's internal rebuild entirely. This exists so the app can measure the exact package size before upload (see bandwidth tracking below), not just as an optimization.
- Version numbers still come from git tags (`vX.Y.Z`, patch-bumped from the highest existing tag via `git ls-remote --tags`), computed by the app inline — no GitHub Actions tag-bump action anymore.
- `TCLI_AUTH_TOKEN` is read by `tcli` from the environment natively (never passed as a CLI flag, so it never appears in a process listing).

**Known consequence, not yet fixed**: `.github/CONTRIBUTING.md` (the legacy PR-based contribution flow for outside/non-trusted contributors) still says "a maintainer merges your PR and the mixtape republishes" — that's false now. `.github/workflows/sync-tracklist.yml` still works (regenerates the README on PRs touching `my mixtape/**`), but nothing publishes after a merge anymore. `CONTRIBUTING.md` needs a rewrite to either retire that flow or note a maintainer must manually publish afterward. Flagged repeatedly, not yet done as of this writing.

## The contribute-app web application (`.contribute-app/`)

A password-gated Node/Express app so a small trusted friend group can add tracks without git/GitHub knowledge, without a PR, and with immediate (not batched) publishing. Full design rationale and decision history lives in `MixTapeWebPlan.md` — this section is the load-bearing summary.

**Current status as of this writing**: fully built and unit-tested locally (142 tests, `npm test`), including one successful **real, live production publish** run locally by the user. **Not yet deployed to Render** — and not yet even pushed to GitHub: only `thunderstore.toml` and the `main.yml` deletion have been committed to `main` so far (a deliberate, scoped-down first push to unblock testing). `.contribute-app/`'s actual source has never been committed. Two concrete next steps before friends can use this on the internet: (1) commit+push `.contribute-app/` itself, (2) create the Render service from `render.yaml`, connect the repo, fill in real secrets in Render's dashboard.

**Architecture**:
- Audio storage: Cloudflare R2 (S3-compatible, free at this scale, zero egress fees), not git, going forward. Bucket key convention: `my mixtape/<Title> - <Artist>.ogg` (matches the package's internal zip layout). `src/storage.js`.
- Git is still used, but only for the lightweight stuff: cloning `main` for `README.md`/`thunderstore.toml`/etc., committing the regenerated README, tagging the version, pushing. Every clone is fresh and always sources from `main` specifically (`publish.SOURCE_BRANCH`), regardless of where the result gets pushed — `git clone --branch <name>` requires that branch to already exist remotely, and the push target (`config.branch`) can be a disposable not-yet-existing local-dev branch.
- One in-process mutex (`src/queue.js`, `runExclusive`) serializes all submissions — required because the app must run as exactly one instance (no horizontal scaling) for this to be correct. Render's free/Starter plans do this by default.
- **Dry run**: a checkbox that runs the entire real pipeline except the final `tcli publish` — isolated via a separate R2 key prefix (`dry-run/`), a separate fixed git branch (`contribute-app-dry-run`, force-pushed/reused), and a separate tag prefix (`dryrun-`) so it can never pollute the real track library, git history, or version sequence. Safe to use even against production.
- **Limits**: 70 tracks max (checked twice — early, and again immediately before the real publish as a final safety net), 8000KB max per converted `.ogg` file.
- **Monthly bandwidth tracking** (`src/bandwidth.js`): Render's free/Hobby tier caps *outbound* bandwidth at 5GB/month, per-workspace (verified directly against Render's docs — a "100GB" figure exists in older sources but was the *legacy* plan, force-migrated away 2026-08-01). Every `tcli publish` uploads the *entire* package (Thunderstore versions are immutable, complete zips, not diffs) — that's the actual bandwidth consumer, not the R2 download (which is inbound to Render and doesn't count). The app locks out real publishing at 4.5GB (deliberate safety margin) tracked via a `bandwidth-usage.json` object in R2, resets on the calendar month. `config.trackBandwidth` (env: `DISABLE_BANDWIDTH_TRACKING`) lets a *local* instance opt out entirely — Render's cap only meters Render's own servers, so a real publish run from a non-Render machine structurally can't consume any of it; safe-by-default (tracking stays on unless explicitly disabled), opt-out is only appropriate in a local `.env`, never on Render itself.
- Logging: `src/logger.js`, plain timestamped stdout/stderr — deliberately no logging library, since Render captures container stdout/stderr automatically with zero setup. Every submission stage logs with elapsed time; the whole pipeline takes 1-2 minutes in production (dominated by git clone + ffmpeg conversion, not R2).

**Planned, not built** (see `MixTapeWebPlan.md`'s "Future extension" sections for full detail): a track list page (who added what, when — via a new `manifest.json` in R2, decided over a database), the ability to delete tracks, queueing multiple adds/deletes before a single batched publish, and a publish history log. Legacy tracks that predate the manifest get backfilled with `"addedBy": "TEMP"` (the user knows the real authors and will correct them individually — not a claim they're unknown).

## Local dev environment notes (this machine specifically)

No Node/Docker/ffmpeg/tcli were preinstalled when this was set up. If continuing on this same machine: a portable Node 20 install lives at `~/.local/node` (added to `PATH` via `~/.zshrc`), and `ffmpeg`/`tcli`/`gh` binaries live at `~/.local/bin` (also on `PATH`). `.contribute-app/.env` (gitignored) already has real local credentials filled in, with `DISABLE_BANDWIDTH_TRACKING=true` and `GIT_TARGET_BRANCH=contribute-app-test` set for safe local testing — `GIT_TARGET_BRANCH` only affects git push target, not R2 or Thunderstore, so a real (non-dry-run) local submission still really publishes. Run locally with `npm run dev` (loads `.env` via Node's native `--env-file`, no dotenv dependency).
