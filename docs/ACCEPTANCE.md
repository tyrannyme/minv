# Implementation acceptance

The initial implementation follows the isolated-extension option in PRD §11.1. It is development evidence for Minv, not a supported desktop release. Running the extension inside an existing editor does not remove that editor's excluded services. The fork must independently pass its removal, packaging, and runtime gates.

This checklist separates automated component evidence from user-visible and shipping evidence. A passing unit test does not imply that an entire PRD acceptance scenario passes. Pending gates remain release blockers; the PRD budgets have not been relaxed.

## Component checks

Run `npm run check` and `npm test` from the project directory. Tests use disposable repositories and must not change user Git configuration. The exact command results and remaining implementation limitations are recorded below after integration.

Independent integration review on October 5, 2026 ran `npm run check` and `npm test`: TypeScript compilation and all 43 then-current tests passed. This included five controller acceptance regressions, nine Git-runner tests, real repository/catalog/write fixtures, webview message checks, and the smoke benchmark fixture. Host boot, browser interaction and source-fork audit evidence are separate; these tests do not pass the full release matrix.

| Area | Required evidence | Initial status |
|---|---|---|
| Git process safety | Argument arrays; bounded output, concurrency and timeouts; isolated metadata capacity; no implicit remote access, hooks, fsmonitor, external diff or text conversion on passive reads; safe-directory protection preserved | Scheduler, bounds, cancellation, environment isolation and static malicious-helper fixtures implemented; confirmed configuration race remains a security blocker below |
| Catalog | Stable checkout identities/order, declared nested submodules, missing checkouts, gitfiles, worktrees, corrupt cache recovery and no unrestricted directory crawl | Implemented; real temporary-repository tests cover these paths, including unsafe declarations and escaping symlinks |
| Branch | Symbolic, detached and unborn HEAD; independent of working-tree status; failures scoped to one checkout | Implemented; tests cover branch states, nonzero errors and metadata publication before index discovery completes |
| Changes | Porcelain parsing, unusual paths, staged/unstaged distinctions, child dirtiness versus parent gitlink, complete untracked scope | Implemented and covered by real Git fixtures; passive parent scans deliberately exclude child dirtiness, which belongs to each child row; layered aggregate release presentation remains pending |
| Writes | Trusted explicit actions, repository/path boundaries, HEAD/index/content preconditions, shared-resource serialization, failure preservation | File stage/unstage/commit implemented with review confirmation; tests cover stale content/index/branch/child HEAD, concurrent writes, symlinks, nested checkout boundaries, literal paths and hook failure |
| User interface | Truthful freshness, generations, stable row geometry, keyboard interaction, scoped diffs/actions and recovery from monitoring failures | Controller tests pass for stale-response suppression, unavailable-checkout recovery, cached branch progress and missing-row position preservation; packaged accessibility and churn tests pending |
| Fork preparation | Pinned upstream, explicit product identity, contribution allowlist/removal manifest and refusal to call a prepared source tree a release | Source preparation and conservative audit implemented; release audit deliberately blocks; desktop compilation/removal proof pending (see FORK.md) |
| Performance harness | Reproducible fixtures, machine/Git metadata, clearly separated core timings and end-to-end paint timings | Generators and core harness implemented; release-scale and end-to-end measurements pending (see BENCHMARKS.md) |

## PRD release gates

| Gate | Initial extension evidence to collect | Remaining release evidence |
|---|---|---|
| AT-01 Original pain point | Metadata request progresses during blocked status; cached rows retain identity | R64 warm launch-to-painted-branch budgets, row geometry, 30-run distributions |
| AT-02 Fresh catalog | Declared nested and missing submodules discover without source crawl | First-open full R64 budget, including declarations/index disagreement |
| AT-03 Cache truthfulness | Cached values start unverified; refresh adopts external branch switch | Close/reopen UI scenario and stale response ordering |
| AT-04 Slow/broken sibling | Scheduler isolation and scoped repository errors | Responsive editor/navigation while sibling status hangs |
| AT-05 Submodule semantics | Differential Git fixtures for dirty child, changed HEAD and staged gitlink | Nested aggregate presentation and independent child/parent write journeys |
| AT-06 External churn | Coalesced invalidation, bounded queues and generation checks | 1,000 changes/second for 30 seconds; input/refresh budgets |
| AT-07 Dirty-buffer race | Host editor behavior must be checked explicitly | Reconciliation, crash recovery and save conflict tests in the stripped fork |
| AT-08 Git-operation race | Reject changed HEAD/index/selected content; preserve failure drafts | Hunk-level races, concurrent external Git and uncertain completion recovery |
| AT-09 Watch failure | Downgrade observations and offer refresh when monitoring fails | Event-loss, overflow, resource exhaustion and reconnect injection |
| AT-10 Path/storage edges | Unicode, spaces, leading dashes, gitfiles, worktrees and boundary checks | Symlink cycles, external Git directories, supported sparse/ref/object formats |
| AT-11 Removal audit | Minv-owned code excludes AI, debug, terminal and provider integrations | Built dependency graph, service/command/worker audit and packaged-runtime network trace |
| AT-12 Offline/untrusted | Passive-command malicious-helper fixtures; restricted-mode write rejection | Offline partial-clone tests and full untrusted packaged-runtime execution trace |
| AT-13 Git failures | Missing Git, nonzero exits, timeouts, lock failures, no automatic retries | Minimum Git detection, authentication/signing/hooks and cancellation uncertainty |
| AT-14 Accessibility | Semantic controls, keyboard handlers, status text independent of color | Keyboard and screen-reader completion of lookup, diff, stage and commit; high contrast |
| AT-15 Coexistence | Isolated launcher profile and distinct intended product identifiers | Installed fork beside VS Code, CLI reuse, no settings/extension migration |
| AT-16 Scale/recovery | Corrupt catalog recovery, bounded Git output and fixture harness | Full R256/LARGE1, process memory/idle CPU, crash recovery and heavy-file behavior |

Every row remains pending as a complete release gate until all listed evidence is recorded for a supported platform. Linux is the implementation reference, not yet a supported release claim. Windows and macOS require separate gates.

## Security gate requiring follow-up

The current passive Git runner disables known filters by enumerating configuration in one process and overriding each filter in a subsequent content process. This is not an execution sandbox. A review fixture demonstrated that adding a new `filter.<name>.clean` definition between those processes lets a same-length tracked-file edit trigger that helper during `status`. The fixture used an existing tracked attribute referencing the driver, changed its configuration between processes, and observed the helper's marker file. Static malicious-helper tests alone do not cover this configuration race.

SEC-03 and AT-12 therefore remain blocked until a stable safe configuration view, execution confinement, or another proven mitigation covers the complete passive command path. The prototype restricts untrusted workspaces to catalog and branch metadata; status, diffs and history require workspace trust. A controller regression verifies that restricted mode spawns no status command, still resolves the branch, and recovers content after trust changes. The configuration race also remains a release gap for passive inspection of trusted workspaces; trust does not make it a completed security gate.

## Functional scope still requiring explicit verification

P0 includes more than the initial repository browser: hunk staging, branch and stash operations, safe discard, explicit generic remotes, commit detail/file history, existing-operation conflict support, terminal handoff, all CLI modes, user ordering/pins/tree view, monitoring recovery, and diagnostics. Any unavailable operation must remain visibly unavailable; inherited editor commands cannot be counted as a reviewed Minv implementation.

The first supported release also needs a supported Git/version/format matrix, reference hardware, dependency notices, update authenticity and rollback, upstream security maintenance, and name clearance. Benchmark output from the Node core is not evidence for launch, paint, accessibility, or total application memory budgets.
