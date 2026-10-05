<h1 align="center"><img alt="" src="media/brand/minv.svg" width="64"><br>Minv</h1>

<p align="center">VS Code, cut down to what you open it for.<br><a href="https://minv.tyranny.me"><b>minv.tyranny.me</b></a></p>

<p align="center">
  <a href="https://github.com/tyrannyme/minv/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/tyrannyme/minv/ci.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=dark"><img alt="CI status" src="https://shieldcn.dev/github/tyrannyme/minv/ci.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=light"></picture></a>
  <a href="https://github.com/tyrannyme/minv/releases"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/tyrannyme/minv/release.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=dark"><img alt="Latest release" src="https://shieldcn.dev/github/tyrannyme/minv/release.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=light"></picture></a>
  <a href="fork/upstream.json"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/Code--OSS-1.137.0.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=dark"><img alt="Based on Code-OSS 1.137.0" src="https://shieldcn.dev/badge/Code--OSS-1.137.0.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=light"></picture></a>
  <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/license-MIT.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=dark"><img alt="MIT license" src="https://shieldcn.dev/badge/license-MIT.svg?variant=outline&amp;size=sm&amp;font=geist&amp;mode=light"></picture></a>
</p>

<p align="center"><img alt="Minv with Source Control open: every submodule's branch in the Repositories list, the parent's changes and graph, and a README beside its rendered preview" src="docs/readme-assets/minv.png"></p>

When your agents do the work, you still open an editor now and then: to read a file, look at the changes, commit, check which branch a submodule is on, or read and edit a README. Minv is VS Code with everything else taken out, so it opens fast and stays quiet.

**What's in it:** the Explorer, Quick Open, search, the editor, the integrated terminal, and Source Control with VS Code's own Git (staging, commits, branches, push and pull, the graph). It also renders Markdown previews. Every submodule's branch shows in the Repositories list, and all 48 submodules of a large workspace open by default.

**What's taken out:** debugging, testing, AI chat, agents and the Agents window, inline completions, the integrated browser, accounts and settings sync, remote development, the extension marketplace, notebooks, language servers, welcome pages and surveys. There's no telemetry.

## Install

Download `minv-<version>-linux-x64.tar.gz` from [Releases](https://github.com/tyrannyme/minv/releases), check it against its `.sha256`, extract it anywhere, and run:

```sh
minv-<version>-linux-x64/bin/minv /path/to/workspace
```

Linux x64 only for now, about 180 MB to download. You need Git installed. Minv keeps its settings in `~/.config/Minv` and `~/.minv`, separate from VS Code's, and it's a development build: unsigned, with no auto-update.

## Build

You need Node.js 24.18.0, Git, a C/C++ toolchain, and the X11 keyboard, libsecret and Kerberos development headers (`libxkbfile-devel libsecret-devel krb5-devel` on Fedora, `libxkbfile-dev libsecret-1-dev libkrb5-dev` on Debian and Ubuntu).

```sh
npm run setup      # fetch the pinned Code-OSS source, apply Minv's changes, install its dependencies
npm run compile    # development build
npm start -- /path/to/workspace
npm run build      # minified app in .upstream/VSCode-linux-x64
npm run package    # build/release/minv-<version>-linux-x64.tar.gz
```

`npm run capture -- <workspace> out.png --app=.upstream/VSCode-linux-x64/minv` opens the app in a private Xvfb display and screenshots it, so nothing appears on your desktop. It can also click rows, press keys and type (`--click`, `--keys`, `--type`).

The landing page lives in [`site/`](site). Deploy it with `cd site && wrangler deploy`.

## How the fork works

Minv's changes to Code-OSS live in [`fork/`](fork). [`scripts/fork-prepare.mjs`](scripts/fork-prepare.mjs) applies them to a pristine checkout of the pinned upstream commit every time, so the fork never drifts:

| File | What it changes |
| --- | --- |
| [`fork/upstream.json`](fork/upstream.json) | The exact Code-OSS commit Minv is built from |
| [`fork/strip.json`](fork/strip.json) | Workbench features that aren't registered |
| [`fork/extensions-remove.json`](fork/extensions-remove.json) | Built-in extensions that aren't shipped |
| [`fork/product.json`](fork/product.json) | Name, data folders, and default settings |
| [`fork/extensions/minv-theme`](fork/extensions/minv-theme) | Minv Dark and Minv Light |
| [`fork/overlay`](fork/overlay) | Icons and the bundled Instrument Sans and Commit Mono fonts |
| [`fork/patches`](fork/patches) | Small source and build patches, each one commented |

VS Code's chat and MCP services stay registered, though nothing uses them, because Tasks and the terminal depend on them. `chat.disableAIFeatures` is on, and every AI view, extension and the Agents window are removed.

Pushing a tag `v<version>` that matches `package.json` builds, smoke-tests and publishes a release.

## License

[MIT](LICENSE). Minv is built from Microsoft's MIT-licensed [Code-OSS](https://github.com/microsoft/vscode) source, not from the Visual Studio Code product, and doesn't use the Visual Studio Marketplace. The bundled fonts are under the SIL Open Font License.
