#!/usr/bin/env node
// Packs the built app into build/release. Linux (.upstream/VSCode-linux-x64): minv-linux-x64.tar.gz, .deb, .rpm and
// .AppImage (needs appimagetool on PATH or in $APPIMAGETOOL).
// Windows (.upstream/VSCode-win32-x64): minv-win32-x64-setup.exe, a per-user installer, and minv-win32-x64.zip.
// Asset names carry no version, so https://github.com/tyrannyme/minv/releases/latest/download/<asset> always points
// at the newest release. Pass formats to build only some: node scripts/fork-package.mjs tar rpm
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.upstream/build');
const windows = process.platform === 'win32';
const built = join(root, windows ? '.upstream/VSCode-win32-x64' : '.upstream/VSCode-linux-x64');
if (!existsSync(join(built, windows ? 'Minv.exe' : 'minv'))) throw new Error('Build the app first: npm run build');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const formats = process.argv.slice(2).length ? process.argv.slice(2) : windows ? ['exe', 'zip'] : ['tar', 'deb', 'rpm', 'appimage'];
const release = join(root, 'build/release');
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
cpSync(join(root, 'LICENSE'), join(built, 'LICENSE-minv.txt'));

const gulp = task => execFileSync('npm', ['run', '--silent', 'gulp', task], { cwd: source, stdio: 'inherit', shell: windows, env: { ...process.env, MINV_VERSION: version } });
const only = (dir, extension) => {
  const files = readdirSync(dir).filter(name => name.endsWith(extension));
  if (files.length !== 1) throw new Error(`Expected one ${extension} in ${dir}, found: ${files.join(', ') || 'none'}`);
  return join(dir, files[0]);
};
// Sorted, root-owned and stamped with the commit time, so the same build packs to the same bytes.
const mtime = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim();

for (const format of formats) {
  if (format === 'tar') {
    execSync(`set -o pipefail; tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@${mtime} --transform='flags=r;s|^VSCode-linux-x64|minv-linux-x64|' -cf - -C .upstream VSCode-linux-x64 | gzip -9n > build/release/minv-linux-x64.tar.gz`, { cwd: root, shell: '/bin/bash' });
  } else if (format === 'deb') {
    gulp('vscode-linux-x64-prepare-deb');
    gulp('vscode-linux-x64-build-deb');
    copyFileSync(only(join(source, '.build/linux/deb/amd64/deb'), '.deb'), join(release, 'minv-linux-x64.deb'));
  } else if (format === 'rpm') {
    gulp('vscode-linux-x64-prepare-rpm');
    gulp('vscode-linux-x64-build-rpm');
    copyFileSync(only(join(source, '.build/linux/rpm/x86_64'), '.rpm'), join(release, 'minv-linux-x64.rpm'));
  } else if (format === 'appimage') {
    const appDir = join(source, '.build/linux/appimage/Minv.AppDir');
    rmSync(dirname(appDir), { recursive: true, force: true });
    cpSync(built, join(appDir, 'usr/share/minv'), { recursive: true, verbatimSymlinks: true });
    copyFileSync(join(root, 'fork/overlay/resources/linux/code.png'), join(appDir, 'minv.png'));
    writeFileSync(join(appDir, 'minv.desktop'), '[Desktop Entry]\nName=Minv\nComment=Read, review and commit\nGenericName=Text Editor\nExec=minv %F\nIcon=minv\nType=Application\nStartupWMClass=Minv\nCategories=TextEditor;Development;\nKeywords=editor;git;markdown;vscode;\n');
    // AppRun starts Electron directly: the bin/minv CLI hands off and exits, which would unmount the AppImage. An
    // AppImage can't carry the setuid chrome-sandbox, so without unprivileged user namespaces it runs unsandboxed.
    writeFileSync(join(appDir, 'AppRun'), `#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
# Ubuntu 24.04+ lets unshare succeed but blocks Chromium's namespace sandbox through AppArmor.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ] && unshare -Ur true 2>/dev/null; then
  exec "$here/usr/share/minv/minv" "$@"
fi
exec "$here/usr/share/minv/minv" --no-sandbox "$@"
`);
    chmodSync(join(appDir, 'AppRun'), 0o755);
    execFileSync(process.env.APPIMAGETOOL ?? 'appimagetool', ['--no-appstream', appDir, join(release, 'minv-linux-x64.AppImage')], { stdio: 'inherit', env: { ...process.env, ARCH: 'x86_64' } });
  } else if (format === 'exe') {
    gulp('vscode-win32-x64-inno-updater');
    gulp('vscode-win32-x64-user-setup');
    copyFileSync(only(join(source, '.build/win32-x64/user-setup'), '.exe'), join(release, 'minv-win32-x64-setup.exe'));
  } else if (format === 'zip') {
    // Windows' own bsdtar (not Git Bash's GNU tar) writes a zip when the name ends in .zip; -s renames the top folder.
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', join(release, 'minv-win32-x64.zip'), '-s', ',^VSCode-win32-x64,minv-win32-x64,', '-C', '.upstream', 'VSCode-win32-x64'], { cwd: root, stdio: 'inherit' });
  } else {
    throw new Error(`Unknown format ${format}; use tar, deb, rpm, appimage, exe or zip.`);
  }
}

console.log(`Minv ${version}\n${readdirSync(release).join('\n')}`);
