import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PluginHost } from '../../src/plugins/host.js';
import { fixturePackage, pluginFixture } from './fixture.js';

test('third-party packages install, configure, stop, resume, update bytes, retain data, uninstall and restart', async t=>{
  const fixture=await pluginFixture(t),source=await fixturePackage(fixture.root,{frozen:true});
  const initial=await fixture.host.install(source);assert.equal(initial.status,'active');assert.equal(initial.version,'0.1.0');
  assert.equal((await fixture.host.configure('fixture',{message:'configured'})).configuration.message,'configured');
  let provider=fixture.host.entries('metadata')[0].providers[0];
  assert.equal((await provider.getMetadata({Type:'Movie'})).Item.Name,'configured');
  await fixture.host.setEnabled('fixture',false);assert.deepEqual(fixture.host.entries('metadata'),[]);
  assert.throws(()=>provider.getMetadata({Type:'Movie'}),{status:503});
  await fixture.reopen();assert.equal(fixture.host.get('fixture').status,'disabled');
  await fixture.host.setEnabled('fixture',true);
  const replacement=await fixturePackage(fixture.root,{label:'replacement'});
  const updated=await fixture.host.update('fixture',replacement);assert.notEqual(updated.digest,initial.digest);
  assert.equal(updated.version,initial.version);assert.equal(updated.configuration.message,'configured');
  assert.equal((await fixture.host.entries('route')[0].handle({})).label,'replacement');
  const data=path.join(fixture.host.directory,'data','fixture','events.txt');
  const cacheMarker=path.join(fixture.host.directory,'cache','fixture','cache-removal-marker');
  await fs.writeFile(cacheMarker,'discard this cached value');
  const before=await fs.readFile(data,'utf8');await fixture.host.clearCache('fixture');
  await assert.rejects(fs.stat(cacheMarker),{code:'ENOENT'});
  assert.ok((await fs.readFile(data,'utf8')).startsWith(before));
  await fixture.host.uninstall('fixture');assert.equal(fixture.host.get('fixture').status,'uninstalled');
  await fixture.reopen();assert.equal(fixture.host.get('fixture').installed,false);
  assert.equal(fixture.host.get('fixture').configuration.message,'configured');
  await fixture.host.install(source);await fixture.host.setEnabled('fixture',true);
  assert.equal((await fixture.host.entries('metadata')[0].providers[0].getMetadata({Type:'Movie'})).Item.Name,'configured');
  assert.ok((await fs.readFile(data,'utf8')).includes('close replacement'));
});

test('configuration and update failures recover the active package and persisted configuration',async t=>{
  const fixture=await pluginFixture(t);await fixture.host.connect({});
  await fixture.host.install(await fixturePackage(fixture.root));await fixture.host.configure('fixture',{message:'retained'});
  const before=fixture.host.get('fixture');
  await assert.rejects(fixture.host.configure('fixture',{unknown:true}),/Invalid fixture/);
  for(const failure of ['activate','connect']){
    await assert.rejects(fixture.host.update('fixture',await fixturePackage(fixture.root,{label:failure,failure})),/Controlled/);
    assert.equal(fixture.host.get('fixture').digest,before.digest);
    assert.equal((await fixture.host.entries('metadata')[0].providers[0].getMetadata({Type:'Movie'})).Item.Name,'retained');
  }
  await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,before.digest);
  const state=JSON.parse(await fs.readFile(path.join(fixture.host.directory,'state.json')));
  assert.deepEqual((await fs.readdir(path.join(fixture.host.directory,'packages'))),[state.plugins.fixture.package.release]);
  assert.match(await fs.readFile(path.join(fixture.host.directory,'data','fixture','events.txt'),'utf8'),/close activate[\s\S]*close connect/);
});

test('disable aborts admitted work, drains it, closes resources and excludes future work',async t=>{
  const fixture=await pluginFixture(t);await fixture.host.install(await fixturePackage(fixture.root));
  await fixture.host.configure('fixture',{wait:true});
  const work=fixture.host.entries('metadata')[0].providers[0].getMetadata({Type:'Movie'});
  const rejected=assert.rejects(work,{name:'AbortError'});
  await fixture.host.setEnabled('fixture',false);await rejected;
  assert.deepEqual(fixture.host.entries('metadata'),[]);
  assert.match(await fs.readFile(path.join(fixture.host.directory,'data','fixture','events.txt'),'utf8'),/close initial\n$/);
});

test('disable closes resources acquired by already admitted work after shutdown begins',async t=>{
  const ready=Promise.withResolvers(),closed=Promise.withResolvers();
  const fixture=await pluginFixture(t,{options:{fixture:{ready:ready.promise,closed}}}),source=await fixturePackage(fixture.root);
  const entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace("  await record('activate');",
    `  context.run(async()=>{await context.options.ready;context.own(async()=>{await fs.writeFile(path.join(context.dataPath,'late-resource-closed'),'closed');context.options.closed.resolve();});await context.options.closed.promise;});\n  await record('activate');`));
  await fixture.host.install(source);
  let finished=false;const closing=fixture.host.setEnabled('fixture',false).then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  ready.resolve();await closing;
  assert.equal(await fs.readFile(path.join(fixture.host.directory,'data','fixture','late-resource-closed'),'utf8'),'closed');
});

test('disable returns paused and unconsumed extension iterators and aborts pending iterations',async t=>{
  const fixture=await pluginFixture(t),source=await fixturePackage(fixture.root),entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace("  await record('activate');",
    `  await record('activate');\n  await context.register('similar',{name:'Controlled references',itemTypes:['Movie'],async *getReferences(item,_query,signal){
      await record('iterator-start');try{
        if(item.wait)await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
        yield {ProviderName:'Fixture',ProviderId:'first'};signal.throwIfAborted();yield {ProviderName:'Fixture',ProviderId:'second'};
      }finally{await record('iterator-close');}
    }});`));
  await fixture.host.install(source);
  const provider=fixture.host.entries('similar')[0],unused=provider.getReferences({},{}),paused=provider.getReferences({},{});
  assert.equal((await paused.next()).value.ProviderId,'first');
  const pending=provider.getReferences({wait:true},{}),iteration=pending.next(),rejected=assert.rejects(iteration,{name:'AbortError'});
  await new Promise(resolve=>setImmediate(resolve));
  await fixture.host.setEnabled('fixture',false);await rejected;
  await assert.rejects(unused.next(),{status:503});await assert.rejects(paused.next(),{status:503});
  const events=await fs.readFile(path.join(fixture.host.directory,'data','fixture','events.txt'),'utf8');
  assert.equal(events.match(/iterator-start/g)?.length,2);assert.equal(events.match(/iterator-close/g)?.length,2);
});

test('disable closes idle and late prepared saves once and rejects their subsequent application',async t=>{
  const ready=Promise.withResolvers(),fixture=await pluginFixture(t,{options:{fixture:{ready:ready.promise}}});
  const source=await fixturePackage(fixture.root),entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace("  await context.register('metadata',",
    `  provider.prepareSave=async item=>{if(item.wait)await context.options.ready;return {apply:()=>record('prepared-apply'),close:()=>record('prepared-close')};};\n  await context.register('metadata',`));
  await fixture.host.install(source);
  const provider=fixture.host.entries('metadata')[0].providers[0],idle=await provider.prepareSave({}),late=provider.prepareSave({wait:true});
  const closing=fixture.host.setEnabled('fixture',false);
  await new Promise(resolve=>setImmediate(resolve));ready.resolve();
  const prepared=await late;await closing;
  assert.throws(()=>idle.apply(),{status:503});assert.throws(()=>prepared.apply(),{status:503});
  await idle.close();await prepared.close();
  const events=await fs.readFile(path.join(fixture.host.directory,'data','fixture','events.txt'),'utf8');
  assert.equal(events.match(/prepared-close/g)?.length,2);assert.doesNotMatch(events,/prepared-apply/);
});

test('a failed state commit restores the prior active release and survives restart',async t=>{
  const fixture=await pluginFixture(t);await fixture.host.install(await fixturePackage(fixture.root));
  await fixture.host.configure('fixture',{message:'retained'});
  const before=fixture.host.get('fixture'),source=await fixturePackage(fixture.root,{label:'replacement'});
  const state=path.join(fixture.host.directory,'state.json'),saved=path.join(fixture.host.directory,'saved-state.json');
  await fs.rename(state,saved);await fs.mkdir(state);
  try{
    await assert.rejects(fixture.host.update('fixture',source),cause=>['EPERM','EISDIR','EACCES','ENOTEMPTY'].includes(cause.code));
    assert.equal(fixture.host.get('fixture').status,'active');assert.equal(fixture.host.get('fixture').digest,before.digest);
    assert.equal((await fixture.host.entries('route')[0].handle({})).label,'initial');
    assert.equal(fixture.host.get('fixture').configuration.message,'retained');
  }finally{await fs.rmdir(state);await fs.rename(saved,state);}
  await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,before.digest);
  assert.equal(fixture.host.get('fixture').configuration.message,'retained');
});

test('package cleanup failure preserves successful updates and startup and retries abandoned releases',async t=>{
  const options={},errors=[],fixture=await pluginFixture(t,{options:{fixture:options},onError:cause=>errors.push(cause)});
  await fixture.host.install(await fixturePackage(fixture.root));
  const before=fixture.host.get('fixture'),source=await fixturePackage(fixture.root,{label:'replacement'}),entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace("  await fs.writeFile(path.join(context.cachePath,'entry'),label);",
    "  await fs.writeFile(path.join(context.cachePath,'entry'),label);await context.options.afterActivate?.();"));
  const packages=path.join(fixture.host.directory,'packages'),backup=path.join(fixture.host.directory,'held-packages');
  const block=async()=>{await fs.rename(packages,backup);await fs.writeFile(packages,'Controlled collection failure');};
  const restore=async()=>{await fs.unlink(packages);await fs.rename(backup,packages);};
  options.afterActivate=block;let updated;
  try{
    updated=await fixture.host.update('fixture',source);
    assert.equal(updated.status,'active');assert.notEqual(updated.digest,before.digest);
    assert.equal((await fixture.host.entries('route')[0].handle({})).label,'replacement');
    const state=JSON.parse(await fs.readFile(path.join(fixture.host.directory,'state.json')));
    assert.equal(state.plugins.fixture.package.digest,updated.digest);
    assert.equal(errors.length,2);
  }finally{await restore();}
  assert.equal((await fs.readdir(packages)).length,2);
  try{
    await fixture.reopen();
    assert.equal(fixture.host.get('fixture').status,'active');assert.equal(fixture.host.get('fixture').digest,updated.digest);
    assert.equal(errors.length,3);
  }finally{await restore();delete options.afterActivate;}
  await fixture.reopen();
  const state=JSON.parse(await fs.readFile(path.join(fixture.host.directory,'state.json')));
  assert.deepEqual(await fs.readdir(packages),[state.plugins.fixture.package.release]);
  assert.equal(fixture.host.get('fixture').digest,updated.digest);
});

test('package cleanup failure does not replace the original rejected update',async t=>{
  const errors=[],fixture=await pluginFixture(t,{onError:cause=>errors.push(cause)});
  await fixture.host.install(await fixturePackage(fixture.root));
  const before=fixture.host.get('fixture'),source=await fixturePackage(fixture.root,{label:'invalid'}),entry=path.join(source,'index.js');
  const packages=path.join(fixture.host.directory,'packages'),backup=path.join(fixture.host.directory,'held-packages');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace('export function validateConfiguration(configuration) {',
    `export async function validateConfiguration(configuration) {await fs.rename(${JSON.stringify(packages)},${JSON.stringify(backup)});await fs.writeFile(${JSON.stringify(packages)},'Controlled collection failure');throw new Error('Controlled validation failure.');`));
  try{
    await assert.rejects(fixture.host.update('fixture',source),/^Error: Controlled validation failure\.$/u);
    assert.equal(fixture.host.get('fixture').status,'active');assert.equal(fixture.host.get('fixture').digest,before.digest);
    assert.equal(errors.length,1);
  }finally{await fs.unlink(packages);await fs.rename(backup,packages);}
  await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,before.digest);
  assert.equal((await fs.readdir(packages)).length,1);
});

test('journal cleanup failure preserves a committed update and restart without discarding the obstruction',async t=>{
  const options={},errors=[],fixture=await pluginFixture(t,{options:{fixture:options},onError:cause=>{errors.push(cause);throw new Error('Controlled diagnostic failure.');}});
  await fixture.host.install(await fixturePackage(fixture.root));
  const before=fixture.host.get('fixture'),source=await fixturePackage(fixture.root,{label:'replacement'}),entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace("  await fs.writeFile(path.join(context.cachePath,'entry'),label);",
    "  await fs.writeFile(path.join(context.cachePath,'entry'),label);await context.options.afterActivate?.();"));
  const journal=path.join(fixture.host.directory,'transaction.json'),held=path.join(fixture.host.directory,'held-journal.json');
  let blocked=false,updated;
  options.afterActivate=async()=>{await fs.rename(journal,held);await fs.mkdir(journal);blocked=true;};
  try{
    updated=await fixture.host.update('fixture',source);delete options.afterActivate;
    assert.equal(updated.status,'active');assert.notEqual(updated.digest,before.digest);
    assert.equal((await fixture.host.entries('route')[0].handle({})).label,'replacement');
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.host.directory,'state.json'))).plugins.fixture.package.digest,updated.digest);
    assert.equal(errors.length,1);
    await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,updated.digest);assert.equal(fixture.host.get('fixture').status,'active');
    assert.equal(errors.length,2);assert.equal((await fs.stat(journal)).isDirectory(),true);
    await assert.rejects(fixture.host.configure('fixture',{message:'blocked'}),cause=>['EPERM','EISDIR','EACCES','ENOTEMPTY'].includes(cause.code));
    assert.equal(fixture.host.get('fixture').status,'active');assert.deepEqual(fixture.host.get('fixture').configuration,{});
  }finally{delete options.afterActivate;if(blocked){await fs.rmdir(journal);await fs.rename(held,journal);}}
  await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,updated.digest);
  await assert.rejects(fs.stat(journal),{code:'ENOENT'});
});

test('journal cleanup failure retains the original activation error and the recovered release',async t=>{
  const options={},errors=[],fixture=await pluginFixture(t,{options:{fixture:options},onError:cause=>errors.push(cause)});
  await fixture.host.install(await fixturePackage(fixture.root));const before=fixture.host.get('fixture');
  const source=await fixturePackage(fixture.root,{failure:'activate'}),entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace('throw new Error("Controlled activation failure.");',
    'await context.options.beforeFailure();throw new Error("Controlled activation failure.");'));
  const journal=path.join(fixture.host.directory,'transaction.json'),held=path.join(fixture.host.directory,'held-journal.json');let blocked=false;
  options.beforeFailure=async()=>{await fs.rename(journal,held);await fs.mkdir(journal);blocked=true;};
  try{
    await assert.rejects(fixture.host.update('fixture',source),/^Error: Controlled activation failure\.$/u);
    assert.equal(fixture.host.get('fixture').status,'active');assert.equal(fixture.host.get('fixture').digest,before.digest);
    assert.equal((await fixture.host.entries('route')[0].handle({})).label,'initial');assert.equal(errors.length,1);
  }finally{if(blocked){await fs.rmdir(journal);await fs.rename(held,journal);}}
  await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,before.digest);
});

test('an obstructed preparation journal cannot hide corrupt committed state',async t=>{
  const errors=[],fixture=await pluginFixture(t,{onError:cause=>errors.push(cause)}),directory=fixture.host.directory;
  const state=path.join(directory,'state.json'),journal=path.join(directory,'transaction.json'),before=await fs.readFile(state);
  await fixture.host.close();await fs.writeFile(state,JSON.stringify({generation:'controlled',plugins:[]}));await fs.mkdir(journal);
  try{
    await assert.rejects(PluginHost.open({directory,preinstalled:false,onError:cause=>errors.push(cause)}),/Invalid plugin state/);
    assert.equal((await fs.stat(journal)).isDirectory(),true);assert.deepEqual(errors,[]);
  }finally{await fs.rmdir(journal);await fs.writeFile(state,before);}
  await fixture.reopen();
});

test('old disposer failure rolls back an update and still closes other owned resources',async t=>{
  const options={failClose:false},fixture=await pluginFixture(t,{options:{fixture:options}}),source=await fixturePackage(fixture.root);
  const entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace("  await record('activate');",
    `  context.own(()=>{if(context.options.failClose)throw new Error('Controlled disposer failure.');});\n  await record('activate');`));
  await fixture.host.install(source);const before=fixture.host.get('fixture');options.failClose=true;
  try{
    await assert.rejects(fixture.host.update('fixture',await fixturePackage(fixture.root,{label:'replacement'})),/Plugin shutdown failed/);
    assert.equal(fixture.host.get('fixture').status,'active');assert.equal(fixture.host.get('fixture').digest,before.digest);
    assert.match(await fs.readFile(path.join(fixture.host.directory,'data','fixture','events.txt'),'utf8'),/close initial/);
  }finally{options.failClose=false;}
  await fixture.reopen();assert.equal(fixture.host.get('fixture').digest,before.digest);
});

test('interrupted diagnostic records cannot block restart or bypass the active OS owner',async t=>{
  const fixture=await pluginFixture(t),directory=fixture.host.directory,lock=path.join(directory,'host.lock');
  for(const contents of ['', '{"pid":']){
    await fixture.host.close();await fs.writeFile(lock,contents);
    await fixture.reopen();
    const owner=JSON.parse(await fs.readFile(lock,'utf8'));assert.equal(owner.pid,process.pid);assert.equal(typeof owner.token,'string');
    assert.equal((await fs.readdir(directory)).some(name=>/^host\.lock\..*\.tmp$/u.test(name)),false);
    await fs.writeFile(lock,contents);
    await assert.rejects(PluginHost.open({directory,preinstalled:false}),{status:409});
    assert.equal(await fs.readFile(lock,'utf8'),contents);
  }
});

test('cache restart failure remains observable and recovers without losing plugin data',async t=>{
  const fixture=await pluginFixture(t),source=await fixturePackage(fixture.root);
  await fs.appendFile(path.join(source,'index.js'),`\nexport const cacheRestartFixture=true;\n`);
  const entry=path.join(source,'index.js');
  await fs.writeFile(entry,(await fs.readFile(entry,'utf8')).replace('  const label=',
    `  if(await fs.stat(path.join(context.dataPath,'fail-restart')).then(()=>true,()=>false))throw new Error('Controlled cache restart failure.');\n  const label=`));
  await fixture.host.install(source);const before=fixture.host.get('fixture');
  const marker=path.join(fixture.host.directory,'data','fixture','fail-restart');await fs.writeFile(marker,'retained');
  const observed=[];fixture.host.subscribe(value=>observed.push(value.status));
  await assert.rejects(fixture.host.clearCache('fixture'),/Controlled cache restart failure/);
  assert.equal(fixture.host.get('fixture').status,'failed');assert.equal(fixture.host.get('fixture').digest,before.digest);
  assert.equal(await fs.readFile(marker,'utf8'),'retained');assert.deepEqual(observed,['failed']);
  await fs.unlink(marker);await fixture.host.clearCache('fixture');
  assert.equal(fixture.host.get('fixture').status,'active');assert.deepEqual(observed,['failed','active']);
  await fixture.reopen();assert.equal(fixture.host.get('fixture').status,'active');
});

test('package identity, corruption, exclusive ownership and unknown persisted data fail without data loss',async t=>{
  const fixture=await pluginFixture(t);await fixture.host.install(await fixturePackage(fixture.root));
  await assert.rejects(PluginHost.open({directory:fixture.host.directory,preinstalled:false}),{status:409});
  await assert.rejects(fixture.host.update('fixture',await fixturePackage(fixture.root,{id:'different'})),{status:409});
  await fixture.host.configure('fixture',{message:'preserved'});
  const directory=fixture.host.directory;await fixture.host.close();
  const state=JSON.parse(await fs.readFile(path.join(directory,'state.json')));
  await fs.appendFile(path.join(directory,'packages',state.plugins.fixture.package.release,'index.js'),'\n// corrupt');
  await fixture.reopen();assert.equal(fixture.host.get('fixture').status,'failed');
  assert.equal(fixture.host.get('fixture').configuration.message,'preserved');
  await fixture.host.setEnabled('fixture',false);assert.equal(fixture.host.get('fixture').status,'disabled');
  await fixture.host.uninstall('fixture');
  assert.ok((await fs.readFile(path.join(directory,'data','fixture','events.txt'),'utf8')).length);
});

for(const failure of ['missing directory','damaged package'])test(`installed releases recover with a ${failure} in preinstalled sources`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-bundle-recovery-'));
  const directory=path.join(root,'host'),preinstalled=path.join(root,'bundled'),errors=[];
  let host;
  t.after(async()=>{try{await host?.close();}finally{await fs.rm(root,{recursive:true,force:true});}});
  await fs.mkdir(preinstalled);
  const source=await fixturePackage(preinstalled,{id:'fixture'});
  await fixturePackage(preinstalled,{id:'retained'});
  await fixturePackage(preinstalled,{id:'removed'});
  const open=()=>PluginHost.open({directory,preinstalled,onError:error=>errors.push(error)});
  host=await open();
  await host.configure('fixture',{message:'persistent configuration'});
  await host.uninstall('removed');
  const before=host.get('fixture');
  await host.close();
  if(failure==='missing directory')await fs.rename(preinstalled,path.join(root,'unavailable-bundled'));
  else await fs.writeFile(path.join(source,'package.json'),'{');
  host=await open();
  assert.equal(errors.length,1);
  assert.equal(host.get('fixture').status,'active');
  assert.equal(host.get('fixture').digest,before.digest);
  assert.equal(host.get('fixture').configuration.message,'persistent configuration');
  assert.equal((await host.entries('metadata').find(value=>value.id==='fixture').providers[0].getMetadata({Type:'Movie'})).Item.Name,'persistent configuration');
  assert.equal(host.get('retained').status,'active');
  assert.equal(host.get('removed').status,'uninstalled');
  await host.close();
  if(failure==='missing directory')await fs.rename(path.join(root,'unavailable-bundled'),preinstalled);
  host=await open();
  assert.equal(host.get('removed').status,'uninstalled');
});

test('a real interrupted update restores the last committed package after process restart',async t=>{
  const fixture=await pluginFixture(t);await fixture.host.install(await fixturePackage(fixture.root));
  const directory=fixture.host.directory,before=fixture.host.get('fixture'),source=await fixturePackage(fixture.root,{label:'interrupted',wait:true});
  await fixture.host.close();
  const code=`import {PluginHost} from ${JSON.stringify(new URL('../../src/plugins/host.js',import.meta.url).href)};const h=await PluginHost.open({directory:${JSON.stringify(directory)},preinstalled:false});await h.update('fixture',${JSON.stringify(source)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);t.after(()=>{if(child.exitCode===null)child.kill();});
  const prepared=path.join(directory,'data','fixture','prepared');
  const limit=Date.now()+10000;let ready=false;
  while(Date.now()<limit){if(child.exitCode!==null)throw new Error('Interrupted-update child failed: '+stderr);
    try{ready=(await fs.readFile(prepared,'utf8'))==='interrupted';}catch(error){if(error.code!=='ENOENT')throw error;}
    if(ready)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(ready,true);const exited=once(child,'exit');child.kill();await exited;
  await fixture.reopen();assert.equal(fixture.host.get('fixture').status,'active');assert.equal(fixture.host.get('fixture').digest,before.digest);
  assert.equal((await fixture.host.entries('route')[0].handle({})).label,'initial');
  await assert.rejects(fs.stat(path.join(directory,'transaction.json')),{code:'ENOENT'});
});
