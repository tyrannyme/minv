# Code-OSS fork preparation

**Current implementation route:** the focused desktop now builds the retained Code-OSS editor directly from the same pinned source, inside Minv's own Electron shell. Its actual compiled graph excludes the stock workbench and its coupled services. See [EDITOR_BUILD.md](EDITOR_BUILD.md) for the successful build, exact closure allowlist, provenance, and sandboxed runtime test. The stock-workbench preparation below remains a documented earlier feasibility experiment; its blockers do not describe the new editor-only entrypoint.

The runnable Minv repository browser is an isolated extension prototype under PRD §11.1. The code here separately prepares and audits a real Code-OSS source fork. It does **not** yet produce a stripped desktop executable, and neither prototype is a supported Minv release.

## Reproduce the source preparation

Run from the Minv project with Node and Git installed; preparation also requires `tar`:

```sh
node scripts/upstream-fetch.mjs
node scripts/prepare-upstream.mjs
node scripts/upstream-audit.mjs
```

`product/upstream.json` pins Microsoft's official source tag `1.137.0` to `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`. Its `.nvmrc` requires Node `24.18.0` for upstream builds. This is a removal-feasibility reference, not a claim that its dependencies are security-reviewed or supported. Check upstream security changes before selecting a release base.

The fetch script obtains the exact commit into `.upstream/vscode`. It refuses a different HEAD or tracked local modifications. Preparation exports the pinned Git tree, never copies uncommitted upstream changes, and writes `.upstream/minv-source`. Both directories are disposable and ignored by the parent project. No extension marketplace, package runner, npm installation, Electron download, or build is invoked by these commands.

To regenerate an existing **script-owned** prepared directory:

```sh
node scripts/prepare-upstream.mjs --reset
```

This discards edits inside that generated directory; keep intended changes as reviewed patches. Preparation refuses to overwrite an unmarked directory. An interrupted fetch may require manually removing its incomplete checkout before retrying; it never resets an existing checkout automatically.

## What preparation actually changes

`product/contributions.json` pins the source hashes and explicitly lists retained and removed side-effect imports for both desktop workbench entrypoints. Preparation removes registration imports, rather than toggling their settings. A changed upstream source fails closed until its allowlist is reviewed. It currently removes 128 direct imports covering chat/agents/MCP, debugging, tasks/testing/notebooks, integrated terminals, provider/authentication, sync, remote, recommendations, and other excluded contributions.

`product/extensions.json` keeps 61 explicitly listed language grammar and theme packages. Their manifests retain only languages, grammars, themes, icon themes, and product icon themes. Executable `main`/`browser` entrypoints, activation events, executable dependencies, commands, debug/task contributions, configuration defaults, and other contribution keys are removed. Executable source/output/build folders are deleted from retained packages. All other extension directories are physically deleted, including Copilot, built-in Git, GitHub/authentication, language servers, debuggers, notebook renderers, and terminal extensions. Minv's audited repository implementation replaces upstream Git; it is not yet copied into the prepared shell automatically. Git commit/ignore and search-result grammars are retained as declarative assets from formerly executable extensions.

`patches/inventory.json` records the patch order and generated transformations. The patch removes residual explicit MCP singleton registrations, gives the main IPC channel and lock file Minv identities, disables the unimplemented updater, and narrows npm installation directories. Preparation also removes Copilot/agent-host build scripts and removes the implicit Copilot step from `compile` and `watch`. This is an initial build-system change, not a completed dependency prune.

The complete replacement `product/product.json` sets the executable/URI identity to `minv`, application data to `.minv`, shared data to `.minv-shared`, Linux icon identity to `minv`, separate Windows identifiers, and macOS bundle identity `sh.kaf.minv`. The main process uses a `minv-main` IPC discriminator and `minv.lock`; its directory is independently derived from Minv's product data path. The development extension launcher uses its own isolated directories and does not install this product identity.

There is no configured update feed, telemetry enablement, marketplace, default chat agent, provider entitlement endpoint, webview CDN, or external built-in extension download in the replacement product. `quality` is `minv-internal`. Updates are disabled in source until a separately authenticated explicit update mechanism exists. Server/tunnel names are distinct defensive placeholders; these capabilities are excluded and still require process-level removal. Platform installer IDs and branding assets require packaging validation before distribution.

Upstream license files and notices remain in the exported source. Keep those notices and independently review dependencies and retained grammar/theme assets before shipping. This work never uses Microsoft's branded binary or Marketplace as the fork base.

## The release gate intentionally fails

```sh
node scripts/upstream-audit.mjs --release
```

This returns exit status 1. Normal audit returns 0 only for successful **preparation checks**, never release readiness. The report at `.upstream/minv-source/.minv-audit.json` always carries `releaseReady: false` at this milestone.

The audit validates the exact product identity, both direct-import allowlists, and every retained extension manifest. It then traverses literal source imports from the desktop renderer, Electron entrypoint, main process, shared process, and extension host. On the pinned source, after preparation, it visits 3,539 files and identifies 1,195 files under excluded source areas. This is a conservative source graph: it can include type-only imports and misses computed dynamic imports and package internals. Counts are not a runtime activation measurement or a compiled bundler proof.

Concrete blockers observed in the actual source include:

| Retained source | Coupling requiring a reviewed replacement |
| --- | --- |
| `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts` | Registers agent-host and MCP management services independently of the workbench entrypoints. |
| `src/vs/code/electron-main/app.ts` | Imports terminal/debug and other excluded infrastructure. |
| `src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts` | Imports chat entitlement behavior; extension-host infrastructure must be restricted to audited bundles. |
| `src/vs/workbench/contrib/search/browser/searchView.ts` | Imports notebook editor/services. Text search needs the notebook dependency removed while preserving ordinary results. |
| `src/vs/workbench/api/browser/viewsExtensionPoint.ts` and extension-host API modules | Couple generic extension views/APIs to debug, tasks, terminal, chat, and notebook services. |
| `src/vs/workbench/contrib/externalTerminal/electron-browser/externalTerminal.contribution.ts` | External handoff still references integrated-terminal context code. |

Deleting these source directories immediately would leave broken imports and service instantiation. Remaining sources are deliberately visible in the report; they have not been called “removed” merely because their views are absent. Minimal inert compatibility adapters may be justified by PRD §11.1, but they must be explicitly reviewed and unable to restore functional excluded capabilities.

Before AT-11 can pass, complete source graph and dependency removal, restrict extension scanning/installation and CLI/API loading to audited bundles, and remove main/shared-process services. Then compile and launch the desktop, inspect commands/menus/service registrations/workers, test attempted feature restoration, and record network activity with an opened workspace. Packaging must exclude executable remnants, forbidden dependencies, alternate browser/server/agent entrypoints, and remote assets. Static preparation checks do not replace those gates.

Full upstream dependency installation, native compilation, Electron packaging, runtime service-instantiation checks, and platform/network audits have **not** been performed. The prepared tree is expected to need compatibility work before it can run. No M1 stripped-shell completion, AT-11 completion, or supported operating system is claimed.

## Updating the base

Choose and independently inspect an immutable upstream revision; update `product/upstream.json`, review every changed entrypoint and extension against the PRD, refresh exact source hashes/import lists, and rebase the patch inventory. Regenerate the tree and review the full audit diff. New upstream functionality stays excluded until deliberately accepted. Dependency lockfiles in the prepared source remain upstream's inventory; their packages are not yet evidence of a pruned shipping dependency set.

Primary sources: [pinned Code-OSS source](https://github.com/microsoft/vscode/tree/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c), [pinned upstream license](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/LICENSE.txt), [desktop entrypoint](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/workbench/workbench.desktop.main.ts), and [shared-process entrypoint](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts).
