# Minv completion ledger

Source of truth: [MINV_PRD.md](../MINV_PRD.md). This ledger tracks the supported Linux x64 desktop target. The existing Code-OSS extension is component evidence, not proof that the new desktop passes a requirement. Source and tests must be rechecked after integration.

Status vocabulary: **unstarted** means no applicable implementation or execution evidence; **partial** means some relevant implementation or component evidence exists but listed work remains; **verified** means the complete stated requirement has passed on the named target with linked reproducible evidence. A test name alone is not a passed test run. No percentage is inferred from row counts. No complete desktop release gate is verified in this initial ledger.

## Functional P0 requirements

| Requirement | Status | Existing evidence | Specific remaining work |
|---|---|---|---|
| WS-01 Open/restore | partial | Extension uses host folders/editor; controller restores selected checkout and cached catalog | Desktop non-Git folders, multi-root sessions, tabs/order/expanded directories/scroll recovery; missing Git must not block files or editor |
| WS-02 Independent catalog | partial | `src/core/catalog.ts`, `src/controller.ts`; cached metadata, retained missing rows; `test/acceptance.test.ts` | Wire desktop cache publication before scans and prove painted cached/unverified state; asynchronous validation and restart test |
| WS-03 Bounded discovery | partial | Declared and index-only nested checkout tests in `test/catalog.test.ts`; bounded root/depth/count | Explicit registration or bounded standalone discovery; user-invoked deeper scan with progress/cancel; expose declaration/index discrepancies |
| WS-04 Incomplete checkouts | partial | Tests cover absent, uninitialized, malformed declarations and broken siblings | Desktop missing/inaccessible presentation, recovery and no-auto-initialization runtime test |
| WS-05 Checkout identity | partial | Catalog tests cover gitfiles, separate Git dirs, linked worktrees and branch-independent identities | Desktop duplicate-name/path cases and supported-format matrix; preserve distinct tabs/indexes for linked worktrees |
| REPO-01 Stable browser | partial | Extension virtualized/filterable fixed-height list and message validation | Desktop flat/tree modes, collapse persistence, user order and pins; measured zero displacement under updates |
| REPO-02 Accurate metadata | partial | Real Git named/detached/unborn/error tests; independent metadata queue | Desktop correctly labeled and timed painted values; no `.gitmodules` tracking-branch substitution |
| REPO-03 Interactive priority | partial | Reserved metadata capacity; cached selected-first/controller progress tests | Desktop search/direct-path promotion of queued metadata; selected latency while discovery/content slots busy |
| REPO-04 Selection integrity | partial | Extension actions retain repo/path and commits retain initial repository | Desktop tab/diff/form ownership, duplicate basenames, selection changes during reviews/writes; IPC token scope tests |
| REPO-05 Stable incomplete results | partial | Discovery streams rows; cached missing row positions retained | Desktop discovery-progress scope in search; visual anchor during streamed first-open batches |
| FILE-01 Lazy explorer | partial | WorkspaceFiles lazy listing and FileService scoped list/completeness; component tests | Verify renderer expansion, independent browse/search/Git ignore settings and no status dependency |
| FILE-02 Search | partial | WorkspaceSearch bounded/cancellable rg with pinned Linux cwd, scope ownership and completeness; FileService adapter tests | Verify renderer literal/regex/path search and first-result latency; cancellation and incomplete results visible |
| FILE-03 File operations | partial | WorkspaceFiles create/transfer/recoverable deletion; cross-repo topology/replay and symlink regressions | End-to-end desktop actions, overwrite decisions, missing/unsupported directory actions, native reveal and final filesystem-race policy |
| EDIT-01 Practical editing | partial | Host smoke verifies edit/save; themes exist | Source-built editor integration and syntax/folding/multicursor/splits/find/replace/undo tests; explicit saves, encoding/EOL round trips |
| EDIT-02 External edits | partial | Files/FileService guard disk fingerprint and retain backup/draft; change notifications preserve save base in adapter test | Renderer clean/dirty reconciliation, view/undo preservation and recovery after crash; end-to-end no-loss journeys |
| EDIT-03 Heavy files | partial | Git output bounds reject incomplete results | Desktop text/binary size thresholds, metadata/handoff UI and reduced-tokenization mode; no editable truncation or freeze |
| GIT-01 Independent layers | partial | Branch/status generations; porcelain staged/working/conflict/untracked parser | Desktop independent publication, ignored-by-policy and unavailable states; counts clearly scoped and incomplete when needed |
| GIT-02 Submodule semantics | partial | Real gitlink pointer and child HEAD tests; child dirtiness intentionally separate from passive parent scan | Desktop separately labeled child-derived aggregation, staged parent pointer versus index/child HEAD, nested differential fixtures |
| GIT-03 Progressive status | partial | Selected refresh; fair bounded subprocess queue; explicit refresh-all | Desktop visible-first then background convergence; unknown scopes cannot appear globally clean; untracked completeness during scans |
| GIT-04 Diff review | partial | Text patches, tracked/untracked, staged/working, rename/symlink/gitlink tests | Desktop side-by-side and inline revision diffs; owner and side labels; whitespace display filter; explicit binary/mode/rename/gitlink views |
| GIT-05 Local history | partial | Bounded 50-entry core history and extension commit patches | Desktop paging/file-change details and revision opening; missing partial-clone objects remain unavailable without user fetch |
| WRITE-01 Scoped operations | partial | File stage/unstage/commit and explicit review in extension | Hunk stage/unstage; branch create/switch; stash create/apply/drop; recoverable discard/restore; one-repo desktop UI and confirmations |
| WRITE-02 Commit integrity | partial | Fresh staged patch/branch review; persisted drafts; hook-failure tests | Desktop exact staged snapshot binding, drafts across errors/restart, signing success/failure, no implicit stage-all |
| WRITE-03 Freshness/concurrency | partial | HEAD/index/content/child-HEAD guards, serialized writes; independent GitService tests bind displayed status/diff before prepare and reject stale/wrong-scope/filter reviews | Verify workspace publication records the same displayed status generation; renderer retained review identity; process-crash/uncertain-outcome reconciliation |
| WRITE-04 Destructive policy | partial | No force push/hard reset/clean offered; Git lock behavior retained | Scoped desktop discard with current-state checks and protected recovery; immutable review intent; reject unsupported destructive IPC operations |
| WRITE-05 Parent pointers | partial | Separate child/parent writes and pointer freshness test | Warn that child commits' remote availability is unknown unless established; desktop independent actions and no silent parent staging |
| REMOTE-01 Generic remotes | partial | Core explicit fetch/push/fast-forward-only pull and GitService backend destination native confirmation; local-bare remote tests | Renderer scope and last-fetch display, credential handoff, actual network/error/cancel journey; packaged zero-open-time-network audit |
| REMOTE-02 Failure/cancel | partial | Read cancel and uncertain write timeout; no blind retries | Explicit-network auth/cancel tests, credential redaction and completion reconciliation for remote writes |
| CONFLICT-01 Existing operations | partial | Branch operation markers; conflict porcelain parser | Desktop manual text/three-way conflicts and explicit resolved-path staging; label unsupported continuation/handoff |
| EXT-01 CLI/handoff | partial | Isolated extension launcher accepts host arguments | Native `minv` open/reuse/goto/diff/repo/wait parsing, external-terminal action and duplicate-observer prevention |
| EXT-02 No agent dependency | partial | Minv-owned extension/core contain no agent/provider runtime | Audit actual desktop bundles/processes/IPC: no AI/MCP/agent sessions, no remote execution services, generic filesystem/CLI integration only |
| SET-01 Settings | partial | Themes and machine Git path; isolated prototype profile | Desktop appearance/keybindings/roots/ignore/Git/credentials-hooks/performance/external-terminal controls; allowlisted explicit preference import |
| OBS-01 Diagnostics | partial | Core benchmark output, extension state/watch diagnostics | Local discovery/queue/run/process/watch/renderer timings; on-demand view and redacted export, no background telemetry |

## Security requirements

| Requirement | Status | Evidence | Specific remaining work |
|---|---|---|---|
| SEC-01 Local-first | partial | Passive environment denies transports/lazy fetch; prototype no app network calls | Packaged desktop open/browse/edit/status/history with blocked networking, no telemetry/assets/experiments/update checks; explicit exceptions only |
| SEC-02 Workspace trust | partial | Passive desktop Git confinement; GitService/FileService trust checks and trust-revocation-during-confirmation tests | Verify trusted-root persistence, all main actions/lifetime transitions and full untrusted desktop inspection |
| SEC-03 Passive execution | partial | Linux Landlock/seccomp launcher replaced filter inventory; `test/release-sandbox.test.ts` verifies late-added filters, secondary exec/socketpair denial and inode metadata mutation denial | Complete partial-clone and packaged-runtime offline/process-tree audit; verify supported kernel failure mode, timeout cleanup and every passive operation. Original configuration race no longer depends on a mutable filter inventory |
| SEC-04 Safe invocation | partial | Argument arrays/literal pathspecs; `test/release-files.test.ts` verifies ancestor-symlink open escape refusal and transfer topology/replay; `test/release-protocol.test.ts` verifies sender/schema/ticket boundaries | Main service authorized roots, native confirmation and review binding across all operations; option/revision injection and new file mutation race tests |
| SEC-05 Sensitive data | partial | Private recovery directory/blob tests; bounded recovery storage refuses new writes at limit without evicting dirty drafts; Git uses existing credentials | Packaged diagnostics and credential redaction audit; renderer explicit clearing/limit errors and recovery separation |
| SEC-06 Updates/supply chain | partial | Pinned upstream/source notices; updater absent | Dependency inventory and notices, authenticated explicit update verification, dirty-state guards and rollback tests; documented independent upstream security refresh process |

## Architecture and product boundaries

| Requirement | Status | Evidence | Specific remaining work |
|---|---|---|---|
| §4 Rule 1: branch independent of scans | partial | Core/controller scheduling regressions | Desktop request-to-paint and startup tests under slow full status/discovery |
| §4 Rule 2: unknown never looks clean | partial | Observation states and stale-generation tests | All desktop views, count summaries, errors and monitoring degradation use truthful scope/freshness |
| §4 Rule 3: stable targets | partial | Fixed-height extension list and retained catalog rows | New renderer anchor/focus/scroll geometry tests during discovery and churn |
| §4 Rule 4: no automatic network/config changes | partial | Passive transport controls; no auto-init | Desktop network capture plus repository/config byte comparisons on open/refresh |
| §4 Rule 5: preserve other tools' work | partial | Guarded file Git writes | Desktop dirty-buffer, file operations and all new Git operations tested against concurrent changes |
| §4 Rule 6: narrow budgeted scope | partial | PRD disposition table and prototype runtime | Actual source-built shipping graph and measured process/resource budget |
| §6 Excluded functionality | partial | Source preparation removes direct imports/extension folders; audit intentionally fails | Shipping graph excludes AI, debug/tasks/testing/notebook execution, providers/accounts, language servers, terminal, arbitrary extensions, remote workspaces and sync—not merely hidden UI |
| §9 Interaction/accessibility | partial | Extension keyboard/listbox semantics, scoped controls, themes | Desktop rail/editor/details layout, keyboard full journeys, screen-reader announcements, high contrast, reduced motion, narrow layouts and color-independent state |
| §9 Freshness vocabulary | partial | Typed unknown/cached/refreshing/observed/stale/error states | Desktop shows scope/time/errors and partial/changing observations; paused/broken workers do not leave clean badges |
| §11.1 Code-OSS source foundation | partial | Immutable upstream pin and preparation scripts | Build selected editor sources and document provenance/allowlist; prove desktop build includes required file/editor/security/accessibility/diff behavior |
| §11.1 Shipping removal | partial | `upstream-audit --release` intentionally blocks prepared full shell | Audit actual desktop dependency graph, services, commands, workers and bundled executable remnants; document any inert adapters |
| §11.1 One authoritative Git service | partial | Prototype disables upstream Git | Native desktop owns one catalog/scheduler/watch service; repeated CLI calls and multiple UI panels do not duplicate scans |
| §11.2 Boundaries/off-renderer work | partial | Core has no vscode imports; subprocess worker queue | Main/preload/renderer typed API; bounded file/Git work off renderer; explicit service ownership and no arbitrary process/file bridge |
| §11.3 Scheduling | partial | Metadata reserve, content cap, coalescing, fairness, serialized common-dir writes | Desktop interactive priority/cancel integration; bounded maintenance/recovery queue and no write cancellation on selection change |
| §11.4 Git compatibility/observation | partial | Git 2.48 minimum, tested 2.55; Git-resolved dirs; no optional read locks | Supported-version/format tests; filtered content policy and explicit child aggregation proven equivalent for declared scope; no config rewrites |
| §11.5 Cache/consistency | partial | Versioned atomic catalog, per-field generations, watcher/focus invalidation | Desktop shared watch topology, stale on overflow/reconnect, bounded fallback and recovery storage separate from cache; changing-state UI under churn |
| §11.6 Linked-worktree boundary | partial | Independent linked-checkout tests and common-dir write locks | Desktop simultaneous views/ref events; keep submodule-bearing worktree lifecycle management outside v1 |
| §13 Product identity | partial | Distinct product/executable/data/URI/IPC IDs prepared | Actual packaged Minv identities, icon/desktop entry/CLI registrations and side-by-side install tests; no VS Code profile overwrite |
| §13 Licensing/dependencies | partial | Upstream license retained; project license | Generated dependency inventory, audited bundled editor/grammar/theme notices and no Marketplace dependency |
| §13 Compatibility matrix | partial | Linux Git fixtures for ordinary/submodule/worktree/path edges | Explicit OS/Git/storage support plus sparse/shallow/partial clones, supported ref/object formats, long/non-ASCII/symlink/external Git paths; safe unsupported-mode errors |
| §13 Upstream maintenance | partial | Pin, import manifests and patch inventory | Rebuild/rebase checks for scope, network, correctness and performance; security refresh owner/process and rebase-effort record |

## Performance and resource budgets

All numbers below are unchanged PRD targets. Existing smoke core timings in `docs/benchmarks/smoke-process-only-linux.json` do not verify these user-visible budgets.

| Requirement / measurement | Status | Evidence needed |
|---|---|---|
| §10.1 R64 definition | partial | `benchmarks/r64-fixture-audit.json` independently confirms 200k tracked/1m ignored/2k untracked/1k modified across16 checkouts; finish documented topology/checkouts/state-case verification before complete fixture gate |
| §10.1 R256/LARGE1 | partial | `benchmarks/r256-fixture-audit.json` confirms 1m tracked files at R256; `benchmarks/large1-fixture-audit.json` confirms 500k tracked/100 modified/100 untracked at LARGE1; finish topology/state cases and desktop resource degradation |
| §10.1 Reference machine | partial | R64 report records Ryzen9 7900X,24 logical CPUs,~64GiB RAM, Kingston KC3000 NVMe,Btrfs/Linux7.1.12; document security configuration and controlled storage/cache state |
| §10.2 Measurement method | partial | ≥30 controlled runs/scenario, p50/p95/worst, CPU/memory/IO, painted usable boundary; warm/cacheless/cold-disk labels accurate; comparable upstream baseline |
| Warm reopen p95 ≤1.5 s | unstarted | Process invocation → usable desktop/input/restored navigation |
| Cold launch p95 ≤3 s | unstarted | Controlled cold filesystem → usable desktop; record how caches were cooled |
| Saved catalog p95 ≤100 ms | partial | Pane mount → interactive painted cached/unverified R64 rows |
| Selected known branch warm p95 ≤100 ms | partial | Selection/direct request → verified paint including queue time |
| Selected uncached metadata p95 ≤250 ms | partial | Running desktop request → verified paint independent of status |
| All R64 branches warm p95 ≤1 s | partial | Interactive pane → all available checkout branch results painted |
| First-open declarations p95 ≤2 s | partial | Usable shell → complete declared R64 catalog/errors without source crawl |
| Selected complete status warm p95 ≤750 ms | partial | Selected representative R64 child → complete tracked/untracked painted result |
| R64 complete status warm p95 ≤5 s | partial | Explicit refresh → complete in-scope results, including all untracked paths |
| Ordinary file p95 ≤150 ms | unstarted | Request → usable ≤1 MiB buffer |
| Ordinary diff p95 ≤250 ms | unstarted | Request → usable ≤2 MiB combined input/≤500 changed lines |
| Directory expand p95 ≤100 ms | unstarted | Request → usable ≤200-entry directory |
| Search first result p95 ≤500 ms | unstarted | Fixed present-match fixture submission → first result; separately record completion |
| Input under churn p95 ≤50 ms | unstarted | Input event → paint during 1,000 changes/s for 30 s across 16 checkouts |
| Zero involuntary row displacement | partial | Existing visible row geometry during asynchronous updates, no user sort/filter/resize |
| Combined launch-to-selected-branch | unstarted | Process invocation → selected verified painted branch, reported alongside subprocess timings |
| Idle memory ≤600 MiB | partial | Replacement directory watcher ready in 1.513s with 2,178 watches, 130.8MiB sampled peak RSS/97.8MiB PSS and no degradation (`benchmarks/r64-watch-startup-directory.json`); supersedes initial recursive-watcher OOM. Still measure summed settled desktop RSS/PSS |
| Idle CPU ≤0.5% of one logical core /60 s | unstarted | Settled R64; no periodic workspace scans without invalidation/user action |
| Branch event response ≤250 ms | partial | Delivered watcher event → changed branch paint; separately report watcher delay |
| Selected status convergence ≤1 s after churn | partial | Burst ends → complete selected status; refresh active data during burst and bounded queues |
| Watch failure/reconnect | partial | Immediately stale/degraded state, bounded fallback, focus revalidation and explicit refresh recovery; no frozen observed state |

The real `WorkspaceSession` R64 diagnostic in `benchmarks/r64-session-churn-recheck.json` exercised one 30-second burst and observed all 29 branch switches, with 109 ms p95 from delivered native event to branch state and 238 ms selected-status convergence. Its Node process and missing renderer do not establish desktop budgets. A planned 30-repetition run was stopped after two completed repetitions because concurrent unrelated host workloads reduced its achieved mutation rate; `benchmarks/r64-session-churn-uncontrolled-partial.json` preserves the invalid attempt. `scripts/desktop-bench.mjs` is an unvalidated Electron measurement harness pending a passing desktop smoke and a quiet host.

## Acceptance gates

| Gate | Status | Evidence present | Work needed to verify complete gate |
|---|---|---|---|
| AT-01 Original pain | partial | Metadata scheduler/controller tests, smoke core benchmark | Full R64 warm user journey, launch/paint budgets and stable geometry |
| AT-02 Fresh catalog | partial | Real declared/index-only/missing checkout fixtures | Cacheless desktop R64 within budget, visible incomplete/error states |
| AT-03 Cache truth | partial | Cached selected-first and stale-response tests | External closed-app branch switch, reopen UI shows unverified then correct value |
| AT-04 Slow/broken sibling | partial | Held scheduler content and repository error tests | Desktop branch/navigation/edit/status remain responsive under delayed/failed sibling |
| AT-05 Submodules | partial | Child dirty/pointer/staged gitlink tests | Nested differential fixtures and correct desktop aggregate/pointer presentation |
| AT-06 Churn | partial | Controller invalidation/throttle/coalescing | Defined sustained workload; input latency, bounded queues, convergence and uncertainty |
| AT-07 Dirty-buffer race | unstarted | Host editor smoke is not desktop conflict evidence | Same-file external modification with unsaved edits preserves both versions and refuses stale save |
| AT-08 Git-operation race | partial | Content/index/branch/child-HEAD freshness tests | Hunk/new-operation and IPC review races; visible reject/reprepare; no retargeting |
| AT-09 Watch failure | partial | Prototype metadata error state/focus fallback | Native event loss/overflow/reconnect/exhaustion fault injection and recovery |
| AT-10 Path/storage | partial | Literal Unicode/dash/newline names, symlinks, gitfiles, worktrees | Desktop root authorization and full supported path/storage/format matrix |
| AT-11 Removal | partial | Prepared-source audit identifies forbidden transitive areas | Actual desktop built graph, registrations/commands/workers/network audit and attempted feature restoration |
| AT-12 Offline/untrusted | partial | Native sandbox independently blocks newly added filters, secondary execution, socketpair and metadata mutation | Partial-clone missing-object offline cases, full desktop untrusted runtime trace, kernel-support errors and process cleanup |
| AT-13 Failures | partial | Missing Git/old Git handling, lock/hook/timeout/cancel checks | Desktop signing/auth/recovery flows, no retries/deletion and persisted drafts/buffers |
| AT-14 Accessibility | partial | Extension keyboard semantics and browser interaction checks | Desktop keyboard plus actual screen-reader lookup/diff/stage/commit, high contrast and restrained announcements |
| AT-15 Coexistence | partial | Isolated prototype profile and prepared distinct identity | Install native package beside VS Code; CLI reuse/no duplicate observers/no migration/account |
| AT-16 Scale/recovery | partial | Generators, cache corruption, output limits | Actual R256/LARGE1, crash/restart dirty recovery, heavy text/binary behavior and resource bounds |

## Milestones and decisions

| Item | Status | Required decision or completion evidence |
|---|---|---|
| M0 feasibility exit | partial | Actual upstream trace and real reported-workflow reproduction when workspace is supplied; full fixture runs, supported Git/reference runner, removal/security strategy and evidence for any budget change |
| M1 read-first alpha exit | partial | Source-based stripped desktop boots with safe reads, reliable files/editor/search and original branch journey; forbidden services absent |
| M2 beta exit | partial | All P0 functional/safety requirements on Linux; no open silent-loss defect; concurrency/recovery evidence |
| M3 supported-release exit | unstarted | Package/install/accessibility/authenticated updates/notices/performance/rebase checks and real-workspace usability sessions; all applicable AT gates pass |
| Platform scope | partial | PRD §3 already allows Linux x64 first. Windows x64/macOS Apple Silicon are later candidates and must not be advertised without their own gates. Record Linux-supported filesystem/Git matrix, do not silently redefine cross-platform support |
| Source-foundation choice | partial | Explain how the new Electron shell and source-built Code-OSS editor form the reviewed fork/allowlisted distribution; retained upstream behaviors need tests, not inherited claims |
| Update distribution | unstarted | Select operational artifact host/channel and publisher trust root; implement signature/authenticity/rollback independently testable with fixture keys. Development keys/test feeds do not establish a production publisher identity |
| Product/name clearance | partial | A private name review records dated primary package/domain and interactive USPTO/WIPO exact searches, existing MINV software use, and Microsoft branding policy. Resolve intended territories, actual domain/publisher ownership; this evidence is not legal clearance |
| Real-world evidence | unstarted | Supplied motivating workspace/trace and user usability sessions are external inputs; retain “not reproduced” when unavailable rather than inventing validation |
| Reference hardware/cold-cache control | partial | Record actual hardware/filesystem and whether controlled cold-disk runs are possible. Budget changes require explicit product decision backed by measurements |

## Independent review work queue

Review new desktop IPC/main/preload for sender and navigation checks, narrow command schemas, authorized roots, capability-bound review snapshots, subprocess policy, credential redaction and recovery separation. Add regression tests in `test/release-*.test.ts` only when they exercise real behavior. Track concrete failures to their owning agent and move a row to verified only after the fix and complete requirement evidence exist.

October 5, 2026: `npm run build` followed by `node --test dist/test/release-files.test.js dist/test/release-protocol.test.js dist/test/release-sandbox.test.js dist/test/release-git-service.test.js dist/test/release-assets.test.js` passed all 21 independent regressions. These verify narrow behaviors, not complete desktop release gates. Coverage includes recovery permissions; ancestor-symlink read and search-root launch swaps; strict IPC origin/schema handling; native metadata, regular-file ioctl, socket and helper-execution denial; stale displayed status/diff refusal before preparing a write; path/direction/whitespace review binding; trust revalidation after commit confirmation; remote destination revalidation; and public-resource origin/path confinement.

Current integration review remains open for workspace replacement with dirty buffers, CLI launch/wait lifecycle, watcher performance, full renderer/native confirmation correspondence, and packaged behavior. `test/release-file-service.test.ts` is maintained by the file-service owner and adds separate adapter integration coverage; its results should be reported independently of the 21-test review suite above.

Renderer integration review, October 5: the three `test/release-renderer-state.test.ts` regressions now pass after fixes: dirty-tab close and disk replacement flush the latest recovery draft, and a recovery failure preserves the editor. The same-repository selection feedback loop is fixed and covered by WorkspaceSession tests. A bounded, atomic per-workspace session backend exists, but renderer/protocol integration for persisted tabs/view state/pins/user ordering/expanded directories and draft-reopening UI still needs verification. Native window geometry is persisted. These narrow fixes do not establish the complete WS-01, REPO-01, EDIT-02 or AT-16 requirements. The standalone application has booted with live Git data and the source-built editor; its first visual direction was rejected by the user, and the authoritative redesign is in progress.
