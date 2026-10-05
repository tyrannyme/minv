import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceFiles } from '../src/core/files';
import { WorkspaceSearch } from '../src/core/search';

async function fixture(t:test.TestContext) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'minv-search-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'root');await fs.mkdir(root);await fs.mkdir(path.join(root,'.git'));
  await fs.writeFile(path.join(root,'.gitignore'),'ignored.txt\n');
  await fs.writeFile(path.join(root,'first.txt'),'Hello needle\nUnicode 🦊 needle\na+b\naab\n');
  await fs.writeFile(path.join(root,'ignored.txt'),'ignored needle\n');
  await fs.writeFile(path.join(root,'.hidden'),'hidden needle\n');
  await fs.writeFile(path.join(root,'.git','secret'),'metadata needle\n');
  const files=await WorkspaceFiles.create({roots:[root],recoveryDirectory:path.join(directory,'recovery')});
  return {files,search:new WorkspaceSearch(files),directory,root,id:files.roots[0]!.id};
}

test('plain/regex search scopes and UTF-16 columns remain correct',async t=>{
  const f=await fixture(t);const result=await f.search.search({query:'needle'});
  assert.equal(result.complete,true);assert.equal(result.errors.length,0);assert.equal(result.matches.length,2);
  assert.deepEqual(result.matches.map(match=>[match.path,match.line,match.column]),[['first.txt',1,6],['first.txt',2,11]]);
  const plain=await f.search.search({query:'a+b'});assert.equal(plain.matches.length,1);assert.equal(plain.matches[0]!.line,3);
  const regex=await f.search.search({query:'a+b',regex:true});assert.equal(regex.matches.length,1);assert.equal(regex.matches[0]!.line,4);
});

test('ignore and hidden toggles are separate and never expose Git metadata',async t=>{
  const f=await fixture(t);
  const ignored=await f.search.search({query:'needle',includeIgnored:true});assert.equal(ignored.matches.length,3);
  const hidden=await f.search.search({query:'needle',includeHidden:true});assert.equal(hidden.matches.length,3);
  const both=await f.search.search({query:'needle',includeIgnored:true,includeHidden:true});assert.equal(both.matches.length,4);
  assert.ok(both.matches.every(match=>!match.path.startsWith('.git/')));
  const excluded=await f.search.search({query:'needle',includeIgnored:true,exclude:['ignored.txt']});assert.equal(excluded.matches.length,2);
});

test('match caps honestly report partial results',async t=>{
  const f=await fixture(t);const limited=await f.search.search({query:'needle',maxResults:1});assert.equal(limited.matches.length,1);assert.equal(limited.complete,false);assert.equal(limited.cancelled,false);
});

test('search respects explicit files and refuses symlink scopes',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'sub'));await fs.writeFile(path.join(f.root,'sub','second.txt'),'needle');
  const scoped=await f.search.search({query:'needle',paths:[{rootId:f.id,path:'sub'}]});assert.deepEqual(scoped.matches.map(match=>match.path),['sub/second.txt']);
  const outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret'),'needle');await fs.symlink(outside,path.join(f.root,'escape'));
  const all=await f.search.search({query:'needle',includeIgnored:true,includeHidden:true});assert.ok(all.matches.every(match=>!match.path.includes('escape')));
  await assert.rejects(f.search.search({query:'needle',paths:[{rootId:f.id,path:'escape'}]}));
});

test('filename discovery streams batches, follows ignore policy and marks bounded output',async t=>{
  const f=await fixture(t);const batches:unknown[]=[];
  const names=await f.search.findFiles({query:'txt'},batch=>batches.push(batch));assert.deepEqual(names.files.map(file=>file.path),['first.txt']);assert.equal(batches.length,1);
  const all=await f.search.findFiles({includeIgnored:true,includeHidden:true});assert.ok(all.files.some(file=>file.path==='ignored.txt'));assert.ok(!all.files.some(file=>file.path.startsWith('.git/')));
  const limited=await f.search.findFiles({includeIgnored:true,maxResults:1});assert.equal(limited.files.length,1);assert.equal(limited.complete,false);
});

test('invalid regex and missing ripgrep surface errors without clean results',async t=>{
  const f=await fixture(t);const invalid=await f.search.search({query:'(',regex:true});assert.equal(invalid.complete,false);assert.ok(invalid.errors.length);
  const unavailable=new WorkspaceSearch(f.files,{rgPath:path.join(f.directory,'missing-rg')});const result=await unavailable.search({query:'needle'});assert.equal(result.complete,false);assert.ok(result.errors.length);
});

test('search cancellation ends read subprocesses and distinguishes cancelled from complete',async t=>{
  const f=await fixture(t);const cancelled=new AbortController();cancelled.abort();
  const early=await f.search.search({query:'needle',signal:cancelled.signal});assert.equal(early.cancelled,true);assert.equal(early.complete,false);
  const slow=path.join(f.directory,'slow-rg');await fs.writeFile(slow,'#!/usr/bin/env node\nsetInterval(()=>{},1000);\n',{mode:0o755});
  const active=new AbortController();const timer=setTimeout(()=>active.abort(),50);t.after(()=>clearTimeout(timer));
  const started=Date.now();const result=await new WorkspaceSearch(f.files,{rgPath:slow}).findFiles({signal:active.signal});assert.equal(result.cancelled,true);assert.equal(result.complete,false);assert.ok(Date.now()-started<5000);
});
