# Develop Minv

Minv is a standalone Electron app: the core Git, file and search services in `src/core/`, the desktop host in `desktop/main/` and `desktop/preload/`, the Signal renderer in `desktop/renderer/`, and a text editor compiled from pinned Code-OSS source by `scripts/editor-build.mjs`.

Requirements: Linux x64 with kernel 6.12 or newer (Landlock ABI 6), Git 2.48 or newer, a C compiler, Xvfb for the window tests, and Node.js 24.18.0 with npm.

```sh
npm ci && npm --prefix desktop/renderer ci
npm run upstream:fetch          # shallow fetch of the pinned Code-OSS commit into .upstream/vscode
npm run desktop:build           # sandbox helper, core, editor (when its audit fails), renderer and app
npm start -- /path/to/workspace
```

## Checks

| Command | What it proves |
| --- | --- |
| `npm run check` | Core, desktop and renderer type-check. |
| `npm test` | Core Git, catalog, files, search, sandbox, session, update and watcher tests in temporary repositories. |
| `npm run editor:audit` | The compiled editor matches the reviewed input list in `product/editor-inputs.json`. |
| `node scripts/desktop-smoke.mjs` | Boots the real app in Xvfb against a disposable workspace, checks IPC, Git data, the editor and network denial, and captures the window. Set `MINV_SMOKE_GALLERY=1` to also capture the find bar, replace bar, go-to-line prompt and context menu. |
| `node scripts/desktop-capture.mjs <workspace> [out]` | Opens any workspace in Xvfb, records when rows, branches and statuses arrive, and captures the window. |
| `npm run desktop:package` | Builds and audits `build/release/minv-<version>-linux-x64.tar.gz`. |

Changing the editor's contributions changes its compiled closure. Rebuild with `npm run editor:build`, review the difference, then update `product/editor-inputs.json` from `desktop/editor/generated/metafile.json`.

## Continuous integration and releases

`.github/workflows/ci.yml` runs every check above on pushes and pull requests and uploads the packaged archive. Pushing a tag `v<version>` that matches `package.json` runs the same pipeline and publishes the archive and its checksum as a GitHub release:

```sh
npm version 0.2.0 --no-git-tag-version   # or edit package.json
git commit -am "Release 0.2.0" && git tag v0.2.0 && git push origin main v0.2.0
```

Releases are unsigned. The signed update channel in [UPDATES.md](UPDATES.md) is not wired to them yet.
