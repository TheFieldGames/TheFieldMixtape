# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is not a software project — it's the source for **TheFieldMixtape**, a Thunderstore package (mod) for the game **PEAK**. It's a crowd-sourced playlist consumed by the `onlystar-sPEAKer` mod, which plays `.ogg` tracks in-game. The repo root *is* the package: it gets zipped and uploaded to Thunderstore as-is.

## Layout

- `README.md` — the numbered tracklist. This is the human-editable source of truth for what's in the mixtape; add/remove songs here.
- `my mixtape/` — the actual payload: one `.ogg` file per track (large binaries, ~4-5MB each), plus `mixtape.json` (mixtape display metadata: `name`, `author`, consumed by the sPEAKer mod at runtime).
- `icon.png` — Thunderstore listing icon. Must stay a 256x256 PNG.
- `sPEAKer.json` — currently empty; reserved by the sPEAKer mod loader.
- There is **no `manifest.json`** in this repo on purpose — see CI notes below. Do not add one back without reading the CI section first.

## CI / Release pipeline (`.github/workflows/main.yml`)

Every push to `main` auto-versions and publishes a new package to Thunderstore. There is no manual release step and no separate build/test commands — the pipeline is the entire "build."

1. **Trigger**: `push` to `main` (not tag push).
2. **Auto-tag**: `anothrNick/github-tag-action` reads the latest `vX.Y.Z` git tag, bumps the patch version, and pushes the new tag using the default `GITHUB_TOKEN`.
3. **Publish**: `GreenTF/upload-thunderstore-package@v4.3` (wraps Thunderstore's `tcli`) builds and uploads the zip, using the tag from step 2 as `version`.

Practical implications:
- **Every commit to `main` ships a new mod version.** There's no staging/review gate — pushing to main is the release action.
- The package version is *not* tracked in any committed file; it lives only in git tags. Don't hardcode a `version:` in the workflow — it's meant to be sourced from the auto-bump step's `new_tag` output.
- Do not reintroduce a root-level `manifest.json`. `tcli build` auto-generates one from the workflow's `namespace`/`name`/`version`/`description`/`deps` inputs, and the action's `entrypoint.sh` only special-cases `README.md`/`icon.png`/`CHANGELOG.md` (pulling them out before packaging) — it does *not* special-case `manifest.json`. A committed one collides with the CLI-generated one at the package root and breaks the build (`tcli` reports "Some issues were encountered when building").
- The `GreenTF/upload-thunderstore-package` action has a known bug in its `entrypoint.sh`: if the `repo:` input is left unset, it falls into a branch that sets the publish target to an empty string, which corrupts the `tcli publish` argument list (fails with `Name or service not known (file:443)`). This workflow works around it by explicitly setting `repo: https://thunderstore.io`, which routes into the (hardcoded-anyway) branch that does the right thing. Keep that `repo:` input set even though it looks redundant.
- `namespace`, `community`, `name`, `deps`, and `categories` in the `with:` block mirror what would otherwise live in a Thunderstore `manifest.json`/`thunderstore.toml` — update them there, not in a manifest file.
- Requires two repo secrets: `GITHUB_TOKEN` (automatic, no setup — just needs "Read and write permissions" under Settings → Actions → General → Workflow permissions for the tag-push step to succeed) and `TCLI_AUTH_TOKEN` (a Thunderstore service-account token, set manually under Settings → Secrets and variables → Actions).

## Adding or changing tracks

1. Add the `.ogg` file to `my mixtape/`.
2. Add a corresponding numbered entry to the tracklist in `README.md`.
3. Commit to `main` — this alone triggers a new published version, no further action needed.
