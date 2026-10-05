# Develop Minv

Minv currently boots as an isolated development extension in a Code-OSS-compatible desktop host. This implements the prototype route in PRD section 11.1. It is not yet the stripped, distributable Minv fork.

Requirements: Node.js 22+, npm, Git 2.48 or newer, and an installed Code-OSS-compatible executable. The pinned upstream fork requires Node.js 24.18.0.

```sh
npm ci
npm test
npm start -- /absolute/path/to/workspace
```

The launcher uses `code` by default. Set `MINV_CODE_EXECUTABLE` to a Code-OSS executable to choose another host. It isolates application data and installed extensions under `.minv-dev/`, disables the legacy Git extension, and configures the development profile with telemetry, automatic extension updates, and automatic fetch off. It does not alter your ordinary editor profile. Upstream host functionality is still present; Minv-owned code does not embed an agent or provider service.

The isolated launch profile defaults to the Minv Ink theme; Minv Paper is available through the color-theme picker. An empty editor opens Minv’s home page, also available as `Minv: Show Home`. Existing profile choices are preserved.

Open the Minv activity-bar icon for repositories. Select a row for its changes. Use the native editor's Files and Search views for browsing, editing, and searching. Change/diff inspection and Git writes require workspace trust; staging and committing open a review document and require confirmation. Git's configured hooks, filters, and signing are respected for trusted writes. Commit drafts survive cancellation and failure. Restricted workspaces expose branch metadata only: the prototype does not yet provide the PRD’s sandboxed passive content-inspection guarantee. Repository-config changes can race helper neutralization, which remains a release blocker.

Useful command-palette actions: `Minv: Select Repository`, `Minv: Refresh Selected Repository`, `Minv: Refresh All Repositories`, `Minv: Show Repository History`, and `Minv: Show Diagnostics`.

## Validation

`npm run test:host` boots a disposable editor profile, verifies activation, the repository view, refresh, text editing, and saving, and requires a result written by the test inside the host. This passed on the installed Code 1.135.0 Linux host.

`npm test` compiles the extension and runs core Git, catalog, write-freshness, controller race, and fixture tests in temporary repositories. Host smoke testing lives in `test/host/smoke.ts` and is run with the editor's `--extensionTestsPath` argument against a disposable workspace, never a user's repository.

See [ACCEPTANCE.md](ACCEPTANCE.md) for release gates, [FORK.md](FORK.md) for the reproducible upstream preparation and exclusion audit, and [BENCHMARKS.md](BENCHMARKS.md) for measurement scope and fixture generation. Unimplemented release requirements remain explicit there.
