import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {createTestRuntime} from '../helpers/runtime.js';
import {PostgresDatabase} from '../../src/database/postgres.js';
import {createPostgresTestDatabase,dropPostgresTestDatabase,postgresTestRow} from '../database/postgres-fixture.js';
import {startActualAList} from '../storage/helpers/actual-alist.js';
import {startActualWebDav} from '../storage/helpers/actual-webdav.js';
import {fixturePackage} from './fixture.js';
import {validationOutputRoot,validationExecutable} from '../../tools/validation/paths.js';

const capabilities={create:true,replace:true,mkdir:true,delete:true,rename:true};
const read=async handle=>{try{const chunks=[];for await(const chunk of handle.stream)chunks.push(chunk);return Buffer.concat(chunks);}finally{await handle.close();}};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const errorDiagnostic=error=>({...error,name:error?.name,message:error?.message,stack:error?.stack,cause:error?.cause,errors:error?.errors});
const functionalFailure=failure=>{
 const seen=new Map();
 const value=input=>{
  if(input===null||typeof input!=='object')return input;
  if(seen.has(input))return seen.get(input);
  const result=Array.isArray(input)?[]:{};seen.set(input,result);
  if(Array.isArray(input)){for(const item of input)result.push(value(item));return result;}
  const keys=input instanceof Error?Object.getOwnPropertyNames(input).filter(key=>!['name','stack'].includes(key)):Object.keys(input);
  for(const key of keys)Object.defineProperty(result,key,{value:value(input[key]),enumerable:true,writable:true,configurable:true});
  return result;
 };
 return value(failure);
};

test('real PostgreSQL runtime manages official and third-party packages with independent media and metadata storage',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-runtime-'));
 let runtime,database,alist,dav,tmdb,generation=0,phase='setup',activeBoundary,connectCapturePath;
 const errors=[],requests=[],httpRequests=[],diagnostics=[],boundaries=[],connectFailures=[],connectObservationErrors=[],connectCapture={},pendingRequests=new Set(),requestContext=new AsyncLocalStorage();
 const observeConnectFailure=error=>{
  try{connectFailures.push({requestIndex:requestContext.getStore()?.request.index??null,generation,
   failure:functionalFailure(error),raw:errorDiagnostic(error)});}catch(cause){connectObservationErrors.push(cause);}
 };
 const assertConnectFailure=request=>{
  assert.ok(request.updateFailure,'The actual package update must reject independently of logging.');
  assert.equal(request.updateFailure.id,'fixture');assert.equal(request.updateFailure.source,request.updateSource);
  const actual=connectFailures.filter(value=>value.requestIndex===request.index&&value.generation===request.generation);
  assert.ok(actual.length,'The generated package must execute its original connect throw.');
  for(const failure of actual)assert.deepEqual(functionalFailure(request.updateFailure.error),failure.failure,
   'Update must propagate the observed connect failure without an extra validation, IO, SQL or cleanup failure.');
 };
 const report=error=>{
  const context=requestContext.getStore();errors.push(error);
  diagnostics.push({requestIndex:context?.request.index??null,requestOpen:context?.request.open===true,
   method:context?.method??null,route:context?.route??null,generation,phase,boundaryIndex:activeBoundary?.index??null,error});
 };
 const missingStorageFailure=async({type,identityPath,requiredApplicationPath=false})=>{
  const unavailable=runtime.storage.status().filter(instance=>instance.type===type&&!instance.available);
  assert.ok(unavailable.length,'The declared storage plugin must actually be unavailable.');
  let failure;
  try{await runtime.fileSystem.lstat(identityPath);}catch(error){failure=error;}
  assert.ok(failure,'The real filesystem operation must reject while its storage plugin is unavailable.');
  // Optional media/metadata mounts can be unavailable while the required
  // application identities remain usable. Only the latter defer startup.
  if(requiredApplicationPath){
   assert.equal(runtime.storageReadiness.ready,false);assert.equal(runtime.storageReadiness.error,failure.message);
  }
  return{type,identityPath,requiredApplicationPath,unavailable,readiness:{...runtime.storageReadiness},failure:functionalFailure(failure)};
 };
 const withMissingStorage=async(kind,missing,operation)=>{
  const boundary={index:boundaries.length,generation,kind};boundaries.push(boundary);
  const previous=activeBoundary;activeBoundary=boundary;
  try{const result=await operation();boundary.storageFailure=await missingStorageFailure(missing);return result;}
  finally{activeBoundary=previous;}
 };
 const closeRuntime=async()=>{phase='closing';try{await runtime?.close();}finally{phase='closed';}};
 const assertDiagnostics=()=>{
  t.diagnostic(JSON.stringify({requests:httpRequests,boundaries,connectCapture,connectFailures,connectObservationErrors,
   diagnostics:diagnostics.map(({error,...context})=>({...context,error:errorDiagnostic(error)}))},
   (_key,value)=>value instanceof Error?errorDiagnostic(value):value));
  assert.deepEqual(connectObservationErrors,[]);
  for(const failure of connectFailures){
   const request=httpRequests[failure.requestIndex];assert.equal(request?.failureKind,'connect');assertConnectFailure(request);
  }
  for(const diagnostic of diagnostics){
   const request=httpRequests[diagnostic.requestIndex];
   if(request){
    assert.equal(diagnostic.requestOpen,true,'A completed request cannot absorb later background or close errors.');
    assert.equal(diagnostic.generation,request.generation);assert.equal(diagnostic.method,request.method);assert.equal(diagnostic.route,request.route);
    if(request.storageFailure){
     assert.equal(request.response.status,200);assert.deepEqual(functionalFailure(diagnostic.error),request.storageFailure.failure);continue;
    }
    assert.ok(request.failureStatus!==undefined,'Successful requests cannot hide unexpected plugin or background errors.');
    assert.equal(request.response.status,request.failureStatus);
    assert.equal(diagnostic.error.status??diagnostic.error.statusCode??500,request.response.status);
    if(request.failureKind==='connect'){
     assertConnectFailure(request);
     assert.deepEqual(functionalFailure(diagnostic.error),functionalFailure(request.updateFailure.error));
    }else if(request.failureKind==='shutdown'){
     assert.equal(diagnostic.phase,'closing');assert.equal(request.method,'GET');assert.equal(request.route,'/Fixture/Wait');
     assert.equal(request.response.text,'Error processing request.');
    }
    continue;
   }
   assert.equal(diagnostic.requestIndex,null);
   const boundary=boundaries[diagnostic.boundaryIndex];
   assert.ok(boundary?.storageFailure,'Unclassified background and normal close errors must not be ignored.');
   assert.equal(diagnostic.generation,boundary.generation);
   assert.deepEqual(functionalFailure(diagnostic.error),boundary.storageFailure.failure);
  }
 };
 t.after(async()=>{
  const failures=[],attempt=async operation=>{try{await operation();}catch(error){failures.push(error);}};
  await attempt(closeRuntime);await attempt(()=>dropPostgresTestDatabase(database));await attempt(()=>alist?.stop());await attempt(()=>dav?.stop());
  await attempt(async()=>{if(tmdb?.listening)await new Promise(resolve=>tmdb.close(resolve));});await attempt(()=>fs.rm(root,{recursive:true,force:true}));
  if(connectCapturePath)await attempt(()=>fs.writeFile(path.join(connectCapturePath,'connect-control.json'),JSON.stringify({connectCapture,connectFailures,
   connectObservationErrors},(_key,value)=>value instanceof Error?errorDiagnostic(value):value,2)+'\n'));
  await attempt(assertDiagnostics);requestContext.disable();
  if(failures.length){
   t.diagnostic(JSON.stringify({cleanupFailures:failures},(_key,value)=>value instanceof Error?errorDiagnostic(value):value));
   throw new AggregateError(failures,'Plugin runtime test cleanup failed.');
  }
 });
 database=await createPostgresTestDatabase(null,'plugin_runtime');
 alist=await startActualAList({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES});t.diagnostic('Actual AList started.');dav=await startActualWebDav();t.diagnostic('Actual WebDAV started.');
 tmdb=createServer((request,response)=>{requests.push(request.url);response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify(request.url.startsWith('/configuration')?{images:{base_url:'http://images.invalid/',poster_sizes:['original']}}:
     {id:42,title:'Controlled TMDB movie',original_title:'Original',overview:'Actual HTTP transport',release_date:'2026-01-01',credits:{}}));});
 await listen(tmdb);
 const options={programDataPath:path.join(root,'state'),configurationDirectoryPath:path.join(root,'config'),
   configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},serverId:'plugin-runtime',onError:report,
   mediaEncoderOptions:{startupFFmpegPath:validationExecutable('ffmpeg')},
   environment:{ALIST_FIXTURE:alist.token,DAV_FIXTURE:dav.authorization},
   pluginOptions:{options:{tmdb:{apiKey:'controlled',baseUrl:`http://127.0.0.1:${tmdb.address().port}/`},fixture:{observeConnectFailure}}}};
 const openRuntime=async missing=>{
  phase='opening';generation++;
  const open=async()=>{
   runtime=await createTestRuntime({database,...options});
   // Carry the actual server request across awaits. A separate close task
   // must not inherit the one client request which happens to be pending.
   for(const entry of runtime.networkHost.listeners)entry.server.prependListener('request',incoming=>{
    const matching=[...pendingRequests].filter(value=>value.generation===generation&&value.method===incoming.method&&value.route===incoming.url);
    requestContext.enterWith(matching.length===1?{request:matching[0],method:incoming.method,route:incoming.url}:null);
   });
   const update=runtime.plugins.update;
   runtime.plugins.update=function(...args){
    const request=requestContext.getStore()?.request,pending=Reflect.apply(update,this,args);
    if(request?.failureKind==='connect')void Promise.resolve(pending).then(undefined,error=>{request.updateFailure={id:args[0],source:args[1],error};});
    return pending;
   };
  };
  try{if(missing)await withMissingStorage('cold-open-without-local-storage',missing,open);else await open();}
  finally{phase='running';}
 };
 await openRuntime();t.diagnostic('Runtime started.');
 const apiKey=(await runtime.apiKeys.create('Plugin acceptance')).AccessToken;
 const request=async(method,url,value,authenticated=true,{token=apiKey,failureStatus,failureKind,missingStorage}={})=>{
  const observation={index:httpRequests.length,generation,method,route:url,failureStatus,failureKind,open:true,
   ...(failureKind==='connect'?{updateSource:value.path}:{})};httpRequests.push(observation);pendingRequests.add(observation);
  try{
   const response=await fetch(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry=>entry.scheme==='http').port}${url}`,{
    method,headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`MediaBrowser Token="${token}"`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});
   const text=await response.clone().text();observation.response={status:response.status,...(failureStatus===undefined?{}:{contentType:response.headers.get('content-type'),text})};
   if(missingStorage)observation.storageFailure=await missingStorageFailure(missingStorage);
   return response;
  }finally{observation.open=false;pendingRequests.delete(observation);}
 };
 assert.equal((await request('GET','/Plugins',undefined,false,{failureStatus:401})).status,401);
 const listed=await request('GET','/Plugins');const listedBody=await listed.text();
 assert.equal(listed.status,200,listedBody);assert.ok(listedBody,JSON.stringify(errors.map(error=>error.message)));
 assert.deepEqual(JSON.parse(listedBody).map(value=>value.id).sort(),['alist','hdhomerun','http','local','m3u','nfo','tmdb','webdav','xmltv']);
 const command=await new Promise((resolve,reject)=>execFile(process.execPath,['tools/plugins.js','list'],{windowsHide:true,
   env:{...process.env,MEDIAMANAGER_URL:`http://127.0.0.1:${runtime.networkHost.listeners.find(entry=>entry.scheme==='http').port}`,MEDIAMANAGER_ADMIN_TOKEN:apiKey}},
   (error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
 assert.deepEqual(JSON.parse(command.stdout).map(value=>value.id).sort(),['alist','hdhomerun','http','local','m3u','nfo','tmdb','webdav','xmltv']);
 const ordinary=await runtime.users.createUser({Name:'Plugin reader'});
 const login=await runtime.authentication.login({Username:'Plugin reader',Pw:''},{Client:'test',Device:'test',DeviceId:'reader',Version:'1'});
 assert.equal((await request('GET','/Plugins',undefined,true,{token:login.AccessToken,failureStatus:403})).status,403);
 assert.ok(ordinary.Id);
 t.diagnostic('Management authorization checked.');
 const definition=runtime.storage.configuration();
 definition.instances.push({id:'disk',type:'local',config:{root:path.join(root,'media'),createRoot:true,writable:true}},
   {id:'remote-a',type:'alist',config:{baseUrl:alist.baseUrl,credentialRef:'ALIST_FIXTURE',capabilities}},
   {id:'remote-d',type:'webdav',config:{baseUrl:dav.baseUrl,credentialRef:'DAV_FIXTURE',capabilities}});
 assert.equal((await request('POST','/Storage/Configuration',definition)).status,200);
 for(const [identityRoot,instanceId,storageRoot,purpose]of [['Z:\\Library','disk','/','library'],
   ['Z:\\Library\\Family','remote-a','/Synthetic','library'],['Z:\\Library\\Series','remote-d','/Series','library'],['Z:\\Library','remote-d','/','metadata'],
   [path.join(root,'state','metadata'),'remote-a','/Synthetic/metadata','metadata']]){
  const style=/^[A-Za-z]:[\\/]|^\\\\/u.test(identityRoot)?'windows':'posix';
  const response=await request('POST','/Storage/Bindings',{identityRoot,instanceId,root:storageRoot,purpose,style,caseSensitive:style==='posix',returnAccess:'Retain original identity paths.',capabilities});
  assert.equal(response.status,200,JSON.stringify({body:await response.clone().text(),errors:errors.map(error=>({message:error.message,stack:error.stack}))}));
 }
 const access=identityPath=>runtime.storage.identityMap.resolve({identityPath,style:'windows'});
 await runtime.fileSystem.mkdir('Z:\\Library\\Series',{recursive:true});
 await runtime.fileSystem.mkdir('Z:\\Library\\Family',{recursive:true});
 await runtime.storage.vfs.mkdir(access('Z:\\Library\\Family\\metadata'));
 await runtime.fileSystem.mkdir(path.join(root,'state','metadata'),{recursive:true});
 for(const [identity,expectedRoot]of [['Z:\\Library\\movie.mkv',path.join(root,'media')],['Z:\\Library\\Family\\movie.mkv',alist.media],['Z:\\Library\\Series\\movie.mkv',path.join(dav.media,'Series')]]){
  await runtime.storage.vfs.write(access(identity),Buffer.from(identity),{overwrite:false});
  assert.equal(await fs.readFile(path.join(expectedRoot,'movie.mkv'),'utf8'),identity);
  const nfo=runtime.metadata.registry.plugins().find(plugin=>plugin.id==='nfo');
  await nfo.save({Type:'Movie',Path:identity,Name:'Separate metadata',IsInMixedFolder:true,ProviderIds:{Tmdb:'42',FutureProvider:'retained'}},{accessPath:access(identity)});
  const loaded=await nfo.getMetadata({Type:'Movie',Path:identity,IsInMixedFolder:true},{accessPath:access(identity)});
  assert.equal(loaded.Item.Name,'Separate metadata');
  const sidecar=access(identity).replace('.mkv','.nfo');
  assert.match((await read(await runtime.storage.metadataVfs.openRead(sidecar))).toString(),/<futureproviderid>retained<\/futureproviderid>/);
  await nfo.save({...loaded.Item,Path:identity,IsInMixedFolder:true},{accessPath:access(identity)});
  assert.match((await read(await runtime.storage.metadataVfs.openRead(sidecar))).toString(),/<futureproviderid>retained<\/futureproviderid>/);
 }
 await assert.rejects(fs.stat(path.join(root,'media','movie.nfo')),{code:'ENOENT'});
 assert.match(await fs.readFile(path.join(dav.media,'movie.nfo'),'utf8'),/Separate metadata/);
 await runtime.fileSystem.writeFile(path.join(root,'state','metadata','image.bin'),Buffer.from('separate central metadata'));
 assert.equal(await fs.readFile(path.join(alist.media,'metadata','image.bin'),'utf8'),'separate central metadata');
 await runtime.storage.vfs.write(access('Z:\\Library\\poster.bin'),Buffer.from('media object'));
 await runtime.fileSystem.writeFile('Z:\\Library\\poster.bin',Buffer.from('metadata image'));
 assert.equal((await runtime.splashscreen.assets.read('Z:\\Library\\poster.bin')).toString(),'metadata image');
 assert.equal((await runtime.branding.assets.read('Z:\\Library\\poster.bin')).toString(),'metadata image');
 const remote=runtime.metadata.registry.discover({item:{Type:'Movie'},kind:'remote'}).find(provider=>provider.name==='TheMovieDb');
 assert.equal((await remote.getMetadata({Type:'Movie',ProviderIds:{Tmdb:'42'}})).Item.Name,'Controlled TMDB movie');
 assert.ok(requests.some(url=>url.startsWith('/movie/42')));
 const id='12000000-0000-0000-0000-000000000001';
 await database.insert('BaseItems',postgresTestRow('BaseItems',{Id:id,Type:'MediaBrowser.Controller.Entities.Movies.Movie',Name:'Retain',Path:'Z:\\Library\\Family\\movie.mkv',Data:'{"Future":{"value":"retain"}}'}));
 await database.insert('BaseItemProviders',{ItemId:id,ProviderId:'FutureProvider',ProviderValue:'retain-value'});
 const rows=await database.rows('BaseItems',{where:{Id:id}}),providers=await database.rows('BaseItemProviders',{where:{ItemId:id}});
 for(const plugin of ['tmdb','nfo','alist','webdav','local']){
  const missingStorage=['alist','local'].includes(plugin)?{type:plugin,identityPath:path.join(root,'state',...(plugin==='alist'?['metadata']:[])),requiredApplicationPath:plugin==='local'}:undefined;
  if(plugin==='tmdb')assert.equal((await runtime.tasks.list()).some(task=>task.Key==='TmdbRefreshUpcomingEpisodes'),true);
  assert.equal((await request('POST',`/Plugins/${plugin}/Configuration`,plugin==='tmdb'?{MaxCastMembers:6}:plugin==='nfo'?{SaveImagePathsInNfo:false}:{})).status,200);
  assert.equal((await request('POST',`/Plugins/${plugin}/Enabled`,{enabled:false},true,{missingStorage})).status,200);
  assert.equal(runtime.plugins.get(plugin).status,'disabled');
  if(plugin==='tmdb'){assert.equal((await request('GET','/Tmdb/ClientConfiguration',undefined,true,{failureStatus:404})).status,404);assert.equal((await runtime.tasks.list()).some(task=>task.Key==='TmdbRefreshUpcomingEpisodes'),false);}
  if(plugin==='alist'){
   await assert.rejects(runtime.storage.vfs.stat(access('Z:\\Library\\Family\\movie.mkv')),{code:'not-supported'});
   await assert.rejects(runtime.library.unsafeItemDeletion.deleteQueryItems({ids:[id]},{deleteSourceFiles:true}),error=>['not-supported','ENOTSUP'].includes(error.code));
  }
  assert.deepEqual(await database.rows('BaseItems',{where:{Id:id}}),rows);assert.deepEqual(await database.rows('BaseItemProviders',{where:{ItemId:id}}),providers);
  assert.equal((await request('POST',`/Plugins/${plugin}/Enabled`,{enabled:true})).status,200);
  assert.equal((await request('POST',`/Plugins/${plugin}/Update`,{path:path.resolve('plugins',plugin)})).status,200);
  assert.equal((await request('DELETE',`/Plugins/${plugin}/Cache`)).status,200);
  assert.equal((await request('DELETE',`/Plugins/${plugin}`,undefined,true,{missingStorage})).status,200);
  assert.equal((await request('POST','/Plugins/Install',{path:path.resolve('plugins',plugin)},true,{missingStorage})).status,200);
  assert.equal((await request('POST',`/Plugins/${plugin}/Enabled`,{enabled:true})).status,200);
 }
 assert.equal((await request('POST','/Plugins/tmdb/Configuration',{unexpected:true},true,{failureStatus:400})).status,400);
 const initial=await fixturePackage(root),updated=await fixturePackage(root,{label:'updated'}),failed=await fixturePackage(root,{failure:'connect'});
 const failedEntry=path.join(failed,'index.js'),originalConnectSource=await fs.readFile(failedEntry),originalSource=originalConnectSource.toString('utf8');
 const declaration='async connect(){',start=originalSource.indexOf(declaration),end=originalSource.indexOf('}};',start+declaration.length);
 assert.ok(start>=0&&end>start,'The newly generated package must contain its original connect method.');
 assert.equal(originalSource.indexOf(declaration,start+declaration.length),-1);
 const originalBody=originalSource.slice(start+declaration.length,end);
 const observedConnectSource=Buffer.from(originalSource.slice(0,start)+declaration+'try{'+originalBody+
  '}catch(failure){context.options.observeConnectFailure(failure);throw failure;}}'+originalSource.slice(end+1));
 connectCapturePath=path.join(validationOutputRoot(),'plugin-runtime-connect-'+randomUUID());await fs.mkdir(connectCapturePath,{recursive:true});
 await fs.writeFile(path.join(connectCapturePath,'original-index.js'),originalConnectSource);
 await fs.writeFile(path.join(connectCapturePath,'observed-index.js'),observedConnectSource);
 const manifestBytes=await fs.readFile(path.join(failed,'package.json'));
 await fs.writeFile(path.join(connectCapturePath,'package.json'),manifestBytes);
 const description=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 Object.assign(connectCapture,{originalSource:description(originalConnectSource),observedSource:description(observedConnectSource),manifest:description(manifestBytes),originalConnectBody:originalBody});
 await fs.writeFile(failedEntry,observedConnectSource);
 assert.equal((await request('POST','/Plugins/Install',{path:initial})).status,200);
 assert.equal((await request('POST','/Plugins/fixture/Configuration',{message:'persisted'})).status,200);
 assert.equal((await (await request('GET','/Fixture/Echo')).json()).message,'persisted');
 const beforeFailedUpdate=runtime.plugins.get('fixture');
 const failedUpdate=await request('POST','/Plugins/fixture/Update',{path:failed},true,{failureStatus:500,failureKind:'connect'});
 assert.equal(failedUpdate.status,500);assert.equal(await failedUpdate.text(),'Error processing request.');
 const failedUpdateObservation=httpRequests.at(-1);
 const afterFailedUpdate=runtime.plugins.get('fixture');
 connectCapture.update={requestIndex:failedUpdateObservation.index,generation,failed:functionalFailure(failedUpdateObservation.updateFailure?.error),
  before:beforeFailedUpdate,after:afterFailedUpdate};
 assertConnectFailure(failedUpdateObservation);assert.equal(afterFailedUpdate.digest,beforeFailedUpdate.digest);
 assert.equal((await (await request('GET','/Fixture/Echo')).json()).label,'initial');
 assert.equal((await request('POST','/Plugins/fixture/Update',{path:updated})).status,200);
 assert.equal((await request('POST','/Plugins/fixture/Enabled',{enabled:false})).status,200);
 const missingLocal={type:'local',identityPath:path.join(root,'state'),requiredApplicationPath:true};
 await withMissingStorage('uninstall-local-storage',missingLocal,()=>runtime.plugins.uninstall('local'));const storageDefinition=runtime.storage.configuration();
 const schema=database.schemaName;await closeRuntime();
 database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema});
 await openRuntime(missingLocal);
 assert.equal(runtime.plugins.get('local').installed,false);assert.equal(runtime.storageReadiness.ready,false);
 assert.equal(runtime.plugins.get('fixture').status,'disabled');assert.equal(runtime.plugins.get('fixture').configuration.message,'persisted');
 assert.deepEqual(runtime.storage.configuration(),storageDefinition);
 assert.deepEqual(await database.rows('BaseItems',{where:{Id:id}}),rows);assert.deepEqual(await database.rows('BaseItemProviders',{where:{ItemId:id}}),providers);
 assert.equal((await request('POST','/Plugins/Install',{path:path.resolve('plugins/local')},true,{missingStorage:missingLocal})).status,200);
 assert.equal((await request('POST','/Plugins/local/Enabled',{enabled:true})).status,200);assert.equal(runtime.storageReadiness.ready,true);
 assert.equal((await request('POST','/Plugins/fixture/Enabled',{enabled:true})).status,200);
 assert.equal((await (await request('GET','/Fixture/Echo')).json()).label,'updated');
 const provider=runtime.metadata.registry.discover({item:{Type:'Movie'},kind:'local'}).find(provider=>provider.id==='fixture-provider');
 assert.equal((await provider.getMetadata({Type:'Movie'})).Item.Name,'persisted');
 const hanging=request('GET','/Fixture/Wait',undefined,true,{failureStatus:500,failureKind:'shutdown'});
 const eventsFile=path.join(runtime.plugins.directory,'data','fixture','events.txt');
 for(let attempt=0;!(await fs.readFile(eventsFile,'utf8')).includes('route updated');attempt++){
  assert.ok(attempt<200,'The plugin request must start before shutdown.');await new Promise(resolve=>setTimeout(resolve,10));
 }
 await closeRuntime();const stopped=await hanging;assert.equal(stopped.status,500);assert.equal(await stopped.text(),'Error processing request.');
 database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema});
 await openRuntime();
 assert.equal((await request('DELETE','/Plugins/fixture')).status,200);assert.equal((await request('GET','/Fixture/Echo',undefined,true,{failureStatus:404})).status,404);
 assert.equal((await read(await runtime.storage.vfs.openRead(access('Z:\\Library\\Family\\movie.mkv')))).toString(),'Z:\\Library\\Family\\movie.mkv');
});
