# Desktop packaging and CLI

The standalone target is Linux x64. Packaging creates a portable directory and a tar archive under `build/release/minv-<version>-linux-x64`. Windows and macOS are not shipping targets of this packaging script. Git and ordinary Linux desktop system libraries must be installed separately; the release includes Electron and does not require system Node.js.

## Build and inspect

Use installed project tooling:

```sh
npm run desktop:build
node scripts/package-desktop.mjs
node scripts/package-desktop.mjs --audit build/release/minv-0.1.0-linux-x64
```

The application build provides `build/desktop/app`, the main/preload/bootstrap/renderer esbuild graphs in `build/desktop/bundle-meta.json`, and source/output hashes in `build/desktop/build-provenance.json`. Packaging rejects changes made after the build. The editor must have passed `scripts/editor-audit.mjs`; packaging verifies its output hashes, pinned upstream commit and retained notices. Missing or inconsistent reports fail packaging.

The release includes:

- The `minv` Electron application and `bin/minv` command launcher.
- The custom Minv shell and source-built Code-OSS editor, with source provenance and removal audit.
- Minv's desktop registration and scalable icon in `share/`.
- Minv, Electron, Chromium/Node.js, Code-OSS, editor dependency and font license notices.
- `dependencies.json`, `source-provenance.json`, `package-audit.json` and `SHA256SUMS`.

The packaging allowlist excludes the stock workbench, extension host, marketplace, provider integrations, agent/chat implementations, debug adapters, terminal/PTY host and remote server. Application executables besides Electron's required sandbox/crashpad helpers and the CLI wrapper are the source-audited `minv-git-sandbox` helper used to confine passive Git reads and pinned Linux x64 `rg` for local text search. Git itself is not bundled. Passive inspection and deliberate user-requested Git mutations still require separate execution/security tests.

Search ships the Linux x64 binary from exact `@vscode/ripgrep-universal@1.18.0`: ripgrep 15.0.0, revision `3a612f88b8`, with PCRE2 10.45. `product/notices/ripgrep/sources.json` records upstream license URLs/hashes and a conservative Cargo.lock dependency notice inventory; crate archives were verified against Cargo.lock checksums before their notices were retained. The Linux package copies these notices under `resources/app/native/notices/`. The inventory intentionally includes build/other-platform dependencies; it does not claim every listed crate is linked in the Linux binary.

No development dependencies, Electron default application, test harnesses, fixtures or source maps belong in the release. Syntax grammars and language configuration JSON are inert editor data; they are retained without the executable extensions they originated from. Main/preload/renderer/editor dependency graphs are audited separately from Chromium's bundled engine dependencies. A clean package audit is evidence about the product contents; it does not establish runtime network behavior, accessibility, responsiveness or human usability.

## Run and optionally install for one user

Extract the archive and run its `bin/minv` launcher. The directory may be moved as a unit. Its launcher resolves its real location, including when invoked through a symlink:

```sh
/absolute/path/to/minv-0.1.0-linux-x64/bin/minv /path/to/workspace
```

For a per-user installation, put a symlink to that `bin/minv` on your PATH, copy `share/applications/minv.desktop` to `~/.local/share/applications/`, and copy its icon to `~/.local/share/icons/hicolor/scalable/apps/minv.svg`. The desktop file invokes the launcher with a desktop-launch marker, so the launcher must be available on the graphical session's PATH. With no selected files, a desktop launch restores the previous workspace; a terminal invocation with no operands opens the terminal's current directory. Installation is an explicit user step; the build never changes system registrations or VS Code settings.

Linux must permit Chromium's user-namespace sandbox, or an administrator must provide a correctly installed Chromium sandbox helper. Minv does not automatically disable sandboxing or install a setuid helper. Application settings and recovery belong to the Minv application identity; this package does not migrate VS Code profiles or extensions.

## Command line

```sh
minv /path/to/workspace
minv --repo /path/to/repository
minv --goto 'src/example.ts:42:5'
minv --diff before.txt after.txt
minv --wait --goto 'src/example.ts:42'
minv --reuse-window another-file.txt
minv --new-window /path/to/other-workspace
minv -- ./-a-file-starting-with-a-dash
minv --help
minv --version
```

No arguments opens the current directory. Reuse is the default. `--wait` requires explicit files, `--goto` or a diff and waits for the requested buffers to close. Positions are one-based positive integers. Arguments are passed directly to the process, without shell interpolation. Windows drive and UNC paths are parsed without interpreting the drive colon as a position separator; Windows packaging still requires a separate platform gate.

For development, after building, use `node scripts/minv.mjs [arguments]`. The launcher uses the locally installed Electron package and never downloads a package or falls back to a stock VS Code executable.

### Main-process integration contract

`parseCli(argv, cwd)` in `src/core/cli.ts` returns a help/version request or a launch request with absolute `roots`, `files`, optional `repository`, optional `diff`, and `wait`/`reuseWindow`/`newWindow` flags. `rootsExplicit` is true only for explicit positional directories or `--repo`; an inferred cwd root is false, allowing main to reuse the current workspace for file-only requests already inside it. `MINV_LAUNCH_CWD` preserves the launching shell's directory for forwarded requests. Main is responsible for validating file/repository authorization, reusing the intended workspace and opening positions/diffs.

For wait requests, the launcher creates a private owner-only `minv-wait-*` directory under the OS temporary directory. `MINV_WAIT_FILE` identifies its `closed` file and `MINV_WAIT_TOKEN` is a random 256-bit token. Main obtains a validated ticket with `cliWaitTicket()` and includes the request, launching cwd and ticket in Electron's `requestSingleInstanceLock` additional data so an existing instance can fulfill it. The primary instance retains the ticket until every buffer for that request closes, then calls `signalCliWait(ticket)`. Do not acknowledge on save, focus change or successful forwarding alone.

The acknowledgement exclusively creates a token file: it validates directory ownership/privacy, rejects symlinks and never overwrites existing files. The launcher verifies the token, removes only its own acknowledgement and empty directory, and exits. It also cleans up on Ctrl+C/termination. A failed GUI process exits the wait with an error. A successful forwarding process can exit while the original instance continues to hold the request. Main reports a failed open with `signalCliWait(ticket, errorMessage)`, which causes the launcher to exit unsuccessfully; a successful close acknowledgement must not hide an open error.

## Reproducibility, verification and release status

The tar archive sorts entries, normalizes numeric owners to zero and uses `SOURCE_DATE_EPOCH` for timestamps (default zero). Given identical app, dependency and native-helper inputs, this removes incidental file timestamps and user ownership from the archive. Reproducibility across toolchain/OS versions is not claimed. Source/build changes require rebuilding and rerunning the audits.

Verify the archive against its adjacent `.sha256` file, then verify the extracted directory:

```sh
sha256sum -c minv-0.1.0-linux-x64.tar.gz.sha256
cd minv-0.1.0-linux-x64
sha256sum -c SHA256SUMS
```

SHA-256 detects corruption against a trusted manifest; an unsigned manifest does not authenticate the publisher. There is no built-in updater or automatic update check. An update is a deliberate verified replacement of the application directory, preserving the separate Minv user-data directory. Signed release distribution, updater verification if an updater is introduced, trademark/domain/package/executable-name clearance, and all applicable PRD acceptance gates remain explicit release requirements. Producing an archive alone does not certify them.
