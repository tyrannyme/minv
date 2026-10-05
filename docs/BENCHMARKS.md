# Reproducible fixtures and process benchmarks

The harness measures core catalog and metadata APIs. It does **not** measure a
painted branch, usable window, input responsiveness, row geometry, or launch
latency. A passing test or a low percentile here does not pass a PRD release gate.

```sh
npm run build
node scripts/fixture.mjs --profile smoke --output /tmp/minv-smoke-new
node scripts/bench.mjs --fixture /tmp/minv-smoke-new --iterations 30 --json /tmp/minv-results-new.json
```

The output directory must not exist, and its parent must exist. With no `--output`,
the generator creates a fresh temporary directory and prints its location. It
never removes a fixture or reuses an existing directory. Interrupted generation
leaves a partial directory for manual inspection; choose a new path to retry.
The benchmark also refuses to overwrite its JSON report. Remove fixtures yourself
when finished. All operations use local Git and argument arrays; generation never
fetches a submodule URL. The desktop prototype requires Git 2.48 or newer for documented no-lazy-fetch support; compact catalog enumeration itself requires Git 2.38 or newer. Catalog discovery
uses compact mode/path index enumeration with a 32 MiB output bound; LARGE1's
generated paths keep this enumeration below that bound. Discovery errors fail
the benchmark instead of silently reducing the measured catalog.

## Fixture definitions

| Profile | Available workspace checkouts | Tracked regular files | Ignored files | Untracked files | Modified tracked files |
| --- | ---: | ---: | ---: | ---: | ---: |
| smoke (default) | 8 | 256 | 128 | 24 | 16 across 4 repositories |
| R64 | 64 | 200,000 | 1,000,000 | 2,000 | 1,000 across 16 repositories |
| R256 | 256 | 1,000,000 | 0 | 2,000 | 1,000 across 16 repositories |
| LARGE1 | 1 | 500,000 | 0 | 100 | 100 in one repository |

Large profiles are explicit opt-ins. They can consume many gigabytes of storage
and over a million inodes despite small file contents. Check available storage
before generating them. Example:

```sh
node scripts/fixture.mjs --profile R64 --output /path/on/reference-disk/minv-r64-new
```

Each fixture's `fixture.json` records counts and relative paths. Available counts
exclude the separate unborn companion. Catalog counts include two uninitialized
entries for smoke and three for R64/R256; LARGE1 has none. Thus R64 contains 64
available workspace checkouts and 67 workspace catalog entries, plus one unborn
standalone companion at `unborn-companion`. Benchmark roots exclude that companion.

For R64/R256, repository 1 is a direct child of the root; repositories 2–13 are
children of repository 1; repositories 14–17 are children of repository 2. Remaining
repositories are direct children of the root. This provides 16 nested submodule
relationships and depth three below the superproject. Smoke uses the beginning of
the same layout. Children use independent embedded `.git` directories, which Git
supports, rather than absorbed gitfiles. Gitfile/worktree coverage belongs in core
correctness tests, not this scale fixture.

The fixed seed is `20261005`. Contents derive from that seed, repository ordinal,
and file ordinal; no random or network input is used. Data files occupy groups of
128 files per directory. Tracked data starts at 128 bytes per file, ignored data
at 32 bytes, and untracked data at 64 bytes; modified data is replaced by a short
deterministic line. Tracked regular-file totals include `.gitignore` and applicable
`.gitmodules`, and exclude gitlinks. `/generated/` is ignored. Counts distribute
evenly across repositories except tracked modifications, which are confined to
the first stated number of repositories. `.gitmodules` URLs use `fixture.invalid`
and deliberately wrong tracking-branch names to catch branch-source confusion.

Each available repository has two baseline commits with a fixed author, committer,
and timestamp. The root adds a commit recording unavailable gitlinks. The last
child advances by one empty commit, becomes detached, and has its new gitlink
staged in its immediate parent. Other checkouts use named branches. An additional
standalone checkout has an unborn branch. Initialization uses empty templates,
disabled signing, fsmonitor and line-ending conversion, SHA-1 object format, and
ignores inherited Git environment overrides and global/system Git configuration.
Repository hashes may differ across Git versions;
compare fixtures only with their recorded Git version/configuration.

R256 and LARGE1 do not include the R64 million-ignored-file workload because the
PRD gives those profiles only tracked-file and checkout counts. The smoke profile
is intentionally much smaller and is not a substitute for R64. These generators
do not create external churn, shallow/partial clones, corrupt repositories,
alternate reference formats, permission failures, or network filesystems.

## Measurement boundary and interpretation

The default run has 30 repetitions and emits all samples plus nearest-rank p50,
p95, and worst-case milliseconds. Use `--iterations 1` for a smoke run; it is not
a statistically meaningful performance result. Measurements include API queueing
and awaited subprocess completion inside the current Node process:

- Declared catalog discovery, without using a persisted catalog.
- Loading a prewritten catalog, with no UI rendering.
- Reading one known checkout's branch.
- Reading all available checkout branches.
- Reading the selected branch while a sibling `readStatus` is held at its
  GitRunner boundary. The status gate is released only after the branch returns.
  This detects service coupling but does not simulate subprocess saturation.

There is no full-status barrier before the branch measurements. The held-status
scenario performs a real status after release. Catalog cardinality is checked
against the fixture manifest, so missing repositories cannot improve timings
silently. Missing expected checkouts, unreadable declarations, and invalid manifest
roots fail the run; the benchmark does not audit every generated data file.

Results record OS/kernel, Node and Git versions, CPU model and count, total memory,
filesystem type and block size, and process CPU/RSS/IO counters. CPU, RSS and IO
cover the benchmark Node process only, excluding Git children and Electron. IO
counters are filesystem blocks, not source bytes. Max RSS is a process lifetime
high-water mark, not a sampled application aggregate. Storage model and security
software must be recorded manually on a controlled runner.

Filesystem caches are uncontrolled and warmed by setup. Repeating the core API
does not mean warm application reopen. The harness never drops OS caches, launches
an upstream baseline, or claims a cold-disk test. PRD acceptance still needs
instrumented end-to-end application measurements, 30 controlled repetitions,
aggregate process resources, UI stability/accessibility evidence, and separately
documented reference hardware for each supported operating system.

## Recorded smoke run

[Raw 30-sample report](benchmarks/smoke-process-only-linux.json), October 5, 2026:
Linux x64, Ryzen 9 7900X, 24 logical CPUs, approximately 62 GiB RAM, Node 24.18.0,
Git 2.55.0. The fixture was on **tmpfs**, verified with `findmnt`; this is not the
NVMe reference runner. Other development work was active. These numbers describe
the eight-checkout smoke fixture only; R64, R256 and LARGE1 were not measured.

| API/process metric | p50 (ms) | p95 (ms) | Worst (ms) |
| --- | ---: | ---: | ---: |
| Catalog discovery | 59.11 | 66.06 | 77.84 |
| Saved catalog read | 0.22 | 0.36 | 0.37 |
| Selected branch | 3.91 | 5.13 | 5.45 |
| All eight branches | 28.35 | 31.10 | 32.42 |
| Selected branch with sibling status held | 3.91 | 4.98 | 5.82 |

All 30 branch requests completed before the injected sibling status gate was
released. No application rendering or launch duration was measured, and no PRD
budget is marked passed by this report.
