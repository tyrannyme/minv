import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceFiles, FileBoundaryError, FileConflictError, type FileDocument } from '../src/core/files';

async function fixture(t: test.TestContext, options: { maxTextBytes?: number; largeTextBytes?: number } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'minv-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace'); const recoveryDirectory = path.join(directory, 'recovery');
  await fs.mkdir(root);
  const files = await WorkspaceFiles.create({ roots: [root], recoveryDirectory, ...options });
  return { files, root, recoveryDirectory, directory, id: files.roots[0]!.id };
}
function text(document: FileDocument): asserts document is Extract<FileDocument, {kind:'text'}> { assert.equal(document.kind, 'text'); }

test('text reads and saves preserve BOM, UTF-16 encoding, CRLF and executable mode', async t => {
  const f = await fixture(t);
  for (const encoding of ['utf8', 'utf16le', 'utf16be'] as const) {
    const name = encoding + '.txt';
    let bytes = Buffer.from('hello\r\nworld\r\n', encoding === 'utf8' ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    bytes = Buffer.concat([Buffer.from(encoding === 'utf8' ? [239,187,191] : encoding === 'utf16le' ? [255,254] : [254,255]), bytes]);
    await fs.writeFile(path.join(f.root, name), bytes, {mode:0o755});
    const opened = await f.files.read(f.id, name); text(opened);
    assert.equal(opened.encoding, encoding); assert.equal(opened.bom, true); assert.equal(opened.eol, 'crlf');
    const saved = await f.files.save({rootId:f.id,path:name,text:opened.text.replace('world','there'),encoding:opened.encoding,bom:opened.bom,expectedFingerprint:opened.fingerprint}); text(saved);
    assert.equal(saved.text, 'hello\r\nthere\r\n'); assert.equal(saved.encoding, encoding); assert.equal(saved.eol,'crlf');
    assert.equal((await fs.stat(path.join(f.root,name))).mode & 0o777, 0o755);
  }
  assert.equal((await f.files.backups()).length,3);
});

test('external edits and deleted files reject stale saves and preserve user buffer', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root,'file'),'original');
  const original = await f.files.read(f.id,'file'); text(original);
  const request={rootId:f.id,path:'file',text:'my dirty edit',encoding:original.encoding,bom:original.bom,expectedFingerprint:original.fingerprint};
  await fs.writeFile(path.join(f.root,'file'),'external');
  await assert.rejects(f.files.save(request),FileConflictError);
  assert.equal(await fs.readFile(path.join(f.root,'file'),'utf8'),'external');
  await fs.unlink(path.join(f.root,'file'));
  await assert.rejects(f.files.save(request),FileConflictError);
  assert.equal(request.text,'my dirty edit');
});

test('an external edit during save preparation survives the final fingerprint check', async t => {
  const f = await fixture(t); const absolute = path.join(f.root, 'file');
  await fs.writeFile(absolute, 'original');
  const original = await f.files.read(f.id, 'file'); text(original);
  const mutableFs = require('node:fs/promises') as typeof fs;
  const originalOpen = mutableFs.open;
  let raced = false;
  mutableFs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(path.join(f.root, '.minv-save-'))) {
      raced = true;
      await fs.writeFile(absolute, 'external edit during save');
    }
    return handle;
  };
  try {
    await assert.rejects(f.files.save({ rootId: f.id, path: 'file', text: 'dirty buffer', encoding: original.encoding, bom: original.bom, expectedFingerprint: original.fingerprint }), FileConflictError);
  } finally { mutableFs.open = originalOpen; }
  assert.equal(raced, true);
  assert.equal(await fs.readFile(absolute, 'utf8'), 'external edit during save');
  assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.minv-save-')));
});

test('binary, invalid UTF-8 and over-limit files never return truncated editable text', async t => {
  const f=await fixture(t,{maxTextBytes:100,largeTextBytes:10});
  for (const [name,bytes,kind] of [['binary',Buffer.from([0,1,2]),'binary'],['invalid',Buffer.from([0xff,0x87]),'binary'],['too-large',Buffer.alloc(101,65),'large']] as const) {
    await fs.writeFile(path.join(f.root,name),bytes); const value=await f.files.read(f.id,name);
    assert.equal(value.kind,kind); assert.ok(!('text' in value)); assert.equal(value.size,bytes.length);
  }
  await fs.writeFile(path.join(f.root,'medium'),'this is more than ten');
  const medium=await f.files.read(f.id,'medium');text(medium);assert.equal(medium.large,true);
});

test('lazy listing excludes Git metadata and never traverses directory links', async t => {
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'nested'));await fs.mkdir(path.join(f.root,'.git'));
  await fs.writeFile(path.join(f.root,'show.txt'),'shown');await fs.writeFile(path.join(f.root,'hide.log'),'hidden');
  await fs.symlink(f.root,path.join(f.root,'cycle'));
  const listing=await f.files.list(f.id,'',{exclude:['*.log']});
  assert.deepEqual(listing.entries.map(entry=>entry.name),['nested','cycle','show.txt']);
  assert.equal(listing.entries.find(entry=>entry.name==='cycle')?.kind,'symlink');
  await assert.rejects(f.files.list(f.id,'cycle'),FileBoundaryError);
  assert.equal((await f.files.list(f.id,'',{limit:1})).complete,false);
});

test('outside roots, metadata and symlink escapes are refused for reads and creates', async t => {
  const f=await fixture(t); const outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret'),'secret');
  await fs.symlink(outside,path.join(f.root,'escape'));await fs.mkdir(path.join(f.root,'.git'));
  for (const relative of ['../outside/secret','escape/secret','.git/config']) {
    await assert.rejects(f.files.read(f.id,relative),FileBoundaryError);
    await assert.rejects(f.files.createFile(f.id,relative,'new'),FileBoundaryError);
  }
  await assert.rejects(f.files.read('unknown','file'),FileBoundaryError);
  assert.equal(await fs.readFile(path.join(outside,'secret'),'utf8'),'secret');
});

test('dirty recovery survives service restart and original file deletion', async t => {
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'file'),'base');const opened=await f.files.read(f.id,'file');text(opened);
  await f.files.recover({documentId:opened.id,rootId:f.id,path:'file',text:'unsaved\r\n',encoding:'utf8',bom:false,expectedFingerprint:opened.fingerprint});
  await fs.unlink(path.join(f.root,'file'));
  const reopened=await WorkspaceFiles.create({roots:[f.root],recoveryDirectory:f.recoveryDirectory});
  const drafts=await reopened.recoveries();assert.equal(drafts.length,1);assert.equal(drafts[0]!.text,'unsaved\r\n');assert.equal(drafts[0]!.documentId,opened.id);
  await reopened.removeRecovery(opened.id);assert.deepEqual(await reopened.recoveries(),[]);
});

test('recoverable delete retains bytes and restoration refuses an existing destination', async t => {
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'file'),'original');const opened=await f.files.read(f.id,'file');
  const backup=await f.files.deleteFile(f.id,'file',opened.fingerprint);
  await assert.rejects(fs.access(path.join(f.root,'file')));
  await fs.writeFile(path.join(f.root,'file'),'replacement');
  await assert.rejects(f.files.restoreBackup(backup.id));assert.equal(await fs.readFile(path.join(f.root,'file'),'utf8'),'replacement');
  await fs.unlink(path.join(f.root,'file'));const restored=await f.files.restoreBackup(backup.id);text(restored);assert.equal(restored.text,'original');
});

test('exclusive creates and file transfer never replace existing files',async t=>{
  const f=await fixture(t);await f.files.createDirectory(f.id,'folder');await f.files.createFile(f.id,'folder/new','first');
  await assert.rejects(f.files.createFile(f.id,'folder/new','second'));
  const copy=await f.files.prepareTransfer('copy',f.id,'folder/new',f.id,'copy');await f.files.transfer(copy.token);
  assert.equal(await fs.readFile(path.join(f.root,'copy'),'utf8'),'first');
  const colliding=await f.files.prepareTransfer('move',f.id,'folder/new',f.id,'copy');await assert.rejects(f.files.transfer(colliding.token));
  assert.equal(await fs.readFile(path.join(f.root,'folder/new'),'utf8'),'first');
});

test('nested repository and workspace transfer scopes require explicit confirmation',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'child'));await fs.writeFile(path.join(f.root,'file'),'content');
  await f.files.setRepositoryRoots([f.root,path.join(f.root,'child')]);
  const move=await f.files.prepareTransfer('move',f.id,'file',f.id,'child/moved');assert.equal(move.requiresConfirmation,true);
  await assert.rejects(f.files.transfer(move.token),FileBoundaryError);
  const result=await f.files.transfer(move.token,true);text(result);assert.equal(result.text,'content');
  await assert.rejects(fs.access(path.join(f.root,'file')));
  assert.equal((await f.files.backups()).length,1);
});

test('prepared transfers reject source changes and directory deletion is never recursive',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'file'),'base');const plan=await f.files.prepareTransfer('move',f.id,'file',f.id,'moved');
  await fs.writeFile(path.join(f.root,'file'),'external');await assert.rejects(f.files.transfer(plan.token),FileConflictError);
  await fs.mkdir(path.join(f.root,'folder'));await assert.rejects(f.files.deleteFile(f.id,'folder','anything'),FileBoundaryError);
});

test('bounded recovery refuses growth without evicting dirty drafts and supports explicit clearing',async t=>{
  const f=await fixture(t);const bounded=await WorkspaceFiles.create({roots:[f.root],recoveryDirectory:f.recoveryDirectory,maxRecoveryBytes:10000,maxRecoveryRecords:1,maxTextBytes:100});
  const draft={documentId:'one',rootId:f.id,path:'deleted.txt',text:'unsaved work',encoding:'utf8' as const,bom:false,expectedFingerprint:'old'};
  await bounded.recover(draft);
  await assert.rejects(bounded.recover({...draft,documentId:'two'}),/storage is full/);
  await assert.rejects(bounded.recover({...draft,text:'x'.repeat(201)}),/exceeds/);
  assert.deepEqual((await bounded.recoveries()).map(item=>[item.documentId,item.text]),[['one','unsaved work']]);
  await bounded.removeRecovery('one');await bounded.recover({...draft,documentId:'two'});assert.equal((await bounded.recoveries())[0]!.documentId,'two');
});
