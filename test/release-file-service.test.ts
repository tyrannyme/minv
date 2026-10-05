import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceFiles } from '../src/core/files';
import { WorkspaceSearch } from '../src/core/search';
import { FileService } from '../desktop/main/file-service';
import type { Repository } from '../src/core/types';
import type { HostMethods, SearchProgress } from '../desktop/renderer/src/contract';

async function fixture(t:test.TestContext) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'minv-file-service-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'workspace');await fs.mkdir(root);await fs.mkdir(path.join(root,'child'));
  await fs.writeFile(path.join(root,'file.txt'),'parent needle\r\n');await fs.writeFile(path.join(root,'child','child.txt'),'child needle\n');
  const repositories:Repository[]=[{id:'parent',root,name:'parent',available:true},{id:'child',root:path.join(root,'child'),name:'child',parentId:'parent',available:true},{id:'outside',root:directory,name:'ancestor',available:true}];
  const files=await WorkspaceFiles.create({roots:[root],repositoryRoots:[root,path.join(root,'child')],recoveryDirectory:path.join(directory,'recovery')});
  const events:{event:string;payload:any}[]=[];const tracked=new Map<string,string>();let trusted=true;let approved=false;let confirmations=0;
  const service=new FileService({files,search:new WorkspaceSearch(files),getRepository(id){const repo=repositories.find(item=>item.id===id);if(!repo)throw new Error('Unknown');return repo;},getRepositories:()=>repositories.filter(repo=>repo.id!=='outside'),isTrusted:()=>trusted,confirm:async()=>{confirmations++;return approved;},emit:(event,payload)=>events.push({event,payload}),trackFile:(key,absolute)=>tracked.set(key,absolute)});
  t.after(()=>service.dispose());
  const invoke=async<M extends keyof HostMethods>(method:M,input:HostMethods[M][0]):Promise<HostMethods[M][1]>=>await (service.handlers[method] as (input:HostMethods[M][0])=>Promise<HostMethods[M][1]>)(input);
  return {directory,root,files,service,events,tracked,invoke,setTrust:(value:boolean)=>{trusted=value;},approve:(value:boolean)=>{approved=value;},confirmations:()=>confirmations};
}
async function finished(events:{event:string;payload:any}[],id:string):Promise<SearchProgress[]> {
  for(let attempts=0;attempts<100;attempts++){const progress=events.filter(item=>item.event==='search.progress'&&item.payload.searchId===id).map(item=>item.payload as SearchProgress);if(progress.some(item=>item.done))return progress;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Search did not finish');
}

test('host file adapter rejects unknown repositories and outside ancestor rows; passive reads work untrusted',async t=>{
  const f=await fixture(t);
  for(const repositoryId of ['unknown','outside'])await assert.rejects(f.invoke('fs.read',{repositoryId,path:'file.txt'}),{code:'boundary'});
  await assert.rejects(f.invoke('fs.read',{repositoryId:'parent',path:'../outside'}),{code:'boundary'});
  f.setTrust(false);const read=await f.invoke('fs.read',{repositoryId:'parent',path:'file.txt'});assert.equal(read.kind,'text');
  await assert.rejects(f.invoke('fs.createFile',{repositoryId:'parent',path:'new'}),{code:'untrusted'});
});

test('host save uses server encoding and rejects externally stale buffers',async t=>{
  const f=await fixture(t);const opened=await f.invoke('fs.read',{repositoryId:'parent',path:'file.txt'});assert.equal(opened.kind,'text');
  const request={repositoryId:'parent',path:'file.txt',text:'dirty',encoding:'utf8' as const,bom:false,baseVersion:opened.version};
  await assert.rejects(f.invoke('fs.write',{...request,encoding:'utf16le'}),{code:'boundary'});
  await fs.writeFile(path.join(f.root,'file.txt'),'external');await assert.rejects(f.invoke('fs.write',request),{code:'conflict'});
  assert.equal(await fs.readFile(path.join(f.root,'file.txt'),'utf8'),'external');
});

test('legacy replacement cannot bypass native confirmation and retains disk backup when approved',async t=>{
  const f=await fixture(t);const opened=await f.invoke('fs.read',{repositoryId:'parent',path:'file.txt'});
  await fs.writeFile(path.join(f.root,'file.txt'),'external');
  const request={repositoryId:'parent',path:'file.txt',text:'my buffer',encoding:'utf8' as const,bom:false,baseVersion:opened.version,overwrite:true};
  await assert.rejects(f.invoke('fs.write',request),{code:'cancelled'});assert.equal(f.confirmations(),1);assert.equal(await fs.readFile(path.join(f.root,'file.txt'),'utf8'),'external');
  f.approve(true);await f.invoke('fs.write',request);assert.equal(await fs.readFile(path.join(f.root,'file.txt'),'utf8'),'my buffer');assert.equal((await f.files.backups()).length,1);
});

test('external change notifications preserve dirty save bases and recovery drafts',async t=>{
  const f=await fixture(t);const opened=await f.invoke('fs.read',{repositoryId:'parent',path:'file.txt'});const key=[...f.tracked.keys()][0]!;
  await fs.writeFile(path.join(f.root,'file.txt'),'external');await f.service.onFileChanged(key);
  assert.ok(f.events.some(item=>item.event==='file.changed'&&item.payload.version!==opened.version));
  await f.invoke('fs.read',{repositoryId:'parent',path:'file.txt'});
  await f.invoke('fs.recover',{documentId:'tab-1',repositoryId:'parent',path:'file.txt',text:'old dirty buffer',encoding:'utf8',bom:false,baseVersion:opened.version});
  const draft=await f.invoke('fs.readRecovery',{documentId:'tab-1'});assert.equal(draft.text,'old dirty buffer');assert.equal(draft.baseVersion,opened.version);
  await fs.unlink(path.join(f.root,'file.txt'));await f.service.onFileChanged(key);assert.ok(f.events.some(item=>item.event==='file.changed'&&item.payload.deleted));
});

test('scoped search emits repository ownership, correct columns and completion; parent scope excludes child repos',async t=>{
  const f=await fixture(t);
  const selected=await f.invoke('search.start',{query:'needle',regex:false,caseSensitive:false,scope:['child'],includeIgnored:false});
  const progress=await finished(f.events,selected.searchId);assert.equal(progress.at(-1)!.complete,true);assert.deepEqual(progress.flatMap(item=>item.matches).map(match=>[match.repositoryId,match.path,match.column]),[['child','child.txt',7]]);
  const parent=await f.invoke('search.start',{query:'needle',regex:false,caseSensitive:false,scope:['parent'],includeIgnored:false});
  const parentProgress=await finished(f.events,parent.searchId);assert.deepEqual(parentProgress.flatMap(item=>item.matches).map(match=>match.path),['file.txt']);
  const all=await f.invoke('search.start',{query:'needle',regex:false,caseSensitive:false,scope:[],includeIgnored:false});
  const allProgress=await finished(f.events,all.searchId);assert.equal(allProgress.flatMap(item=>item.matches).length,2);
});

test('search cancellation is explicit and result events remain incomplete',async t=>{
  const f=await fixture(t);const started=await f.invoke('search.start',{query:'needle',regex:false,caseSensitive:false,scope:['parent'],includeIgnored:false});await f.invoke('search.cancel',{searchId:started.searchId});
  const progress=await finished(f.events,started.searchId);assert.equal(progress.at(-1)!.complete,false);assert.match(progress.at(-1)!.note!,/cancelled/);
});

test('recoverable discard restores tracked index bytes and removes only reviewed untracked files',async t=>{
  const f=await fixture(t);
  const { execFile }=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
  const {prepareWrite}=await import('../src/core/status');
  const run=async(args:string[])=>exec('git',args,{cwd:f.root});
  await run(['init','-q']);await run(['config','user.name','Minv Test']);await run(['config','user.email','minv@example.invalid']);
  await run(['add','file.txt']);await run(['commit','-qm','base']);
  await fs.writeFile(path.join(f.root,'file.txt'),'discarded working bytes');await fs.writeFile(path.join(f.root,'loose.txt'),'untracked backup bytes');
  const repository:Repository={id:'parent',root:f.root,name:'parent',gitDir:path.join(f.root,'.git'),available:true};
  const git={async run(cwd:string,args:readonly string[]){try{const result=await exec('git',[...args],{cwd});return {stdout:result.stdout,stderr:result.stderr,exitCode:0};}catch(error){const e=error as {stdout?:string;stderr?:string;code?:number};return {stdout:e.stdout??'',stderr:e.stderr??'',exitCode:typeof e.code==='number'?e.code:1};}}};
  const reviewed=await prepareWrite(repository,git);
  let consumed=false;
  const service=new FileService({files:f.files,search:new WorkspaceSearch(f.files),git,getRepository:()=>repository,getRepositories:()=>[repository],isTrusted:()=>true,confirm:async()=>true,emit:()=>{},trackFile:()=>{},consumeGitReview(id,token,action,paths){assert.equal(id,'parent');assert.equal(token,'review');assert.equal(action,'discard');assert.deepEqual(paths,['file.txt','loose.txt']);assert.equal(consumed,false);consumed=true;return reviewed;}});
  t.after(()=>service.dispose());
  const result=await service.handlers['git.discard']!({repositoryId:'parent',paths:['file.txt','loose.txt'],token:'review',confirmed:true});
  assert.equal(await fs.readFile(path.join(f.root,'file.txt'),'utf8'),'parent needle\r\n');
  await assert.rejects(fs.access(path.join(f.root,'loose.txt')));
  assert.ok(result.backupIds.length>=2);
  const backupContent=await Promise.all(result.backupIds.map(id=>fs.readFile(path.join(f.directory,'recovery',id+'.backup'),'utf8')));
  assert.ok(backupContent.includes('discarded working bytes'));assert.ok(backupContent.includes('untracked backup bytes'));
});

test('a native delete confirmation cannot outlive workspace trust',async t=>{
  const f=await fixture(t);let trusted=true;const repo:Repository={id:'parent',root:f.root,name:'parent',available:true};
  const service=new FileService({files:f.files,search:new WorkspaceSearch(f.files),getRepository:()=>repo,isTrusted:()=>trusted,confirm:async()=>{trusted=false;return true;},emit:()=>{},trackFile:()=>{}});t.after(()=>service.dispose());
  const read=await service.handlers['fs.read']!({repositoryId:'parent',path:'file.txt'});
  await assert.rejects(async()=>service.handlers['fs.delete']!({repositoryId:'parent',path:'file.txt',version:read.version}),{code:'untrusted'});
  assert.equal(await fs.readFile(path.join(f.root,'file.txt'),'utf8'),'parent needle\r\n');
});

test('explicit browse-only rows support non-Git folders without authorizing catalog ancestors',async t=>{
  const f=await fixture(t);const pseudo:Repository={id:'plain',root:f.root,name:'folder',available:false};
  const service=new FileService({files:f.files,search:new WorkspaceSearch(f.files),getRepository:id=>({...pseudo,id,root:id==='ancestor'?f.directory:f.root}),getRepositories:()=>[pseudo],canBrowseRepository:()=>true,isTrusted:()=>false,confirm:async()=>false,emit:()=>{},trackFile:()=>{}});t.after(()=>service.dispose());
  const result=await service.handlers['fs.read']!({repositoryId:'plain',path:'file.txt'});assert.equal(result.kind,'text');
  await assert.rejects(async()=>service.handlers['fs.read']!({repositoryId:'ancestor',path:'workspace/file.txt'}),{code:'boundary'});
});
