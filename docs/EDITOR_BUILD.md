# Source-built Minv editor

The focused desktop embeds the retained Code-OSS editor inside Minv's own Electron interface. It never loads the stock workbench, extension host, bundled Copilot, or an npm `monaco-editor` distribution. The editor is compiled from the exact source revision in `product/upstream.json` with the contribution allowlist in `product/editor-scope.json`.

Build after normal project dependency installation and `node scripts/upstream-fetch.mjs`:

```sh
node scripts/editor-build.mjs
node scripts/editor-audit.mjs
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron scripts/editor-smoke.mjs
```

Output is `desktop/editor/generated/`. The last command uses the installed Electron executable on the Linux reference environment; on a headless runner prepend an installed `xvfb-run -a`. No temporary package runner is used. Build, closure audit, and sandboxed Electron runtime smoke have all passed against the pinned revision.

## Renderer integration contract

Load `../editor/generated/editor.css` once and import `../editor/generated/editor.js` as a local ES module (adjust relative paths for the renderer's output directory). The module exports:

- `editor`: `create`, `createDiffEditor`, `createModel`, `getModel`, `getModels`, `getEditors`, `getDiffEditors`, `setModelLanguage`, `defineTheme`, `setTheme`, `remeasureFonts`, `tokenize`.
- `languages`: syntax-only registration/configuration and tokenization APIs. There are no public completion, refactoring, language-server, execution, or extension-install APIs.
- `Uri`, `Range`, `Selection`, `Position`, `KeyCode`, `KeyMod`.
- `initializeLanguages(): Promise<void>`: call once to register local upstream language configurations and TextMate grammars using local Oniguruma WASM. Individual grammars load lazily when their language is used.

`editor.create(container, options)` and `editor.createDiffEditor(container, options)` use the familiar standalone Code-OSS editor contracts. Models belong to the application: retain them per file/tab, track their dirty state, and dispose them explicitly. Use independent URIs for diff sides. The shell owns disk reads, encoding, conflict-safe writes, trust, backup, file limits, and tab lifecycle. No editor call writes a file or executes a workspace command.

The module sets `MonacoEnvironment.getWorker` to create only `editor.worker.js` relative to itself. Keep worker, CSS, font assets, `syntax/`, and `onig.wasm` next to the built module. Serve via a secure local Electron protocol supporting fetch and module workers, or an equivalent same-origin local development server. Do not expose a network asset fallback. Content Security Policy needs local scripts/styles/fonts/worker/WASM support; Chromium's WASM compilation may require `script-src 'wasm-unsafe-eval'`. This is not permission for general JavaScript eval.

The renderer should define Minv light/dark themes via `editor.defineTheme` and use the design contract's colors, typography, padding, and scrollbar sizes. Syntax token types retain upstream TextMate scopes: include theme rules for broad `storage`, `constant`, `entity`, `variable`, `keyword`, `string`, and `comment` scopes. Editor contribution selection preserves practical text operations, explicit undo/redo, multicursor, folding, find/replace, comments, indentation, Unicode handling, and text diffs. It excludes suggestion and inline-completion contributions. Disabling settings alone is not the removal mechanism.

## Provenance and exclusions

The build verifies the upstream Git commit and refuses tracked modifications. Source-hashed transforms remove the standalone inline-completion singleton, next-edit command tracking, the observable developer-debugger transport, and external diff loading. External diff algorithm options explicitly throw; the default `advanced` and legacy algorithms remain source-built and local. Original source files stay unchanged. The generated provenance records source hashes, transforms, contribution entrypoints, and local syntax inputs; the esbuild metafile records actual compiled inputs/outputs. Build-time resolution rejects workbench, server, agents/MCP/debug/terminal/remote/provider and excluded editor contributions. `product/editor-inputs.json` is the exact reviewed 820-input closure; new inputs make the audit fail until reviewed.

The resulting editor module is approximately 3.2 MiB, the worker 316 KiB, CSS 109 KiB, and the codicon font 149 KiB (uncompressed). The syntax bundle registers 69 languages plus plaintext, using 81 upstream grammar files. Individual grammar assets are fetched only from the local application origin. The renderer and worker have no external import in their emitted module graph.

Three inert upstream adapters remain: telemetry uses `TelemetryLevel.NONE` and empty logging methods; the default account implementation returns null accounts and cannot sign in; the standalone tree-sitter adapter reports no supported language. They are compatibility contracts, not functional providers or background services. Account/provider, telemetry transport, and tree-sitter downloads are absent. Standalone workspace-trust values concern only the in-memory editor; the Electron shell must enforce actual disk/Git trust at every IPC boundary.

`generated/audit.json` reports source and emitted-input counts, excluded input findings, external import findings, source-policy hashes, and `compiledOutputHashes` for all 149 built assets. `generated/provenance.json` contains original-source hashes and transformation hashes. Packaging must verify its copied assets against these digests, retain the notices and reports, and run separate desktop/package gates. Generated output is disposable; never edit bundles to fix source behavior.

`generated/smoke.json` records the sandboxed Electron runtime test: editing and undo, TypeScript syntax plus 11 additional language grammars, a real local worker producing text-diff changes, no excluded editor actions, and no failed or remote network requests. It also checks shared split-view models, comparison isolation, model disposal, large-file plaintext mode, native go-to-line availability, and mixed CRLF/LF/CR preservation through grouped undo/redo. The test uses a dedicated secure local protocol and `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. This verifies the focused editor, not arbitrary project execution or full product acceptance.

## Trusted renderer bootstrap

`desktop/preload/bootstrap.ts` is a renderer entrypoint, distinct from the context-isolated Electron IPC preload. It compiles to the package's root `bootstrap.js`, loads only `./editor/editor.js`, initializes local syntax assets, installs a non-writable `window.minvEditor`, and loads `./renderer/dist/main.js`. The visual renderer receives the `EditorAdapter` contract; it does not receive unrestricted internal services. Bootstrap failures are visible and announced, never replaced with a mock editor.

`desktop/preload/editor-adapter.ts` follows the renderer's visual options. Regular views share reference-counted models by document URI, so opening a split cannot dispose or replace another view's dirty buffer. Comparisons use separate models even when their source document URIs match. Options and theme changes apply to both regular and comparison editors. Large-file views use plaintext, disable wrapping/folding/tokenization-dependent decoration, and continue to use the backend's independent hard-size boundary.

Code-OSS normalizes model line endings internally. The adapter mirrors edits and undo versions against the original raw text so untouched CRLF/LF/CR sequences survive saving, including mixed-EOL documents. A mismatch blocks `getText()` instead of silently exporting normalized or inconsistent contents. Explicit clean reload resets this journal while preserving the views' positions. The host still owns encoding, BOM, disk-version checks, trust and recovery; editor state never authorizes a disk write.

Source licenses and third-party notices are copied into `generated/notices/`. Codicons, TextMate and Oniguruma are separately pinned normal npm dependencies; none provides the editor implementation. TextMate receives only bundled declarative grammars, not extension JavaScript. No language server runs.

This editor closure is distinct from the earlier stock-workbench removal experiment documented in `FORK.md`. That experiment's transitive dependency blockers do not become dependencies of this new entrypoint. Complete product acceptance still requires desktop integration and runtime/security/performance validation.
