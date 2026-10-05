# Minv
## Product Requirements Document

**Product name:** Minv  
**Name meaning:** **Min**imal **V**S Code  
**Version:** 1.0 — proposed product baseline  
**Date:** October 5, 2026  
**Product category:** Local-first desktop code-management client  
**Foundation:** A focused Code-OSS fork  
**Positioning:** Browse. Review. Commit.

> A small question about your code must never wait for the entire workspace.

## 1. Executive summary

Minv is a thin desktop client for managing an existing codebase: browsing files, inspecting and editing text, reviewing diffs, and operating Git. It is designed to sit beside tools that write code, including external coding agents, terminals, and full IDEs. It does not contain an agent, a model provider, an AI assistant, or an agent-management layer.

The defining use case is a large local workspace containing dozens of Git submodules. A user opens the workspace to answer a small question—such as which branch one submodule is on—and receives a verified answer without waiting for every repository to finish loading or calculating changes. Repository rows remain stable while information arrives.

The product retains the useful editor and desktop foundations of Code-OSS, replaces the repository discovery/status experience, and excludes product capabilities that do not serve code management. All built-in AI functionality, debugging, and GitHub-specific integration are removed from the shipping product, not merely hidden behind default settings.

This is not a read-only viewer. Users can make corrections, resolve conflicts, stage hunks, and commit changes. However, authoring assistance, application execution, and agent orchestration are not the product's purpose.

**Primary success criterion:** the client makes a large multi-repository workspace immediately understandable and safely actionable without requiring the user's other tools to change.

## 2. Problem and evidence

### 2.1 Observed problem

The initiating user reported opening a workspace to inspect a particular submodule's branch. Source Control took **13 seconds** to load its repositories. Entries appeared individually, repeatedly shifting the layout.

This is one user-reported observation, not an independently reproduced benchmark. Its cause has not been established. It identifies two separate failures: unnecessary waiting for an answer, and an unstable interaction target.

### 2.2 Problems to solve

**Excessive dependency between unrelated work.** Repository discovery, branch metadata, full working-tree status, and rendering must not behave like one global readiness barrier.

**Too much product around a narrow job.** The user already has AI tooling and does not need a second assistant, debugger, or hosting-provider interface inside the code browser.

**Poor multi-repository ergonomics.** Dozens of expanding Source Control groups make it difficult to find one repository, understand its branch, or distinguish a child repository's changes from its parent's submodule pointer.

**Concurrent modification.** External tools can edit files, update the index, or switch branches while the client is open. Fast cached displays must not cause silent overwrites or operations against the wrong state.

### 2.3 Product thesis

Decouple cheap answers from expensive scans; present a stable repository catalog; schedule work according to the user's current interaction; and remove unrelated runtime capabilities. Validate each improvement with traces rather than assuming that deleting features alone will eliminate Git latency.

## 3. Audience, assumptions, and decisions

### 3.1 Primary audience

Developers who already use external coding tools and want a fast visual companion for inspection, navigation, review, and Git. The initial priority is users with 20–100 repositories or submodules in one workspace, including nested submodules. A single large repository and ordinary multi-root workspaces must also remain first-class.

### 3.2 Planning assumptions

The following are proposed decisions, not additional requirements attributed to the user.

| Topic | Baseline decision |
|---|---|
| Platform | Linux x64 is the first implementation and performance reference. Windows x64 and macOS Apple Silicon are subsequent release candidates, each gated separately. |
| Storage | Native local filesystems are the guaranteed performance environment. Network mounts receive graceful degradation, not the same latency promise. |
| Existing tools | External terminals, agents, and IDEs remain independent. No migration into Minv is required. |
| Git | Use the user's Git executable, with a documented, tested minimum version selected during the feasibility milestone. Detect unsupported versions before operations. |
| Extensions | No general-purpose extension marketplace or arbitrary executable third-party extensions in v1. Bundle only audited capabilities required by the product. |
| Terminal | No integrated terminal in v1. Provide an explicit external-terminal handoff for the selected repository. |
| Business model | No account, subscription, hosted backend, or monetization dependency is required for the first release. Distribution economics are a separate decision. |

Preserve portability in the implementation. Do not advertise an operating system as supported until its correctness, packaging, and performance gates pass.

## 4. Goals, non-goals, and product rules

### 4.1 Goals

**G1 — Immediate orientation.** Find a repository and inspect its actual checked-out branch without waiting for workspace-wide status.

**G2 — Calm navigation.** Keep rows, selection, focus, and scroll position stable during asynchronous discovery and refresh.

**G3 — Fast code management.** Open files, search text, review changes, and perform ordinary Git operations with minimal overhead.

**G4 — Safe coexistence.** Remain useful and correct while another tool modifies the same working trees.

**G5 — Deliberately narrow scope.** No built-in AI, debugging, or provider-specific collaboration layer; no background work merely because it existed upstream.

### 4.2 Explicit non-goals

Minv is not an AI IDE, agent host, debugger, build system, test runner, pull-request client, cloud workspace service, or complete replacement for all Git command-line operations. It does not attempt to identify which agent authored a change, measure model usage, or maintain an agent task history.

Full language intelligence, remote development protocols, notebook execution, arbitrary extensions, and advanced history rewriting are outside v1. These are not presumed roadmap commitments.

### 4.3 Non-negotiable product rules

1. A branch answer never depends on a complete working-tree scan.
2. Unknown, stale, partial, and failed data never look clean or freshly verified.
3. Background updates never move an established interaction target without user action.
4. Opening a workspace never starts network activity or changes repository configuration by default.
5. No operation silently overwrites another tool's work, crosses repository boundaries, or bypasses Git safeguards.
6. A capability is added only when it materially improves inspection, navigation, editing, or Git management and fits the performance budget.

## 5. Naming and positioning

**Selected name:** Minv, meaning **Min**imal **V**S Code. The executable name is `minv`. Trademark, domain, package, and executable-name collision checks remain required before release.

**Primary tagline:** Browse. Review. Commit.  
**Expanded positioning:** A fast code browser and Git client for the tools you already use.  
**Product promise:** Your code-management sidecar—not another coding assistant.

Avoid AI-themed naming and marketing. Compatibility with external coding agents is a workflow property, not an embedded feature category.

## 6. Scope and feature disposition

**P0** means required for the first supported release. **P1** means a candidate after P0 gates pass, not a committed date. **Excluded** means deliberately absent from the baseline product.

| Capability | Decision | Boundary |
|---|---|---|
| Text editing | P0 | Syntax coloring, tabs, splits, selection, undo, find/replace, explicit saves, encoding and line-ending awareness. |
| File browser and text search | P0 | Lazy directory expansion, quick open, scoped search, file operations, ignore controls. |
| Repository catalog and Git changes | P0 | Independent metadata/status loading, stable rows, submodule-aware state. |
| Diff and conflict editing | P0 | Text diffs and manual conflict resolution; no generated explanations. |
| Basic Git operations | P0 | Explicitly scoped staging, commits, branches, stash, fetch, and push. |
| Basic local history | P0 | Selected-repository, paginated commit and file-change inspection. No global graph at startup. |
| External-tool handoff | P0 | CLI open/goto/diff/wait and explicit external-terminal launch. |
| AI and agent functionality | Excluded | Chat, completions, model providers, embeddings, semantic AI search, MCP, agent sessions, prompt tools, generated commit messages, and related background services. |
| Debugging and execution | Excluded | Debug adapters, breakpoints, launch configurations, Run and Debug, tasks, test discovery, notebook execution. |
| GitHub/provider integration | Excluded | Provider login, PRs, issues, checks, review APIs, publishing workflows, Codespaces, cloud agent hooks. Ordinary Git remotes remain supported. |
| Language intelligence | Excluded from v1 | No language servers, workspace symbol index, refactoring engines, or automatic diagnostics. Local syntax grammars remain. |
| Integrated terminal | Excluded from v1 | Existing external terminals remain the execution environment. |
| Extension marketplace and account sync | Excluded | No Microsoft Marketplace, extension recommendations, account system, settings sync, or arbitrary extension migration. |
| Advanced Git workflows | P1 | Rich graph, blame, cherry-pick/rebase initiation, worktree creation, submodule initialization/update, cloning, and multi-repository write batches. |
| Remote workspaces | Excluded from v1 | No SSH, WSL, container, tunnel, or browser-hosted runtime product. |
| Theme/grammar imports | P1 | Validated declarative assets only; not a back door for executable extensions. |

Removing language intelligence does not remove ordinary text editing. Removing GitHub integration does not prevent fetching from or pushing to a GitHub-hosted remote using Git and the user's existing credentials.

## 7. Core user journeys

### 7.1 Inspect one submodule's branch

Open a remembered workspace. The saved repository catalog appears in stable order, with unverified values explicitly marked. Search for a submodule by name or path. Its metadata request receives interactive priority; the verified branch or detached-HEAD state appears in the existing row. Other repositories may still be discovering changes. No full status scan is required to answer the question.

### 7.2 Review work created elsewhere

An external tool edits files in several submodules. Affected repositories show pending refresh without claiming who made the changes. Select one repository, inspect its changed files, and open a diff. Make a correction, save explicitly, stage selected hunks, and review the exact staged content before committing to that repository.

### 7.3 Understand parent/child Git state

A submodule has dirty files and its checked-out commit differs from the commit recorded by the parent. The child shows its own file changes. The parent separately shows its submodule pointer state. Committing the child does not silently stage or commit the parent's pointer; those remain explicit operations.

### 7.4 Navigate during heavy activity

An external operation creates or modifies thousands of files. The user continues navigating, searching repository names, and opening already-known files. Background work is coalesced and deprioritized. Active data refreshes incrementally, with visible partial-state indicators instead of a blocking workspace spinner.

### 7.5 Intervene without losing work

The user has an unsaved buffer while an external tool changes the same file. Minv preserves the buffer, announces the disk change, and offers a comparison. It does not silently reload the dirty buffer or overwrite the disk version on save. A Git operation prepared from stale state is revalidated or stopped with an explanation.

## 8. Functional requirements

### 8.1 Workspace lifecycle and repository catalog

**WS-01 — Open and restore [P0].** Open folders and multi-root workspaces without Git. Restore tabs, active repository, repository order, expanded directories, and scroll state without waiting for repository status. A missing Git executable degrades Git features only.

**WS-02 — Independent catalog [P0].** Maintain a persistent catalog of known repositories and their relationships. Load it before status initialization. Validate cached entries asynchronously; missing or inaccessible entries retain their row and show a clear state. Never present a cached entry as freshly verified.

**WS-03 — Bounded discovery [P0].** Discover from explicit workspace roots, known repository paths, declared submodule paths, and Git-recorded submodule entries. Reconcile disagreements among declarations, index state, and checkout availability. Unknown nested standalone repositories use bounded discovery or explicit registration, not an unrestricted startup crawl. Provide a user-invoked deeper scan with progress and cancellation.

**WS-04 — Incomplete checkout support [P0].** Represent uninitialized, absent, invalid, and inaccessible submodules. Opening a workspace never clones, initializes, repairs, or updates them automatically. Corrupt metadata in one repository must not block others.

**WS-05 — Identity [P0].** Identify a checkout independently from its display name, remote URL, and branch. Support identical names at different paths, gitfiles, separate Git directories, and independently opened linked worktrees. Do not merge two worktrees' index or branch state merely because they share an object database.

### 8.2 Repository navigation and branch state

**REPO-01 — Stable browser [P0].** Provide a virtualized, searchable repository list with repository/path, checked-out branch, change summary, and freshness. Offer a flat view and a collapsible parent/submodule view. Persist user ordering and pins. Async results update cells, not row positions or heights.

**REPO-02 — Accurate fast metadata [P0].** Read the current symbolic branch independently from working changes. Distinguish named branch, detached HEAD with abbreviated commit, unborn branch, unavailable checkout, and read failure. Never use the branch setting in `.gitmodules` as the current checkout branch. Git exposes symbolic-ref inspection separately; `.gitmodules` branch settings describe update tracking. [S3, S4]

**REPO-03 — Interactive priority [P0].** Searching, selecting, or directly opening a repository prioritizes its metadata over unrelated background status. No global discovery-complete event is required before a known path can be inspected.

**REPO-04 — Selection integrity [P0].** Every editor tab, diff, and Git action retains an explicit owning repository/checkout. Changing active repositories cannot retarget an already-open commit form or operation silently. Duplicate file basenames are disambiguated by repository and path.

**REPO-05 — Stable incomplete results [P0].** On first opening, unknown repositories may appear in batches, but discovery must preserve the selected row's visual anchor. Default ordering does not re-sort by changing status or branch name. Search results explicitly indicate incomplete discovery when applicable.

### 8.3 File browsing, search, and editing

**FILE-01 — Lazy explorer [P0].** Enumerate expanded directories on demand. Git decorations never block directory contents or file opening. Keep browse exclusions, text-search exclusions, and Git-status visibility as separate policies; hiding a generated directory in the tree must not silently hide Git changes.

**FILE-02 — Search [P0].** Provide filename/path search and cancellable plain-text/regular-expression content search across the workspace or selected repositories. Respect documented ignore settings, offer an include-ignored option, and show searched scope and completeness. Build lightweight path indexes incrementally; never require a semantic index or embeddings.

**FILE-03 — File operations [P0].** Create, rename, move, copy paths, reveal in the OS, and delete with appropriate confirmation or trash support. Show affected repositories before crossing repository boundaries. Do not follow symlink cycles or perform an unbounded recursive delete as an incidental UI action.

**EDIT-01 — Practical editing [P0].** Retain syntax coloring, line numbers, folding where available without a language server, multi-cursor, split panes, find/replace, undo/redo, and explicit save. Do not change encoding, line endings, or formatting just because a file was opened. Autosave and format-on-save are off by default; no formatter runs on open.

**EDIT-02 — External changes [P0].** Reload clean buffers after compatible disk changes while preserving view position where possible. Preserve dirty buffers and require reconciliation. A save compares the disk version used as its base and refuses a known conflicting overwrite without an explicit user choice.

**EDIT-03 — Heavy files [P0].** Introduce a large-file mode with bounded rendering and reduced tokenization. For unsupported size or binary content, show metadata and an explicit open/handoff choice rather than freezing. Document thresholds; do not silently truncate an editable file or diff.

### 8.4 Git status, review, and history

**GIT-01 — Independent state layers [P0].** Catalog, branch metadata, working changes, and history/diffs publish independently. Show staged, unstaged, untracked, conflicted, ignored-by-policy, unknown, and unavailable states distinctly. A count is complete only when its requested scope has been examined.

**GIT-02 — Submodule semantics [P0].** Distinguish child working-tree dirtiness, child HEAD versus the parent's index gitlink, and the parent's staged gitlink versus its HEAD. Nested aggregation preserves these meanings without double-counting one changed file as multiple files. Show child-derived summaries separately from parent-owned changes. Git documents gitlinks and independent submodule repositories. [S5]

**GIT-03 — Honest progressive status [P0].** Visible/selected repositories refresh first, followed by the remaining catalog through a fair background queue. Untracked enumeration may be separately scheduled, but its pending state must remain visible. No global clean badge appears while required repositories or scopes remain unknown. An explicit full refresh requests complete relevant state.

**GIT-04 — Diff review [P0].** Provide side-by-side and inline text diffs for working tree versus index, index versus HEAD, and selected local revisions. Clearly label both sides and the owning repository. Whitespace filters affect presentation only. Binary, rename, mode-only, symlink, and gitlink changes have explicit presentations and never disappear because a text diff is unavailable.

**GIT-05 — Local history [P0].** Load a bounded, paginated history for the selected repository only on request. Open commit details and changed files without scanning other repositories. Missing objects in partial clones remain visibly unavailable unless the user authorizes retrieval.

### 8.5 Git writes and remote operations

**WRITE-01 — Explicit scope [P0].** Support file and hunk staging/unstaging, commit, branch create/switch, stash create/apply/drop, and discard/restore for one repository at a time. Confirm destructive choices with repository, paths, and consequences. Never interpret selecting a repository as permission to change it.

**WRITE-02 — Commit integrity [P0].** Show the exact staged diff and target repository/branch before commit. Commit messages are written by the user or supplied through ordinary external editing. Do not stage all changes automatically. Preserve commit drafts on failure. Respect configured signing and hooks after the relevant trust decision; do not silently bypass either.

**WRITE-03 — Freshness and concurrency [P0].** Capture relevant HEAD, index, path-content, and diff preconditions when preparing an operation; revalidate before applying it. Invalidate hunk selection when its source changes. Use Git's locking and normal refusal behavior, plus application-level serialization for writes sharing a checkout or common ref store. Never claim a transactional lock over independent external tools.

**WRITE-04 — Destructive-operation policy [P0].** Do not offer force push, hard reset, automatic clean, or bulk recursive discard in v1. Ordinary discard/replace actions require current-state checks and a recoverable local backup where supported; otherwise provide an explicit no-undo warning or require external handoff. Never delete a lockfile automatically.

**WRITE-05 — Submodule pointer operations [P0].** Staging a parent pointer is distinct from staging files inside the child. Commit the child and update the parent only through separate user actions. Display a warning when a parent pointer refers to child commits not known to be available remotely; do not claim remote availability without relevant evidence.

**REMOTE-01 — Generic Git [P0].** Show configured remotes and provide explicit fetch, push, and fast-forward-only pull. Use existing Git credential/SSH mechanisms; no application-level provider account is required. Show remote/branch scope and last-fetch time. No background fetch, credential prompt, avatar request, or host API call occurs on workspace open.

**REMOTE-02 — Failure and cancellation [P0].** Authentication prompts arise only from user-requested network operations. Surface failures and available raw output without leaking credentials. Cancel read/network work where safe; for a write with uncertain completion, report uncertainty and inspect actual state before retrying. Never retry a push or commit blindly.

**CONFLICT-01 — Existing operations [P0].** Detect merge, rebase, cherry-pick, revert, and conflict states initiated elsewhere. Offer manual text/three-way conflict resolution and explicit staging of resolved files. Advanced sequence initiation and continuation controls may use external handoff in v1; display this boundary instead of pretending the operation is complete.

### 8.6 External tools, settings, and diagnostics

**EXT-01 — Generic CLI [P0].** Provide open/reuse-window, file-and-position, diff, selected-repository, and wait-for-buffer-close operations. Proposed forms include `minv --goto file:42:5`, `minv --repo path`, `minv --diff before after`, and `minv --wait file`. Correctly parse platform-specific paths. Repeated calls reuse the intended workspace and do not start duplicate scanners.

**EXT-02 — No agent dependency [P0].** CLI and filesystem changes are sufficient for integration. Do not add model configuration, agent SDKs, MCP endpoints, autonomous actions, a prompt bar, or an agent session database. External changes are labeled external—not attributed to an agent without evidence.

**SET-01 — Small settings surface [P0].** Expose appearance, keybindings, workspace roots, ignore policies, Git path, approved credentials/hook behavior, performance mode, and external-terminal configuration. Import safe editor preferences explicitly; do not automatically import extensions, tasks, launch files, account tokens, AI settings, or executable workspace settings.

**OBS-01 — Local diagnostics [P0].** Provide an on-demand performance view containing discovery timings, branch latency, status queue wait/run time, Git process counts, watcher health, and renderer stalls. Export a redacted local trace by explicit action. No telemetry, code upload, or remote crash reporting is enabled by default.

## 9. Interface and interaction model

The main window has three functional areas: a compact navigation rail for Files, Repositories, and Search; an editor/diff area; and an optional detail area for the selected repository. History and operation output open contextually. There is no chat, agent, Run and Debug, testing, account, or provider activity icon.

The repository view is a compact list rather than a vertical stack of independently expanding Source Control panels. Its default columns are repository/path, branch, changes, and freshness. Change details occupy the selected repository's detail area. Narrow windows may collapse secondary columns, but branch identity and state remain accessible.

Preserve familiar editor navigation and keyboard conventions where they do not conflict with the reduced scope. Every primary flow must be keyboard-operable. Provide accessible names for state indicators, high-contrast support, screen-reader announcements that do not flood during refresh, and reduced-motion behavior. Color is never the only state signal.

Use specific loading language: “Checking branch,” “Untracked files pending,” “Offline checkout,” or “Last checked 2 minutes ago,” rather than one indefinite “Loading repositories” label. Avoid zero counts until zero has been established.

### State vocabulary

| State | Meaning | Permitted presentation |
|---|---|---|
| Unknown | Never successfully read for this scope | Dash or explicit unknown label; no clean checkmark. |
| Cached / unverified | Saved value not validated in this session | Value with an unverified indicator. |
| Refreshing / partial | Some required information is pending | Available values plus explicit incomplete scope. |
| Observed | Successful observation, not subsequently invalidated | Value and observation time; not a promise against invisible future changes. |
| Stale | Change or missed-event condition invalidates observation | Previous value may remain, clearly marked stale. |
| Unavailable / error | Cannot inspect repository or scope | Specific reason and retry/handoff action. |

A frozen or unavailable background process must not make these states ambiguous.

## 10. Performance requirements and benchmark contract

These are **proposed engineering acceptance budgets**, not measured performance claims. Feasibility work must validate them. Budget changes require recorded evidence and an explicit product decision; do not silently loosen them to pass a release.

### 10.1 Reference fixture

**R64:** 64 total Git working trees: one superproject and 63 submodule repositories, with at least 12 nested relationships and nesting depth up to three. Approximately 200,000 tracked files in aggregate, 1,000,000 ignored/generated files across excluded directories, 2,000 untracked non-ignored files, and 1,000 modifications distributed across 16 repositories. Include detached HEAD, one unborn standalone companion fixture, several uninitialized submodule entries, and representative staged gitlink changes. Report checkout count separately from catalog entry count.

**R256:** 256 available working trees and approximately 1,000,000 tracked files for scale and graceful-degradation testing. It is not automatically entitled to R64's complete-scan budgets, but input responsiveness, branch independence, honest state, and bounded resource behavior remain mandatory.

**LARGE1:** A single repository with approximately 500,000 tracked files; tests must ensure that optimization for many repositories does not hide poor single-repository behavior.

Use a reproducible local fixture generator with a fixed seed and documented tree layout, file sizes, history depth, refs, ignore rules, and Git configuration. The Linux reference runner has at least eight modern CPU cores, 16 GiB RAM, and local NVMe storage; record its exact model and filesystem in results. Test Windows and macOS on separately documented hardware, never combine platform percentiles.

### 10.2 Measurement definitions

**Warm reopen:** application exited, persisted workspace cache present, OS filesystem cache warm. **First open:** no product workspace cache; OS cache condition recorded separately. **Cold launch:** application exited and filesystem cache deliberately cold on a controlled runner. Do not call deleting application settings a cold-disk test.

Measure end-to-end user events through painted, usable results, not only Git subprocess duration. Run at least 30 controlled repetitions per scenario and report p50, p95, worst case, CPU, memory, and IO. Use the same fixture, Git, OS, security software configuration, and cache state for comparisons. Record both a clean upstream baseline and the user's ordinary setup when available.

### 10.3 R64 release budgets

| Metric | Target | Measurement boundary |
|---|---|---|
| Warm application reopen | p95 ≤ 1.5 s | Process invocation to usable window, input, and restored navigation. |
| Cold application launch | p95 ≤ 3 s | Process invocation to usable window; all-repo status is not required. |
| Saved catalog display | p95 ≤ 100 ms | Repository pane mount to interactive saved rows, marked unverified. |
| Selected known-repo branch, warm | p95 ≤ 100 ms | Selection/direct-path request to verified painted branch, including queue time. |
| Selected known-repo branch, uncached metadata | p95 ≤ 250 ms | Request in running application to verified result; no full status dependency. |
| All available R64 branches, warm | p95 ≤ 1 s | Interactive repository pane to all available checkouts' verified branch states. |
| First-open declared catalog | p95 ≤ 2 s | Usable shell to discovered R64 declarations/checkouts; errors represented, not hidden. |
| Selected repository complete status, warm | p95 ≤ 750 ms | Selection to complete requested tracked/untracked state for a representative R64 child. |
| R64 complete workspace status, warm | p95 ≤ 5 s | Explicit full refresh to complete in-scope results; no omitted untracked files. |
| Open ordinary text file | p95 ≤ 150 ms | Request to usable ≤1 MiB local text buffer. |
| Open ordinary text diff | p95 ≤ 250 ms | Request to usable diff, ≤2 MiB combined input and ≤500 changed lines. |
| Directory expansion | p95 ≤ 100 ms | Expand request to usable directory of ≤200 entries. |
| Search first result | p95 ≤ 500 ms | Submission to first matching result in a fixed present-match fixture; completion measured separately. |
| Input under churn | p95 ≤ 50 ms | Input event to visible response during the defined external-write workload. |
| Layout stability | Zero involuntary row displacement | Existing visible repository row geometry during async refresh, absent user sort/filter/resize. |

Launch-to-selected-branch must also be recorded as a combined metric; do not hide startup cost by advertising only the in-process lookup number. A missing or corrupt checkout may return an accurate error within its deadline rather than a branch.

### 10.4 Resource and freshness budgets

After R64 settles with one ordinary text file open, target **≤600 MiB summed resident memory across application-owned processes**, excluding unrelated external tools. Document shared-page accounting and also record PSS where supported. Target **≤0.5% of one logical CPU core averaged over 60 idle seconds**. After initialization on reliable native watchers, perform no periodic full-workspace Git scans without an invalidation or explicit request.

During an external workload of 1,000 file changes per second for 30 seconds across 16 repositories, preserve input budgets, coalesce duplicate events, and bound queues. Refresh active-repository observations during the burst rather than indefinitely debouncing. Target a branch change visible within 250 ms of a delivered native event and selected status converging within one second after the burst ends. Report watcher delay separately from application processing.

Focus regain triggers bounded revalidation. A missed-event or watcher-failure condition immediately downgrades freshness, enables explicit refresh and bounded fallback checks, and explains degraded monitoring. Never keep showing an observed/clean state solely because a watcher is broken.

## 11. Architecture constraints and recommended design

This section establishes constraints and a recommended decomposition, not a requirement to implement a particular programming language or database before profiling.

### 11.1 Product shell and feature removal

Build from Code-OSS source using a product-specific contribution and dependency allowlist. Preserve the editor, desktop lifecycle, file services, basic search, security, accessibility, and needed diff services. Code-OSS organizes core layers and workbench contributions separately, providing useful boundaries for a focused distribution. [S1]

Exclude AI, debug, provider, and execution entry points from the shipping product graph. Do not ship functional implementations merely because their menu entries are hidden. Document any inert compatibility stubs with a justification; they must not initialize services, workers, handlers, or network clients.

Replace the built-in Git discovery/status path for supported workflows with one authoritative repository service. Avoid running the legacy provider and the replacement concurrently. A prototype may run as an isolated extension with built-in Git disabled, but the shipping target remains the focused fork.

### 11.2 Recommended service boundaries

| Component | Responsibility |
|---|---|
| Workspace catalog | Roots, checkout identity, submodule relationships, persistent row ordering. |
| Metadata service | Branch, HEAD, availability, operation markers; no dependency on full status. |
| Git worker | Structured Git commands, read/write separation, cancellation, bounded concurrency. |
| Status service | Per-repository observations, untracked completeness, parent/child aggregation. |
| Watch coordinator | Shared watch coverage, invalidation routing, overflow/reconnect recovery. |
| File/search service | Lazy enumeration, bounded path index, cancellable text search. |
| UI state store | Independent field freshness, stable identity, active scope, accessible presentation. |
| Local cache | Versioned disposable metadata; distinct from unsaved buffers and recovery data. |

A dedicated process or existing process-isolation boundary should keep Git and filesystem work off the renderer. Begin with the simplest measurable implementation compatible with the fork. A native daemon or rewritten Git implementation requires evidence, not an assumption that language choice alone provides speed.

### 11.3 Scheduling contract

Use distinct interactive-metadata, foreground-content/status, background-status, and maintenance queues. Reserve capacity so a branch request can run while bulk status is busy. Coalesce duplicate reads, cancel superseded cancellable reads, prevent background starvation, and cap resource use. A write is not canceled simply because selection changes.

A starting experiment is four background Git read slots plus one reserved metadata slot, with separately serialized writes. These values are tuning inputs, not guaranteed optimal settings. Account for shared repository resources across linked worktrees.

### 11.4 Git compatibility and efficient observation

Prefer Git's own discovery and machine-readable outputs over a hand-written interpretation of every storage format. Resolve the checkout Git directory and common directory through supported Git interfaces. Do not assume `.git` is always a directory or that ref storage is always loose files. Git provides directory-resolution and common-directory queries. [S6]

For background observation, evaluate `--no-optional-locks`. For parent status, evaluate `--ignore-submodules=dirty`, then merge separately obtained child state into the application's explicitly labeled aggregate. Git documents these mechanisms; the implementation must prove semantic equivalence for its supported policy rather than equating “ignore child scans” with “ignore child changes.” [S7]

Do not globally rewrite Git configuration, enable filesystem monitors, switch index formats, or disable untracked reporting on the user's behalf. Optional acceleration is capability-tested, explicit, and reversible. Disable expensive history, rename similarity analysis, and object retrieval in the branch fast path.

### 11.5 Cache and consistency model

Each observed field includes its value, scope, observation time, validity state, and generation. Repository identity records the checkout root, Git directory, common directory, parent relationships, and observed format capabilities. Cache misses and cache corruption rebuild metadata without touching working files.

Watch `.gitmodules`, relevant index/ref/operation metadata through resolved paths, and working-tree changes. Respect shared watch topology rather than creating redundant recursive watchers for every ancestor and child. Git internal directory watches may legitimately lie outside the workspace; resolve and authorize them rather than blindly following arbitrary paths.

A result produced for an older generation must not overwrite newer state. Reconcile after focus regain, completed writes, watcher overflow, storage reconnect, and discovered topology changes. Under continuous churn, mark a changing observation rather than claiming a cross-repository atomic snapshot.

### 11.6 Linked-worktree boundary

Support opening existing linked worktrees independently and keep their state distinct. Do not promise that creating or moving additional worktrees of a submodule-bearing superproject is safe: Git's current worktree documentation explicitly warns that submodule support is incomplete. Such management remains outside v1. [S8]

## 12. Security, privacy, and execution policy

**SEC-01 — Local-first default.** Opening, browsing, editing, status, and locally available history work without an account or network. No telemetry, ads, experiments, remote assets, silent updates, model downloads, or provider requests on open. User-requested Git operations and update checks are separate, visible exceptions. Partial-clone lazy fetching must not bypass this policy.

**SEC-02 — Preserve trust boundaries.** Retain an explicit workspace trust model instead of removing it as “IDE baggage.” Untrusted workspaces permit non-executing inspection only. Do not run tasks, hooks, configured executable helpers, content filters, or workspace-specified commands merely to render a file or diff. Workspace Trust exists specifically to limit automatic execution from unfamiliar code. [S9]

**SEC-03 — Git execution audit.** Inventory every read and write path for potential command execution. For passive diffs disable external diff drivers and text conversion. Audit fsmonitor hooks, filters, pagers, credential helpers, environment overrides, and object-fetch behavior. Git documents external diff/textconv controls and hook-based fsmonitor configuration. [S10, S11] A sanitized safe read path is a release gate; absence of an integrated terminal is not a security sandbox.

**SEC-04 — Safe invocation.** Use argument arrays, validated paths, explicit repository context, and pathspec-safe handling; never interpolate filenames into shell commands. Preserve Git ownership/safe-directory protections rather than automatically disabling them. Treat control characters in names and output as display data.

**SEC-05 — Sensitive data.** Store credentials through existing Git/OS mechanisms, not plaintext application settings. Redact remote URL credentials, sensitive paths where requested, environment values, and source content from diagnostic exports by default. Unsaved-buffer recovery and discard backups may contain code: protect them with user-only permissions, bounded retention, and an explicit clear action. Deleting a disposable cache must not delete unsaved work.

**SEC-06 — Updates and supply chain.** Publish dependency inventories and notices, verify update authenticity, and test rollback. Updates are explicitly checked or separately opted into; never restart during dirty buffers or active writes. Track upstream editor/Electron security fixes even when feature updates are unwanted.

## 13. Compatibility, packaging, and maintenance

Use a distinct product identity, executable name, application data directory, URI/IPC identity, and update channel. Installing Minv alongside VS Code must not overwrite VS Code settings, registrations, or extensions. Migration is explicit and limited to supported preferences.

Code-OSS source is MIT-licensed; Microsoft's branded VS Code distribution and Marketplace access are separate. Base the fork on source, retain required notices, replace product branding/assets as necessary, and review each bundled dependency or extension independently. Do not depend on access to the Microsoft Marketplace. [S2]

Define and publish the supported Git/OS matrix at the feasibility exit. Exercise ordinary repositories, nested submodules, detached and unborn HEAD, alternate ref/object formats supported by that Git matrix, sparse checkouts, shallow/partial clones, non-ASCII paths, long paths, symlinks, and external Git directories. Unsupported combinations fail clearly without mutating a repository to make it compatible.

Pin the upstream base commit. Maintain a reviewed feature allowlist, removal manifest, and patch inventory. Every upstream rebase runs scope, network, performance, and correctness tests. New upstream functionality is excluded until deliberately accepted. Security refreshes must not be blocked indefinitely by deep customization; track rebase effort as a maintenance health metric.

## 14. Acceptance and verification matrix

| Test | Scenario | Required outcome |
|---|---|---|
| AT-01: Original pain point | Warm-open R64 and immediately locate a specific submodule. | Meets launch/branch budgets; branch query is not dependent on unrelated status; existing rows do not move. |
| AT-02: Fresh catalog | Remove product cache and open R64. | Known declarations appear within budget; missing checkouts are represented; no deep source crawl is required for declared submodules. |
| AT-03: Cache truthfulness | Switch branches externally while app is closed, then reopen. | Cached branch is marked unverified and replaced by the actual result; stale data is not presented as fresh. |
| AT-04: Slow/broken sibling | Delay or fail one repository's status command. | Other branch queries, navigation, editing, and status continue; failure stays scoped. |
| AT-05: Submodule semantics | Exercise child dirty/untracked files, changed child HEAD, and staged parent gitlink independently and together. | Child and parent states match intended Git comparisons; no hidden or double-counted state. |
| AT-06: External churn | Run the defined sustained external-write workload, including renames and checkout changes. | Input stays responsive; queues remain bounded; active results converge and indicate uncertainty correctly. |
| AT-07: Dirty-buffer race | Modify the same file externally while it has unsaved edits. | Neither version is silently lost; save requires reconciliation when necessary. |
| AT-08: Git-operation race | Change HEAD, index, or a selected hunk before staging/commit. | Stale operation is rejected or re-prepared visibly; writes are not silently retargeted. |
| AT-09: Watch failure | Inject event loss, overflow, reconnect, and watcher resource exhaustion. | Data becomes stale, fallback is bounded, and explicit refresh restores correct state. |
| AT-10: Path/storage edge cases | Test duplicate names, gitfiles, external Git dirs, worktrees, Unicode, spaces, leading dashes, and symlink cycles. | Correct checkout identity, safe arguments, no loop, no cross-repo leakage. |
| AT-11: Removal audit | Inspect build dependency graph, service registrations, UI, commands, workers, and network traffic. | No functional AI, debug, execution, or provider integrations ship or activate; no restoration through settings. |
| AT-12: Offline/untrusted | Open local repositories with networking blocked and malicious executable-helper fixtures. | Local inspection works where safely supported; no automatic remote requests or repository-defined execution. |
| AT-13: Git failures | Simulate missing Git, old Git, locks, auth failure, hook failure, signing failure, and uncertain cancellation. | Scoped explanation, no automatic lock deletion, no blind write retry, preserved drafts/buffers. |
| AT-14: Accessibility | Complete branch lookup, diff review, staging, and commit with keyboard and screen reader. | All actions reachable; state announced without focus loss or refresh floods. |
| AT-15: Product coexistence | Install beside VS Code and repeatedly invoke the CLI. | No configuration overwrite, duplicate observers, account dependency, or extension migration. |
| AT-16: Scale/recovery | Open R256/LARGE1, corrupt disposable cache, crash/restart, and open a very large text file. | Bounded resource behavior, preserved user work, clear degraded modes, no silent truncation. |

AT-01 through AT-16 are release gates for applicable supported configurations. Run differential Git-state tests against the configured Git executable after quiescence, not against a single simplistic status string or a global snapshot while files are changing.

## 15. Delivery milestones and release gates

### M0 — Baseline and removal feasibility

Capture an upstream trace and reproduce the reported workflow on a supplied real workspace when available. Build R64, R256, and LARGE1 generators. Prove branch/status independence in a focused prototype; map product contributions and dependency removal. Select the supported Git matrix and reference hardware.

**Exit:** measured prototype results, a feasible removal plan, explicit security/trust strategy, and a written decision on any target that needs revision. No claim that the user's 13 seconds has been explained without a trace.

### M1 — Read-first internal alpha

Ship the stripped shell, persistent catalog, stable repository browser, fast branch lookup, lazy file explorer, text editor, external-change handling, search, and read-only diffs. Add local traces and safe passive Git observation.

**Exit:** original branch journey passes; excluded services do not activate; a broken repository cannot block the workspace. Git writes may remain unavailable in this milestone, clearly labeled.

### M2 — Code-management beta

Add complete layered status, correct submodule aggregation, staging/hunks, commits, basic branch/stash operations, conflict editing, generic remote operations, local history, and CLI handoff. Complete concurrency and recovery testing.

**Exit:** all P0 functional and safety requirements pass on the first target platform; no silent-loss defect remains open.

### M3 — Supported release

Complete packaging, side-by-side installation, accessibility, updater verification, dependency notices, performance automation, and upstream rebase checks. Run real-workspace usability sessions focused on branch lookup, review, and safe intervention.

**Exit:** all applicable acceptance tests pass, the supported-platform matrix is explicit, and measured results are published with fixture definitions. Additional OS builds ship only after their own gates; they are not assumed supported by code portability alone.

No calendar or staffing estimate is asserted here. Milestones are dependency-ordered scope and evidence gates.

## 16. Success metrics and product guardrails

The primary metric is **end-to-end time to a verified answer for the selected repository**, including opening the application. Secondary measures are repository-row stability, input responsiveness during external writes, selected-diff latency, complete status convergence, and idle resource use.

Measure usability with direct tasks: locate a named submodule and report its branch; identify a changed child pointer separately from dirty files; stage one hunk without unrelated content; handle an external-edit conflict without data loss. Compare task completion and error rates against the same user's existing workflow, not a fabricated market-wide baseline.

Performance and correctness data come from CI benchmarks and explicit local test sessions. Do not make telemetry a prerequisite to product decisions. Optional submitted diagnostics are opt-in and redacted.

Feature count, installed extensions, AI engagement, and time spent inside the app are not success metrics. A successful session may last only a few seconds because the user obtained an answer and returned to their primary tool.

## 17. Risks and mitigation

| Risk | Mitigation / decision rule |
|---|---|
| Deep upstream coupling makes removal costly | Prove a product contribution allowlist at M0; keep an audited small patch surface and minimal inert compatibility adapters only where justified. |
| Deleting features does not fix Git latency | Trace queueing, subprocess, IO, and rendering separately; repository architecture has its own acceptance gates. |
| Fast cached UI appears correct when stale | Field-level freshness, invalidation generations, focus reconciliation, and write preconditions. |
| Concurrent tools change files between checks | Preserve dirty buffers; revalidate writes; use Git locks; document residual races and refuse unsafe actions rather than promising global atomicity. |
| Nested submodule aggregation diverges from Git semantics | Differential fixtures for each parent/child state and ignore policy; no blanket “clean” shortcut. |
| Watcher exhaustion or platform differences | Shared coverage, bounded queues, explicit degraded state, platform-specific tests, and measured fallback behavior. |
| Extension support reintroduces IDE/AI scope | No arbitrary executable extension support in v1; declarative customization only after review. |
| Thin client loses essential text operations | Keep reliable editing, diffing, search, encoding, recovery, accessibility, and conflict handling; remove authoring automation, not basic usability. |
| Partial clones cause surprise network requests | Disable implicit retrieval in observation paths; label missing objects and require explicit fetch permission. |
| Linked worktrees plus submodules exceed Git guarantees | Support independent inspection; defer risky worktree lifecycle management and document the boundary. |
| Fork falls behind security fixes | Track upstream security updates independently from features; automate build and scope regression tests. |
| Naming cannot be used safely | Complete trademark/domain/package/CLI checks for Minv before branding a release. |

## 18. Decision register

### Fixed by the brief

The product is named Minv and is a Code-OSS-based thin code-management client. Its pillars are a text editor, file browser, and Git client. Large workspaces with dozens of submodules are the priority. Built-in AI, debugging, and GitHub integration are removed. External AI tooling remains external. The initial motivating regression is a 13-second repository-panel load with layout movement.

### Proposed baseline decisions

Linux-first delivery; no integrated terminal, arbitrary extensions, or language servers in v1; generic Git remotes retained; no account or telemetry requirement; no automatic fetch; advanced history rewriting and worktree/submodule lifecycle operations deferred. These decisions narrow scope without preventing existing external tools from continuing their work.

### Evidence required before implementation commitments

Validate actual startup bottlenecks, removal dependency boundaries, Git version/format support, platform budgets, passive-command safety, and memory costs. Choose concrete cache technology and worker implementation only after the prototype demonstrates the required behavior. The selected name is Minv; name clearance and distribution identifiers remain to be verified.

**Definition of done:** the user opens a large workspace, immediately finds the repository they care about, sees trustworthy branch and change information without a moving layout, safely reviews or adjusts the code, and returns to their existing tools—without an assistant, debugger, or hosting platform competing for attention.

## 19. Technical source notes

Sources were checked on October 5, 2026. They support external implementation constraints and Git semantics; the requirements, priorities, budgets, naming judgments, and design choices in this PRD are proposals. Mutable upstream pages are not a pinned implementation baseline; M0 must record exact upstream commits and Git versions.

**S1. Microsoft — Source Code Organization.** Core layers, workbench contributions, built-in extensions, and runtime boundaries.  
https://github.com/microsoft/vscode/wiki/source-code-organization

**S2. Microsoft — Visual Studio Code FAQ.** Code-OSS versus the branded distribution, licensing, and Marketplace restrictions.  
https://code.visualstudio.com/docs/supporting/faq

**S3. Git — git-symbolic-ref.** Inspecting symbolic refs and distinguishing detached HEAD.  
https://git-scm.com/docs/git-symbolic-ref

**S4. Git — gitmodules.** Declared submodule paths and branch-update configuration.  
https://git-scm.com/docs/gitmodules

**S5. Git — gitsubmodules.** Submodule repositories, gitlinks, and on-disk relationships.  
https://git-scm.com/docs/gitsubmodules

**S6. Git — git-rev-parse.** Repository, gitfile, common-directory, and path resolution.  
https://git-scm.com/docs/git-rev-parse

**S7. Git — git-status.** Machine-readable status, submodule-ignore modes, untracked behavior, and optional-lock guidance for background refresh.  
https://git-scm.com/docs/git-status

**S8. Git — git-worktree.** Linked-worktree behavior and documented submodule limitations.  
https://git-scm.com/docs/git-worktree

**S9. Microsoft — Workspace Trust.** Restricted-mode execution boundaries for unfamiliar workspaces.  
https://code.visualstudio.com/docs/editing/workspaces/workspace-trust

**S10. Git — git-diff.** External diff drivers, text conversion, and comparison behavior.  
https://git-scm.com/docs/git-diff

**S11. Git — git-config.** Executable fsmonitor hooks, configuration behavior, and acceleration options.  
https://git-scm.com/docs/git-config
