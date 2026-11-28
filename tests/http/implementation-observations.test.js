import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { withBackupArchive } from '../../src/system/backup-archive.js';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];
async function report(name, value, t) {
  const file = path.join(process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT, 'implementation-audit', name + '.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2)+'\n');
  t.diagnostic('Saved '+name);
}
test('observe public registration and optional backup scopes on separate mapped roots', async t => {
  const { runtime, request, programDataPath } = await createMetadataHttpFixture(t);
  const get = async (route, opts) => {
    const result = await request(route, opts);
    assert.equal(result.status,200, route+' '+result.bytes.toString().slice(0,100)); return result.body;
  };
  const tasks = await get('/ScheduledTasks');
  await report('public-registration', { routes:runtime.implementedRoutes, tasks:tasks.map(v=>({Key:v.Key, Name:v.Name, Id:v.Id})),
    plugins:(await get('/Plugins')).map(v=>v.id??v.Id) },t);
  const config = await get('/Storage/Configuration');
  const entries = [['subtitles','Data/subtitles',runtime.applicationPaths.dataPath],['trickplay','Data/trickplay',runtime.applicationPaths.dataPath],
    ['playlists','Data/playlists',runtime.applicationPaths.dataPath],['metadata','Data/metadata',path.dirname(runtime.applicationPaths.metadataPath)]];
  const cases = [];
  for(const [name, prefix, parent] of entries) {
    const base = path.join(parent,name), logical = path.join(base,'audit-mounted'), physical = path.resolve(programDataPath,'..','separate-'+name);
    await mkdir(base,{recursive:true}); await mkdir(physical);
    await writeFile(path.join(base,'control.txt'),'parent');
    await writeFile(path.join(physical,'witness.txt'),name);
    const id='separate-'+name, accessRoot='/'+id;
    config.instances.push({id,type:'local',config:{root:physical,writable:true}});
    config.mounts.push({instanceId:id,path:accessRoot,capabilities:{create:true,replace:true,delete:true,rename:true,mkdir:true,atomicReplace:true}});
    config.prefixes.push({identityRoot:logical,accessRoot,purpose:'metadata',style:process.platform==='win32'?'windows':'posix',returnAccess:'Separate audit volume.'});
    cases.push({name,base,logical,prefix});
  }
  await get('/Storage/Configuration',{method:'POST',body:config});
  const result=[];
  const options={Database:false,Metadata:true,Subtitles:true,Trickplay:true};
  const archive=await get('/Backup/Create',{method:'POST',body:options});
  await withBackupArchive(archive.Path,async zip => {
    for(const {name,base,logical,prefix} of cases) {
      const source=String(await runtime.fileSystem.readFile(path.join(logical,'witness.txt')));
      assert.equal(source,name);
      const parentControl=zip.directory.has(prefix+'/control.txt');
      assert.equal(parentControl,true);
      result.push({name,source,sourceListedByParent:(await runtime.fileSystem.readdir(base,{withFileTypes:true})).some(e=>e.name==='audit-mounted'),
        parentControl,childArchived:zip.directory.has(prefix+'/audit-mounted/witness.txt')});
    }
  });
  await report('backup-mounts',{createStatus:200,options,cases:result},t);
});

test('observe two in-flight TMDB requests during runtime shutdown with actual loopback HTTP', {timeout:35000}, async t => {
  const {runtime,request} = await createMetadataHttpFixture(t);
  const arrived=[Promise.withResolvers(),Promise.withResolvers()], gone=[Promise.withResolvers(),Promise.withResolvers()];
  const held=[], closed=[];
  const server=createServer((req,res)=>{
    if(!req.url.startsWith('/3/configuration?')) { res.writeHead(404);res.end();return; }
    const index=held.length;held.push(res);closed.push(false);
    res.on('close',()=>{closed[index]=true;gone[index]?.resolve();});arrived[index]?.resolve();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let stopping, detail, direct;
  const bounded = (promise,ms) => Promise.race([promise.then(()=>true),delay(ms,false,{ref:false})]);
  try {
    await runtime.plugins.setEnabled('tmdb',false);
    runtime.plugins.options.tmdb.baseUrl='http://127.0.0.1:'+server.address().port+'/3/';
    await runtime.plugins.setEnabled('tmdb',true);
    detail=request('/Items/RemoteSearch/Movie',{method:'POST',body:{SearchProviderName:'TheMovieDb',SearchInfo:{Name:'Audit movie',ProviderIds:{Tmdb:'701'}}}}).catch(e=>({error:e.name}));
    assert.equal(await bounded(arrived[0].promise,6000),true,'movie search reached configuration');
    direct=request('/Tmdb/ClientConfiguration').catch(e=>({error:e.name}));
    assert.equal(await bounded(arrived[1].promise,6000),true,'direct configuration reached the upstream');
    let finished=false;
    stopping=runtime.close().then(()=>{finished=true;},e=>{finished=true;throw e;});
    assert.equal(await bounded(gone[1].promise,5000),true,'direct request cancellation control');
    await delay(600);
    const sample={afterControlMs:600,upstreamMovieConfigurationClosed:closed[0],directUpstreamConfigurationClosed:closed[1],runtimeClosed:finished};
    held[0].writeHead(200,{'Content-Type':'application/json'});held[0].end(JSON.stringify({images:{}}));
    const [a,b]=await Promise.all([detail,direct]);await stopping;
    await report('tmdb-shutdown',{...sample,movieSearchStatus:a.status,directStatus:b.status,runtimeClosedAfterUpstreamRelease:finished},t);
  } finally {
    for(const res of held)res.destroy();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await Promise.allSettled([detail,direct,stopping]);
  }
});

test('observe caller cancellation while a cold TMDB movie request waits for upstream configuration', async t => {
  const started=Promise.withResolvers(), release=Promise.withResolvers();
  let transportSignal, settled=false, details=0;
  const client=new TmdbClient({apiKey:'audit-fixture',fetch:async (url,{signal})=>{
    if(!url.pathname.endsWith('/configuration')) {details++;return Response.json({id:1});}
    transportSignal=signal;started.resolve();await release.promise;signal.throwIfAborted();
    return Response.json({images:{secure_base_url:'https://example.invalid/',poster_sizes:['original'],backdrop_sizes:['original'],
      still_sizes:['original'],logo_sizes:['original'],profile_sizes:['original']}});
  }});
  const owner=new AbortController();
  const task=client.movie(1,'en','en','US',{signal:owner.signal}).then(()=>({ok:true}),e=>({ok:false,name:e.name})).finally(()=>{settled=true;});
  try {
    await started.promise;owner.abort();await delay(100);
    const snapshot={callerAborted:owner.signal.aborted,configurationTransportAborted:transportSignal.aborted,settledWhileResponseHeld:settled};
    release.resolve();await report('tmdb-cancel',{...snapshot,outcome:await task,detailsRequests:details},t);
  } finally { release.resolve();client.close();await task; }
});
