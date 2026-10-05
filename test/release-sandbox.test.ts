import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Git } from '../src/core/git';

const execute = promisify(execFile);
const sandbox = path.resolve(__dirname, '../native/minv-git-sandbox');

test('passive Linux confinement blocks inode metadata changes, new sockets and secondary exec', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'minv-release-sandbox-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'adversary.c');
  const executable = path.join(temporary, 'adversary');
  const victim = path.join(temporary, 'victim');
  await writeFile(victim, 'unchanged\n', { mode: 0o600 });
  await writeFile(source, `#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3) return 90;
  if (!strcmp(argv[1], "metadata")) {
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) return 91;
    struct timespec times[2] = {{1, 0}, {1, 0}};
    int first = chmod(argv[2], 0777), second = fchmod(fd, 0777);
    int third = utimensat(AT_FDCWD, argv[2], times, 0);
    int fourth = setxattr(argv[2], "user.minv-review", "changed", 7, 0);
    int flags = FS_NODUMP_FL;
    int fifth = ioctl(fd, FS_IOC_SETFLAGS, &flags);
    printf("%d %d %d %d %d\\n", first, second, third, fourth, fifth);
    close(fd); return 0;
  }
  if (!strcmp(argv[1], "socketpair")) {
    int pair[2]; int result = socketpair(AF_UNIX, SOCK_DGRAM, 0, pair);
    printf("%d\\n", result); return 0;
  }
  if (!strcmp(argv[1], "exec")) {
    execl("/usr/bin/true", "true", NULL);
    printf("denied %d\\n", errno); return 0;
  }
  return 92;
}
`);
  await execute(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', executable]);
  const before = await stat(victim);
  const metadata = await execute(sandbox, [executable, 'metadata', victim]);
  assert.equal(metadata.stdout.trim(), '-1 -1 -1 -1 -1');
  const after = await stat(victim);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(victim, 'utf8'), 'unchanged\n');
  for (const operation of ['socketpair', 'exec']) {
    await assert.rejects(execute(sandbox, [executable, operation, victim]), (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      return failure.code === 125 && /blocked executable helper or network/.test(failure.stderr ?? '');
    });
  }
});

test('a filter introduced after an earlier passive read cannot execute during later status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minv-release-filter-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = async (...args: string[]) => execute('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
  await raw('init', '-q', '-b', 'main');
  await raw('config', 'user.name', 'Minv release review');
  await raw('config', 'user.email', 'review@example.invalid');
  await raw('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(root, '.gitattributes'), 'file.txt filter=late\n');
  await writeFile(path.join(root, 'file.txt'), 'before\n');
  await raw('add', '.');
  await raw('commit', '-qm', 'initial');
  const git = new Git();
  t.after(() => git.dispose());
  assert.equal((await git.run(root, ['status', '--porcelain=v2'])).exitCode, 0);
  await raw('config', 'filter.late.clean', 'printf executed > helper-executed; cat');
  // Same length is essential: status must hash content instead of trusting size.
  await writeFile(path.join(root, 'file.txt'), 'change\n');
  const response = await git.run(root, ['status', '--porcelain=v2']);
  assert.equal(response.exitCode, 125);
  assert.match(response.stderr, /blocked executable helper/);
  await assert.rejects(stat(path.join(root, 'helper-executed')), { code: 'ENOENT' });
});
