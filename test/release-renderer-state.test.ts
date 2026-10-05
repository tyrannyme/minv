import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '../desktop/renderer/src/app';
import { Store, type Sheet } from '../desktop/renderer/src/state';
import type { EditorHandle, MinvHost } from '../desktop/renderer/src/contract';

function fixture(t: test.TestContext, recoveryFails = false) {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = original; });
  const calls: { method: string; input: any }[] = [];
  const host = {
    on: () => () => {},
    invoke: async (method: string, input: unknown) => {
      calls.push({ method, input });
      if (method === 'fs.recover' && recoveryFails) throw new Error('Recovery disk full');
      if (method === 'fs.read') return { kind: 'text', text: 'external text', version: 'external-version', encoding: 'utf8', bom: false, eol: 'lf', size: 13, large: false };
      return undefined;
    },
  } as MinvHost;
  const store = new Store(); const app = new App(host, undefined, store);
  const sheet: Sheet = { id: 'sheet', kind: 'file', repositoryId: 'repo', path: 'file.txt', title: 'file.txt', dirty: true };
  store.state.sheets.push(sheet); store.state.activeSheet = sheet.id;
  let text = 'unsaved text typed just now'; let disposed = false;
  const handle = { getText: () => text, setText: (value: string) => { text = value; }, dispose: () => { disposed = true; } } as EditorHandle;
  app.files.set(sheet.id, { content: { kind: 'text', text: 'old disk text', version: 'old-version', encoding: 'utf8', bom: false, eol: 'lf', size: 13, large: false }, handle, dirty: true, loading: false });
  app.confirm = async () => true;
  return { app, sheet, calls, text: () => text, disposed: () => disposed };
}

test('closing a dirty tab flushes its latest draft before disposing the buffer', async t => {
  const f = fixture(t);
  await f.app.closeSheet(f.sheet.id);
  assert.equal(f.calls.find(call => call.method === 'fs.recover')?.input.text, 'unsaved text typed just now');
  assert.equal(f.disposed(), true);
});

test('failed recovery prevents closing or replacing dirty text', async t => {
  const f = fixture(t, true);
  await f.app.closeSheet(f.sheet.id).catch(() => false);
  assert.equal(f.disposed(), false, 'dirty editor disposed after recovery failed');
  assert.equal(f.app.state.sheets.length, 1);
  await f.app.takeDisk(f.sheet).catch(() => undefined);
  assert.equal(f.text(), 'unsaved text typed just now', 'disk reload overwrote an unpersisted buffer');
});

test('taking the disk version flushes the exact dirty buffer before replacement', async t => {
  const f = fixture(t);
  await f.app.takeDisk(f.sheet);
  const recoveryIndex = f.calls.findIndex(call => call.method === 'fs.recover');
  const readIndex = f.calls.findIndex(call => call.method === 'fs.read');
  assert.ok(recoveryIndex >= 0 && recoveryIndex < readIndex);
  assert.equal(f.calls[recoveryIndex]!.input.text, 'unsaved text typed just now');
  assert.equal(f.text(), 'external text');
});
