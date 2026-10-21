import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {createRuntime} from '../../src/runtime.js';
import {PostgresDatabase} from '../../src/database/postgres.js';
import {createPostgresTestDatabase,dropPostgresTestDatabase,postgresTestRow} from '../database/postgres-fixture.js';
import {startActualAList} from '../storage/helpers/actual-alist.js';
import {startActualWebDav} from '../storage/helpers/actual-webdav.js';
import {fixturePackage} from './fixture.js';

const capabilities={create:true,replace:true,mkdir:true,delete:true,rename:true};
const read=async handle=>{try{const chunks=[];for await(const chunk of handle.stream)chunks.push(chunk);return Buffer.concat(chunks);}finally{await handle.close();}};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

test('real PostgreSQL runtime manages official and third-party packages with independent media and metadata storage',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-runtime-'));
 let runtime,database,alist,dav,tmdb;const errors=[],requests=[];
 t.after(async()=>{await runtime?.close();await dropPostgresTestDatabase(database);await alist?.stop();await dav?.stop();
   if(tmdb?.listening)await new Promise(resolve=>tmdb.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 database=await createPostgresTestDatabase(null,'plugin_runtime');
 alist=await startActualAList({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES});t.diagnostic('Actual AList started.');dav=await startActualWebDav();t.diagnostic('Actual WebDAV started.');
 tmdb=createServer((request,response)=>{requests.push(request.url);response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify(request.url.startsWith('/configuration')?{images:{base_url:'http://images.invalid/',poster_sizes:['original']}}:
     {id:42,title:'Controlled TMDB movie',original_title:'Original',overview:'Actual HTTP transport',release_date:'2026-01-01',credits:{}}));});
 await listen(tmdb);
 const options={programDataPath:path.join(root,'state'),configurationDirectoryPath:path.join(root,'config'),
   configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},serverId:'plugin-runtime',onError:error=>errors.push(error),
   environment:{ALIST_FIXTURE:alist.token,DAV_FIXTURE:dav.authorization},
   pluginOptions:{options:{tmdb:{apiKey:'controlled',baseUrl:`http://127.0.0.1:${tmdb.address().port}/`}}}};
 runtime=await createRuntime({database,...options});await listen(runtime.server);t.diagnostic('Runtime started.');
 const apiKey=(await runtime.apiKeys.create('Plugin acceptance')).AccessToken;
 const request=async(method,url,value,authenticated=true)=>fetch(`http://127.0.0.1:${runtime.server.address().port}${url}`,{
   method,headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`MediaBrowser Token="${apiKey}"`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});
 assert.equal((await request('GET','/Plugins',undefined,false)).status,401);
 const listed=await request('GET','/Plugins');const listedBody=await listed.text();
 assert.equal(listed.status,200,listedBody);assert.ok(listedBody,JSON.stringify(errors.map(error=>error.message)));
 assert.deepEqual(JSON.parse(listedBody).map(value=>value.id).sort(),['alist','local','m3u','nfo','tmdb','webdav','xmltv']);
 const command=await new Promise((resolve,reject)=>execFile(process.execPath,['tools/plugins.js','list'],{windowsHide:true,
   env:{...process.env,MEDIAMANAGER_URL:`http://127.0.0.1:${runtime.server.address().port}`,MEDIAMANAGER_ADMIN_TOKEN:apiKey}},
   (error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
 assert.deepEqual(JSON.parse(command.stdout).map(value=>value.id).sort(),['alist','local','m3u','nfo','tmdb','webdav','xmltv']);
 const ordinary=await runtime.users.createUser({Name:'Plugin reader'});
 const login=await runtime.authentication.login({Username:'Plugin reader',Pw:''},{Client:'test',Device:'test',DeviceId:'reader',Version:'1'});
 assert.equal((await fetch(`http://127.0.0.1:${runtime.server.address().port}/Plugins`,{headers:{Authorization:`MediaBrowser Token="${login.AccessToken}"`}})).status,403);
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
  const response=await request('POST','/Storage/Bindings',{identityRoot,instanceId,root:storageRoot,purpose,style:'windows',caseSensitive:false,returnAccess:'Retain original identity paths.',capabilities});
  assert.equal(response.status,200,await response.clone().text());
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
  if(plugin==='tmdb')assert.equal((await runtime.tasks.list()).some(task=>task.Key==='TmdbRefreshUpcomingEpisodes'),true);
  assert.equal((await request('POST',`/Plugins/${plugin}/Configuration`,plugin==='tmdb'?{MaxCastMembers:6}:plugin==='nfo'?{SaveImagePathsInNfo:false}:{})).status,200);
  assert.equal((await request('POST',`/Plugins/${plugin}/Enabled`,{enabled:false})).status,200);
  assert.equal(runtime.plugins.get(plugin).status,'disabled');
  if(plugin==='tmdb'){assert.equal((await request('GET','/Tmdb/ClientConfiguration')).status,404);assert.equal((await runtime.tasks.list()).some(task=>task.Key==='TmdbRefreshUpcomingEpisodes'),false);}
  if(plugin==='alist'){
   await assert.rejects(runtime.storage.vfs.stat(access('Z:\\Library\\Family\\movie.mkv')),{code:'not-supported'});
   await assert.rejects(runtime.library.unsafeItemDeletion.deleteQueryItems({ids:[id]},{deleteSourceFiles:true}),error=>['not-supported','ENOTSUP'].includes(error.code));
  }
  assert.deepEqual(await database.rows('BaseItems',{where:{Id:id}}),rows);assert.deepEqual(await database.rows('BaseItemProviders',{where:{ItemId:id}}),providers);
  assert.equal((await request('POST',`/Plugins/${plugin}/Enabled`,{enabled:true})).status,200);
  assert.equal((await request('POST',`/Plugins/${plugin}/Update`,{path:path.resolve('plugins',plugin)})).status,200);
  assert.equal((await request('DELETE',`/Plugins/${plugin}/Cache`)).status,200);
  assert.equal((await request('DELETE',`/Plugins/${plugin}`)).status,200);
  assert.equal((await request('POST','/Plugins/Install',{path:path.resolve('plugins',plugin)})).status,200);
  assert.equal((await request('POST',`/Plugins/${plugin}/Enabled`,{enabled:true})).status,200);
 }
 assert.equal((await request('POST','/Plugins/tmdb/Configuration',{unexpected:true})).status,400);
 const initial=await fixturePackage(root),updated=await fixturePackage(root,{label:'updated'}),failed=await fixturePackage(root,{failure:'connect'});
 assert.equal((await request('POST','/Plugins/Install',{path:initial})).status,200);
 assert.equal((await request('POST','/Plugins/fixture/Configuration',{message:'persisted'})).status,200);
 assert.equal((await (await request('GET','/Fixture/Echo')).json()).message,'persisted');
 assert.equal((await request('POST','/Plugins/fixture/Update',{path:failed})).status,500);
 assert.equal((await (await request('GET','/Fixture/Echo')).json()).label,'initial');
 assert.equal((await request('POST','/Plugins/fixture/Update',{path:updated})).status,200);
 assert.equal((await request('POST','/Plugins/fixture/Enabled',{enabled:false})).status,200);
 await runtime.plugins.uninstall('local');const storageDefinition=runtime.storage.configuration();
 const schema=database.schemaName;await runtime.close();
 database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema});
 runtime=await createRuntime({database,...options});await listen(runtime.server);
 assert.equal(runtime.plugins.get('local').installed,false);assert.equal(runtime.storageReadiness.ready,false);
 assert.equal(runtime.plugins.get('fixture').status,'disabled');assert.equal(runtime.plugins.get('fixture').configuration.message,'persisted');
 assert.deepEqual(runtime.storage.configuration(),storageDefinition);
 assert.deepEqual(await database.rows('BaseItems',{where:{Id:id}}),rows);assert.deepEqual(await database.rows('BaseItemProviders',{where:{ItemId:id}}),providers);
 assert.equal((await request('POST','/Plugins/Install',{path:path.resolve('plugins/local')})).status,200);
 assert.equal((await request('POST','/Plugins/local/Enabled',{enabled:true})).status,200);assert.equal(runtime.storageReadiness.ready,true);
 assert.equal((await request('POST','/Plugins/fixture/Enabled',{enabled:true})).status,200);
 assert.equal((await (await request('GET','/Fixture/Echo')).json()).label,'updated');
 const provider=runtime.metadata.registry.discover({item:{Type:'Movie'},kind:'local'}).find(provider=>provider.id==='fixture-provider');
 assert.equal((await provider.getMetadata({Type:'Movie'})).Item.Name,'persisted');
 const hanging=request('GET','/Fixture/Wait');
 const eventsFile=path.join(runtime.plugins.directory,'data','fixture','events.txt');
 for(let attempt=0;!(await fs.readFile(eventsFile,'utf8')).includes('route updated');attempt++){
  assert.ok(attempt<200,'The plugin request must start before shutdown.');await new Promise(resolve=>setTimeout(resolve,10));
 }
 await runtime.close();assert.equal((await hanging).status,500);
 database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema});
 runtime=await createRuntime({database,...options});await listen(runtime.server);
 assert.equal((await request('DELETE','/Plugins/fixture')).status,200);assert.equal((await request('GET','/Fixture/Echo')).status,404);
 assert.equal((await read(await runtime.storage.vfs.openRead(access('Z:\\Library\\Family\\movie.mkv')))).toString(),'Z:\\Library\\Family\\movie.mkv');
 const unexpected=errors.filter(error=>![401,403,400,500].includes(error.status)&&error.name!=='AbortError'&&!['ENOTSUP','not-supported'].includes(error.code)&&!error.message.includes('Controlled connection failure'));
 assert.deepEqual(unexpected,[]);
});
