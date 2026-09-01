# slipgate-tgws-cli-macos

Automated **macOS (arm64)** headless `TgWsProxy` CLI mirror for
[Slipgate](https://github.com/xdxdxdestra-svg/SlipgateFIX).

Flowseal publishes `tg-ws-proxy` for macOS only as
`TgWsProxy_macos_universal.dmg` (a GUI `.app`), which Slipgate cannot launch
as a child process. This repo builds a **bare** `TgWsProxy` CLI binary
(PyInstaller `--onefile --console --target-arch arm64`) straight from Flowseal
source and publishes it as a GitHub release with the **same tag** as upstream,
so Slipgate's `tgws-updater` can fetch and install it on macOS.

## How it works

- Runs on a `macos-14` runner: daily cron **plus** manual `workflow_dispatch`.
- Resolves the latest `Flowseal/tg-ws-proxy` release tag (or a tag you pass).
- **Skips** if the mirror release for that tag already exists (idempotent) —
  unless you run with `force: true`.
- Clones the upstream tag, strips GUI-only deps, builds the CLI, smoke-tests it.
- Publishes a release `<tag>` containing a single asset: `TgWsProxy`
  (no extension — the exact name the app's updater matches).

## Deploy

1. Create the repo **`xdxdxdestra-svg/slipgate-tgws-cli-macos`** on GitHub.
2. Push this folder (`.github/workflows/build.yml`, `build-mac.sh`, `README.md`).
3. **Actions → Allow** workflows. The workflow already requests
   `permissions: contents: write`, which the default `GITHUB_TOKEN` satisfies.
4. Trigger **Run workflow** once (or wait for the daily cron). The first run
   mirrors the current upstream tag and the macOS "Update TgWsProxy" button in
   Slipgate starts working.

## Consumed by

`src/main/core/tgws-updater.ts` in SlipgateFIX (the `IS_MAC` branch):

```ts
const REPO = IS_MAC ? 'xdxdxdestra-svg/slipgate-tgws-cli-macos' : 'xdxdxdestra-svg/slipgate-tgws-cli'
```

The updater looks for a bare `TgWsProxy` asset (no extension) and re-signs it
ad-hoc at install time via `fixMacBinaryInPlace`.

## Local build

```sh
UPSTREAM_TAG=v1.10.0 ./build-mac.sh   # outputs dist/TgWsProxy
```
