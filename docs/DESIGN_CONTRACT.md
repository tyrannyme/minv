# Renderer ⇄ host contract

**Status:** version 4, authoritative. Source of truth: [`desktop/renderer/src/contract.ts`](../desktop/renderer/src/contract.ts). If this prose and the types disagree, the types win and this file gets fixed. Visual design: [DESIGN.md](DESIGN.md).

## Architecture position

The Minv renderer (`desktop/renderer/`) draws the whole window. Code-OSS supplies the **text editor** (`desktop/editor/generated`, standalone build with an audited contribution set) and nothing else: no workbench, parts, activity bar, status bar, title bar, quick input or views.

Review diffs are rendered by Minv from backend-owned hunks. Editable buffers, dirty-versus-disk comparisons and CLI `--diff` comparisons use the Code-OSS editor and diff editor.

```
Electron main (src/core services) ⇄ IPC ⇄ preload: window.minvHost ⇄ renderer (dist/main.js)
                                               trusted bootstrap: window.minvEditor (optional)
```

## Entries and packaging

| File | Use |
| --- | --- |
| `desktop/renderer/index.html` → `dist/main.js` | **Desktop.** Requires `window.minvHost`. Its import closure never reaches `dist/mock/` (a test enforces this). |
| `desktop/renderer/preview.html` → `dist/preview.js` | Standalone preview over the fixture host. Never ship. |

- Ship `index.html`, `styles/`, `assets/` (fonts and OFL licenses), `dist/` minus `dist/mock/` and `dist/preview.*`, plus `desktop/design-tokens.css`.
- `index.html` links `../design-tokens.css` and `../editor/generated/editor.css`.
- Build with `npm --prefix desktop/renderer run build` (local `tsc` only).
- CSP: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'`. The `'unsafe-inline'` style is required by the Code-OSS editor.
- Window background: `desktop/design-tokens.json` → `themes[<resolved appearance>].canvas`. Use `dark` for `system` when the OS is dark, `light` otherwise.

### Editor

If `window.minvEditor` exists, the renderer uses it. Otherwise `main.ts` imports `../../editor/generated/editor.js` and wraps it with `createCodeOssAdapter` (`src/editor/codeoss.ts`). Either way the adapter contract is the same. The adapter:

- starts `initializeLanguages()` immediately;
- creates models as plaintext until grammars are ready, then switches language. A model created under its final language id before registration never tokenizes;
- applies the Minv theme from live CSS tokens (`themeFromTokens`).

## Lifecycle

1. `workspace.get` → paint the cached rows or the welcome page. `prefs.get` follows. Listeners are attached first.
2. `window.ready` is sent after `boot()` resolves. **The host holds `open`/`compare` events until then.**
3. `session.get` is read **once per workspace id**. The renderer restores layout and documents, then debounces `session.save` (about 700 ms, only on change).
4. On `workspace.willClose {requestId, reason}`, the renderer:
   1. persists every dirty buffer through `fs.recover` (any failure means `allow: false`);
   2. asks Save all / Keep as drafts / Cancel;
   3. flushes `session.save`;
   4. answers `workspace.closeReady {requestId, allow}`.

   This applies to renderer-initiated open and close, CLI reuse-window and native window close. `beforeunload` is blocked while dirty and not approved.

## Obligations

### Rows and freshness
- `rows` carries whole rows for changed ids. The renderer keeps first-seen order (or the saved session order) and appends new ids. Per-field `generation` is monotonic; older generations are ignored.
- `Observation.state` is rendered literally. Never publish `observed` for cached data; on invalidation send `stale` and keep the value. Errors are sentences.
- `status.value.complete === false` renders as partial (`12+`).

### Writes: tickets bound to what the user saw
- `git.prepare {repositoryId, action, paths?, basis}` returns a single-use ticket bound to the action, the exact paths and the basis.
- Basis `{kind:'review', reviewId}` comes from `git.hunks` or `git.diff`. Basis `{kind:'status', generation}` is the displayed status generation (list actions, commit slip; commit sends no paths). Basis `{kind:'none'}` covers fetch/pull/push, branch create/switch and stash apply/drop.
- The host rejects with `stale-review` when the repository moved past the basis. The renderer then re-reads; it never retries silently.
- Hunks: `git.hunks` returns backend-owned `{reviewId, hunks:[{id, header, patch}]}`. `git.applyHunks {reviewId, ids}` stages (unstaged side) or unstages (staged side) and consumes the review. The renderer never sends patch text.
- `git.discard` requires `confirmed: true`; the host backs up first. The renderer takes the ticket *before* showing the confirmation, which lists the exact paths.
- Remote operations are only ever user-initiated. Pull is fast-forward only; push is never forced. `git.cancel {repositoryId}` stops network work; the original call rejects with `cancelled` or `uncertain`.

### Files
- `fs.read` returns `version` (fingerprint), `encoding`, `bom` and `eol`. `fs.write` echoes `baseVersion`, `encoding` and `bom`, and rejects with `conflict`. No force flag exists. *Keep mine* re-reads the disk version, confirms explicitly, and saves on the new base.
- `fs.list` and `fs.findPaths` return `complete` and an optional `note`; the UI shows incompleteness inline.
- Create, transfer (rename and copy; confirm crossings), delete (backup), backups, restore, `fs.removeBackup`, recovery drafts (`fs.recover/recoveries/readRecovery/removeRecovery`).
- `file.changed`: clean buffers reload; dirty buffers keep their text and show a reconciliation bar (Compare / Use disk version / Keep mine).

### Restricted mode
`trusted: false` permits passive reads (branches, status, diffs, files). Every write and every hook is refused (`untrusted`). Trust changes only through `workspace.trust`, after the renderer's explicit dialog.

### CLI
- `open {repositoryId, path?, line?, column?, diff?, wait?}` opens or reuses a document. Repeated `--wait` handles accumulate; all are released through `cli.released` when the document closes.
- `compare {left: FileRef, right: FileRef, wait?}` (left = before) carries opaque host-authorized refs. The renderer reads them with `fs.readRef` and shows them read-only in the Code-OSS diff editor. Compare documents are not restored by sessions.

### Preferences
`Appearance = 'system' | 'light' | 'dark' | 'light-contrast' | 'dark-contrast'`. Legacy `paper`/`ink`/`*-contrast` map through `normalizeAppearance` (own-property lookup only). The settings surface is exactly `Preferences`.

### Session
`RendererSession` in `contract.ts` is structurally identical to `desktop/shared/session.ts`; keep them in lockstep (an assignability check in the host protocol is recommended). It stores:

- selection, user order and pins;
- tree/flat layout, collapsed rows and the active tab;
- documents (file/diff/commit/settings with cursor), active and split documents;
- focus mode and the current plane;
- index scroll and expanded directories per repository;
- commit drafts.

It never stores source text; that lives only in recovery drafts.

## Changelog

- **v4:** `session.get`/`session.save`; Signal appearance ids with `normalizeAppearance`; `window.ready`; `workspace.willClose`/`closeReady`; `git.cancel`; `fs.removeBackup`; `fs.list`/`fs.findPaths` completeness.
- **v3:** `WriteBasis` on `git.prepare`; `reviewId` on `git.diff`; `compare` event and `fs.readRef`; restricted mode allows passive reads.
- **v2:** backend-owned hunks (`git.hunks`/`git.applyHunks`, removed `git.applyPatch`); no save force flag; encoding/BOM round-trip; workspace open/recent/close/trust; branch, stash, discard, remote targets; file operations, backups, recovery; settings.
- **v1:** initial.
