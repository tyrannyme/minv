# Git runtime

The supported confinement target is Linux x64 with Git 2.48 or newer, Landlock ABI 6 or newer (Linux 6.12+), and seccomp user notifications enabled. The current host is Linux 7.1 with Git 2.55.0. Unsupported kernels or missing confinement fail closed; Minv does not silently run passive commands outside its sandbox. Other operating systems have not passed this gate.

## Build and deployment

Run `node scripts/sandbox-build.mjs` when building Minv. It uses the system C compiler and Linux headers to produce `dist/native/minv-git-sandbox`. Package that executable alongside the compiled application. There is no downloaded native dependency or runtime compiler requirement.

`src/core/sandbox.ts` resolves the machine's Git executable and invokes the application-owned launcher. Passive Git executables must be native ELF binaries; shell/Node wrappers are rejected. The optional `sandboxExecutable` constructor argument exists for application packaging and injected test transports. It must never be populated from a workspace-controlled setting. Scheduler unit fixtures replace the launcher deliberately; separate adversarial tests exercise the actual compiled launcher.

## Kernel-enforced read boundary

The native launcher opens the Git binary before creating the confined child. It permits execution of that inode and its ELF interpreter under Landlock, and denies file-content writes, truncation, creation, deletion, and link/rename operations. `/dev/null` is the sole filesystem write exception. Ordinary read permissions and Git's ownership/safe-directory checks remain in effect. Additional seccomp rules deny inode metadata mutation: permission/ownership changes, timestamps, extended attributes, and all child ioctl calls (including regular-file flag changes such as `chattr`). The supervision process remains outside that filter so it can service seccomp notifications.

A seccomp notification supervisor permits exactly one execution: its single-threaded launcher's initial `execveat` of the already-open Git inode. It never authorizes a pathname read from an untrusted process. Every later `execve` or `execveat` attempt is denied, including shell filters, alternate Git binaries, credential helpers, pagers, and self-execution. Socket creation, socketpair creation, and connection attempts are denied. The pre-created private supervision channel closes before Git starts. Landlock additionally scopes signals and abstract Unix sockets, and seccomp denies process-memory inspection, namespace/mount changes, keyring upcalls, and io_uring creation.

The policy persists across descendants. A helper or socket denial makes the launcher return exit code 125 even if Git would otherwise ignore that failure and return success. The caller therefore cannot publish the resulting output as a complete clean observation. Setup failures return 126. Deadlines and cancellation terminate the supervised process group.

This closes the previous configuration-inventory race. Minv no longer inventories filter names and disables those names in a later process. A filter inserted while a read is starting still cannot execute because the kernel boundary is independent of configuration and attribute contents.

## Git behavior inside confinement

Inherited `GIT_*`, `LD_*`, `GCONV_PATH`, and `GLIBC_TUNABLES` overrides are removed. Passive invocations also disable optional index locks, prompts, pagers, filesystem-monitor hooks, hooks, signature verification, external diff, text conversion, and transport protocols. `GIT_NO_LAZY_FETCH=1` prevents missing promisor objects from initiating retrieval; the kernel execution/network boundary remains effective if repository configuration attempts to override transport settings.

Built-in Git attribute behavior, including text/line-ending normalization, remains enabled. Executable content filters are **not replaced with an identity transformation**. If Git needs an external clean/process filter to determine status or produce a diff, that read explicitly fails as unsupported. A filter-dependent state cannot safely be calculated without executing repository code, and Minv does not label an approximate raw comparison as equivalent. Reads that need no executable filter retain ordinary Git semantics.

Parent status and diffs use `--ignore-submodules=dirty`. Parent rows describe their own files and gitlink pointer changes; child dirtiness belongs to the child's independently observed row. Diff/history presentation forces `--submodule=short`; explicit recursive submodule reads are rejected. Opening a workspace never initializes or updates submodules.

Confined local inspection is suitable for untrusted workspaces on this Linux target. Mutations and explicitly requested network operations still require the application's trust and confirmation rules. Trusted writes run through ordinary Git and preserve configured hooks, signing, content filters, credential helpers, and Git safeguards. Read-only confinement must not be applied to them.

## Scheduling and diagnostics

Four process slots are reserved for metadata (discovery and branch reads). Four additional slots serve foreground and background work. Waiting background work receives a turn after at most three newly dispatched foreground requests. Identical concurrent reads without cancellation signals share their result; the queue holds at most 2,048 pending requests.

Writes serialize by canonical common-directory path, including linked worktrees. An already-running local write ignores UI cancellation and continues when the runner is disposed. Explicit fetch/push cancellation is supported only when the caller supplies `cancelActiveWrite` with a cancellation signal. A write interrupted by explicit network cancellation, a deadline, or an output cap reports an uncertain outcome and must be inspected before retrying. Default deadlines are 30 seconds for reads and 120 seconds for writes. Output defaults to a 16 MiB cap; compact catalog index enumeration explicitly requests 32 MiB.

The optional `onCommand` callback reports command name, scheduling lane, measured queue duration, process duration, exit code, and output byte count. It does not include arguments, checkout paths, environment, or source content. Callback failures do not alter Git results.

## Evidence and limits

Runtime tests cover late filter injection, static fsmonitor/textconv/external-diff fixtures, native executable denial, file-write denial, socket denial, missing promisor objects with a hostile remote configuration, built-in normalization equivalence, inherited-environment injection, scheduling, cancellation, limits, and trusted hook preservation. Independent release-sandbox tests cover additional Unix socket and inode-metadata attacks. Real Git operation tests exercise hunk staging, branch/stash/history workflows, and explicit remote operations.

The boundary depends on the Linux kernel, installed Git binary, dynamic loader/system libraries, and this application-owned native launcher. It does not claim to protect against a compromised kernel or malicious application executable. Supporting additional OSes, broader kernel versions, or script-based Git wrappers requires a separately implemented and verified equivalent boundary.

Primary references: [Linux Landlock ABI and scope](https://docs.kernel.org/userspace-api/landlock.html), [Linux seccomp filtering and notifications](https://docs.kernel.org/userspace-api/seccomp_filter.html), and [Git 2.48's lazy-fetch controls](https://git-scm.com/docs/git/2.48.0.html).
