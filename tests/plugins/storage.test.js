import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openConfiguredPluginHost } from './configuration-host.js';
import {createConfiguredStorage} from '../../src/storage-bootstrap.js';
import {MetadataImageAssets} from '../../src/metadata/image-assets.js';
import {prepareItemSourceDeletion} from '../../src/library/item-source-deletion.js';

const capabilities={create:true,replace:true,mkdir:true,delete:true,rename:true,atomicReplace:true};
const read=async handle=>{try{const chunks=[];for await(const chunk of handle.stream)chunks.push(chunk);return Buffer.concat(chunks);}finally{await handle.close();}};

test('local storage package enforces bounds, ranges, write outcomes, links and disable recovery',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-local-'));
 let host,storage;t.after(async()=>{await storage?.close();await host?.close();await fs.rm(root,{recursive:true,force:true});});
 host=await openConfiguredPluginHost({directory:path.join(root,'host')});storage=await createConfiguredStorage(undefined,{plugins:host});
 const definition=storage.configuration();definition.instances.push({id:'media',type:'local',config:{root:path.join(root,'media'),writable:true,createRoot:true}});
 definition.mounts.push({path:'/media',instanceId:'media',capabilities},{path:'/read-only',instanceId:'media',capabilities:{}});
 definition.prefixes.push({identityRoot:'Z:\\Library',accessRoot:'/media',style:'windows',caseSensitive:false,returnAccess:'Retain source identity and reattach the storage root.',purpose:'library'});
 await storage.configure(definition);const vfs=storage.vfs;
 const name='/media/中文 %2F #.mkv',bytes=Buffer.from('abcdefghijk');
 await vfs.write(name,bytes,{overwrite:false});assert.deepEqual(await read(await vfs.openRead(name)),bytes);
 for(const [range,expected]of [[{start:2n,end:5n},'cdef'],[{suffix:3n},'ijk'],[{start:8n},'ijk']])assert.equal((await read(await vfs.openRead(name,{range}))).toString(),expected);
 const version=(await vfs.stat(name)).version;await assert.rejects(vfs.openRead(name,{ifMatch:'changed'}),{code:'version-changed'});
 assert.deepEqual(await read(await vfs.openRead(name,{ifMatch:version})),bytes);
 await assert.rejects(vfs.write('/read-only/blocked',bytes),{code:'not-supported'});
 await assert.rejects(vfs.write(name,bytes,{overwrite:false}),{code:'already-exists'});
 async function* broken(){yield Buffer.from('prefix');throw new Error('Controlled failed upload');}
 await assert.rejects(vfs.write(name,broken(),{atomic:true}),/Controlled failed upload/);
 assert.deepEqual(await read(await vfs.openRead(name)),bytes);
 await assert.rejects(vfs.write(name,broken()),/Controlled failed upload/);
 assert.equal((await read(await vfs.openRead(name))).toString(),'prefix');
 assert.equal((await vfs.list('/media')).deletionSafe,true);
 await fs.mkdir(path.join(root,'outside'));await fs.writeFile(path.join(root,'outside','retained'),'retain');
 await fs.symlink(path.join(root,'outside'),path.join(root,'media','link'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(vfs.stat('/media/link/retained'),{code:'permission-denied'});
 await assert.rejects(vfs.list('/media'),{code:'permission-denied'});
 await vfs.delete('/media/link',{recursive:true});assert.equal(await fs.readFile(path.join(root,'outside','retained'),'utf8'),'retain');
 const handle=await vfs.openRead(name);
 let started;const ready=new Promise(resolve=>{started=resolve;});let returned=false;
 const waiting={ [Symbol.asyncIterator](){return this;},next(){started();return new Promise(()=>{});},return(){returned=true;return {done:true};} };
 const upload=vfs.write('/media/cancelled-upload',waiting,{atomic:true});await ready;
 const cancelled=assert.rejects(upload);
 await host.setEnabled('local',false);
 await cancelled;assert.equal(returned,true);
 await assert.rejects(fs.stat(path.join(root,'media','cancelled-upload')),{code:'ENOENT'});
 await assert.rejects(read(handle));await assert.rejects(vfs.stat(name),{code:'not-supported'});
 assert.deepEqual(storage.configuration(),definition);
 await host.setEnabled('local',true);assert.equal((await read(await vfs.openRead(name))).toString(),'prefix');
 const prior=storage.configuration(),invalid=structuredClone(prior);invalid.instances.find(value=>value.id==='media').config.unknown=true;
 await assert.rejects(storage.configure(invalid),TypeError);assert.deepEqual(storage.configuration(),prior);
 await vfs.delete(name);await assert.rejects(vfs.stat(name),{code:'not-found'});
});

test('media and metadata select independent plugins for each nested identity prefix',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-paths-'));let host,storage;
 t.after(async()=>{await storage?.close();await host?.close();await fs.rm(root,{recursive:true,force:true});});
 host=await openConfiguredPluginHost({directory:path.join(root,'host')});storage=await createConfiguredStorage(undefined,{plugins:host});
 const definition=storage.configuration();
 for(const id of ['media','nested','metadata'])definition.instances.push({id,type:'local',config:{root:path.join(root,id),createRoot:true,writable:true}});
 await storage.configure(definition);
 for(const [identityRoot,instanceId,purpose]of [['Z:\\Movies','media','library'],['Z:\\Movies\\Kids','nested','library'],['Z:\\Movies','metadata','metadata']]){
  await storage.bindPath({identityRoot,instanceId,purpose,style:'windows',caseSensitive:false,returnAccess:'Stable path retained.',capabilities});
 }
 const parent=storage.identityMap.resolve({identityPath:'Z:\\Movies\\movie.mkv',style:'windows'});
 const child=storage.identityMap.resolve({identityPath:'Z:\\Movies\\Kids\\movie.mkv',style:'windows'});
 await storage.vfs.write(parent,Buffer.from('parent'));await storage.vfs.write(child,Buffer.from('child'));
 assert.equal(child,parent.replace('/movie.mkv','/Kids/movie.mkv'));
 const listing=await storage.vfs.list(parent.slice(0,parent.lastIndexOf('/')));
 assert.ok(listing.entries.some(entry=>entry.name==='Kids'&&entry.kind==='directory'));
 assert.equal(listing.deletionSafe,false,'an overlaid child cannot authorize missing-item deletion');
 // A metadata override at the library root applies to nested media bindings.
 const nfo=parent.replace('.mkv','.nfo');await storage.metadataVfs.write(nfo,Buffer.from('<movie/>'));
 await storage.fileSystem.mkdir('Z:\\Movies\\Kids',{recursive:true});
 await storage.metadataVfs.write(child.replace('.mkv','.nfo'),Buffer.from('<movie><title>Child</title></movie>'));
 assert.equal(await fs.readFile(path.join(root,'media','movie.mkv'),'utf8'),'parent');
 assert.equal(await fs.readFile(path.join(root,'nested','movie.mkv'),'utf8'),'child');
 assert.equal(await fs.readFile(path.join(root,'metadata','movie.nfo'),'utf8'),'<movie/>');
 assert.match(await fs.readFile(path.join(root,'metadata','Kids','movie.nfo'),'utf8'),/<title>Child/);
 await assert.rejects(fs.stat(path.join(root,'media','movie.nfo')),{code:'ENOENT'});
 const photo={Type:'Photo',Path:'Z:\\Movies\\photo.jpg',IsFolder:false};
 const photoPath=storage.identityMap.resolve({identityPath:photo.Path,style:'windows'});
 await storage.vfs.write(photoPath,Buffer.from('photo source'));
 await storage.fileSystem.writeFile(photo.Path,Buffer.from('different metadata object'));
 const assets=new MetadataImageAssets({fileSystem:storage.fileSystem,vfs:storage.vfs,identityMap:storage.metadataIdentityMap});
 assert.equal((await assets.forItem(photo,photoPath).read(photo.Path)).toString(),'photo source');
 const remove=prepareItemSourceDeletion({item:{Path:'Z:\\Movies\\movie.mkv'},accessPath:parent,vfs:storage.vfs,metadataVfs:storage.metadataVfs,fileLeaf:true,mixed:true});
 await remove();
 await assert.rejects(fs.stat(path.join(root,'media','movie.mkv')),{code:'ENOENT'});
 await assert.rejects(fs.stat(path.join(root,'metadata','movie.nfo')),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(root,'nested','movie.mkv'),'utf8'),'child');
});

test('persisted portable media identities allow finer storage choices and independent metadata across restart',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-portable-'));let host,storage;
 t.after(async()=>{await storage?.close();await host?.close();await fs.rm(root,{recursive:true,force:true});});
 const directory=path.join(root,'host'),filename=path.join(root,'storage.json');
 const portableMountContract={mounts:[{mountId:'movies',identityRoot:'Z:\\Movies',accessRoot:'/movies',pathStyle:'windows',caseSensitive:false,returnPolicy:'required'}]};
 const definition={instances:['media','nested','metadata'].map(id=>({id,type:'local',config:{root:path.join(root,id),createRoot:true,writable:true}})),
  mounts:[{path:'/movies',instanceId:'media',root:'/',capabilities}],
  prefixes:[{identityRoot:'Z:\\Movies',accessRoot:'/movies',style:'windows',caseSensitive:false,returnAccess:'Retain original identity paths.'}]};
 await fs.writeFile(filename,JSON.stringify(definition));
 host=await openConfiguredPluginHost({directory});storage=await createConfiguredStorage(filename,{plugins:host,portableMountContract});
 await storage.bindPath({identityRoot:'Z:\\Movies\\Kids',instanceId:'nested',purpose:'library',style:'windows',caseSensitive:false,returnAccess:'Retain original identity paths.',capabilities});
 await storage.bindPath({identityRoot:'Z:\\Movies',instanceId:'metadata',purpose:'metadata',style:'windows',caseSensitive:false,returnAccess:'Retain original identity paths.',capabilities});
 assert.equal(storage.identityMap.resolve({identityPath:'Z:\\Movies\\Kids\\movie.mkv',style:'windows'}),'/movies/Kids/movie.mkv');
 await storage.vfs.write('/movies/Kids/movie.mkv',Buffer.from('nested media'));
 await storage.fileSystem.mkdir('Z:\\Movies\\Kids',{recursive:true});
 await storage.metadataVfs.write('/movies/Kids/movie.nfo',Buffer.from('<movie/>'));
 assert.equal(await fs.readFile(path.join(root,'nested','movie.mkv'),'utf8'),'nested media');
 assert.equal(await fs.readFile(path.join(root,'metadata','Kids','movie.nfo'),'utf8'),'<movie/>');
 const saved=storage.configuration();await storage.close();await host.close();
 host=await openConfiguredPluginHost({directory});storage=await createConfiguredStorage(filename,{plugins:host,portableMountContract});
 assert.deepEqual(storage.configuration(),saved);assert.deepEqual(storage.portableMountContract,portableMountContract);
 assert.equal((await read(await storage.vfs.openRead('/movies/Kids/movie.mkv'))).toString(),'nested media');
 assert.equal((await read(await storage.metadataVfs.openRead('/movies/Kids/movie.nfo'))).toString(),'<movie/>');
});

test('parent bindings retain earlier child storage selections and enumerate them after restart',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-parent-paths-'));let host,storage;
 t.after(async()=>{await storage?.close();await host?.close();await fs.rm(root,{recursive:true,force:true});});
 const directory=path.join(root,'host');host=await openConfiguredPluginHost({directory});storage=await createConfiguredStorage(undefined,{plugins:host});
 const definition=storage.configuration();
 for(const id of ['parent','child','metadata','child-metadata'])definition.instances.push({id,type:'local',config:{root:path.join(root,id),createRoot:true,writable:true}});
 await storage.configure(definition);
 for(const [identityRoot,instanceId,purpose]of [['Z:\\Movies\\Kids','child','library'],['Z:\\Movies\\Kids','child-metadata','metadata'],['Z:\\Movies','parent','library'],['Z:\\Movies','metadata','metadata']]){
  await storage.bindPath({identityRoot,instanceId,purpose,style:'windows',caseSensitive:false,returnAccess:'Retain original identities.',capabilities});
 }
 const parent=storage.identityMap.resolve({identityPath:'Z:\\Movies',style:'windows'});
 const child=storage.identityMap.resolve({identityPath:'Z:\\Movies\\Kids\\movie.mkv',style:'windows'});
 assert.equal(child,parent+'/Kids/movie.mkv');
 await storage.vfs.write(child,Buffer.from('media'));
 await storage.metadataVfs.write(child.replace('.mkv','.nfo'),Buffer.from('<movie/>'));
 assert.ok((await storage.vfs.list(parent)).entries.some(entry=>entry.name==='Kids'));
 assert.ok((await storage.metadataVfs.list(parent)).entries.some(entry=>entry.name==='Kids'));
 assert.equal(await fs.readFile(path.join(root,'child','movie.mkv'),'utf8'),'media');
 assert.equal(await fs.readFile(path.join(root,'child-metadata','movie.nfo'),'utf8'),'<movie/>');
 const saved=storage.configuration();await storage.close();await host.close();
 host=await openConfiguredPluginHost({directory});storage=await createConfiguredStorage(undefined,{plugins:host});
 assert.deepEqual(storage.configuration(),saved);
 assert.equal((await read(await storage.vfs.openRead(child))).toString(),'media');
 assert.equal((await read(await storage.metadataVfs.openRead(child.replace('.mkv','.nfo')))).toString(),'<movie/>');
});

test('raw nested portable prefixes keep their namespaces and enumerate three storage levels independently from metadata',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-raw-prefixes-'));let host,storage;
 t.after(async()=>{await storage?.close();await host?.close();await fs.rm(root,{recursive:true,force:true});});
 const directory=path.join(root,'host'),filename=path.join(root,'storage.json');
 const names=['media-parent','media-child','media-grand','metadata-parent','metadata-child','metadata-grand'];
 const identities=['Z:\\Movies','Z:\\Movies\\Kids','Z:\\Movies\\Kids\\Grand'];
 const definition={instances:names.map(id=>({id,type:'local',config:{root:path.join(root,id),createRoot:true,writable:true}})),
  mounts:names.map(id=>({path:'/'+id,instanceId:id,root:'/',capabilities})),prefixes:[]};
 for(const purpose of ['library','metadata']) for(const [index,level]of ['parent','child','grand'].entries()) {
  const name=(purpose==='library'?'media':'metadata')+'-'+level;
  definition.prefixes.push({identityRoot:identities[index],accessRoot:'/'+name+(level==='child'?'/Library':''),
   style:'windows',caseSensitive:false,returnAccess:'Keep each declared portable namespace.',purpose});
 }
 for(const kind of ['media','metadata'])await fs.mkdir(path.join(root,kind+'-child','Library'),{recursive:true});
 const portableMountContract={mounts:definition.prefixes.filter(prefix=>prefix.purpose==='library').map((prefix,index)=>({
  mountId:'movies-'+index,identityRoot:prefix.identityRoot,accessRoot:prefix.accessRoot,pathStyle:prefix.style,
  caseSensitive:prefix.caseSensitive,returnPolicy:'required'}))};
 await fs.writeFile(filename,JSON.stringify(definition));
 host=await openConfiguredPluginHost({directory});storage=await createConfiguredStorage(filename,{plugins:host,portableMountContract});
 const saved=storage.configuration();
 assert.deepEqual(saved.prefixes.filter(prefix=>prefix.purpose!=='application'),definition.prefixes);
 for(const [index,level]of ['parent','child','grand'].entries()) {
  const identity=identities[index]+'\\movie.mkv';
  const access=storage.identityMap.resolve({identityPath:identity,style:'windows'});
  assert.equal(access,'/media-'+level+(level==='child'?'/Library':'')+'/movie.mkv');
  await storage.vfs.write(access,Buffer.from(level+' media'));
  await storage.metadataVfs.write(access.replace('.mkv','.nfo'),Buffer.from(level+' metadata'));
 }
 const verify=async()=>{
  for(const base of ['/media-parent','/metadata-parent'])assert.ok((await storage.vfs.list(base)).entries.some(entry=>entry.name==='Kids'));
  for(const base of ['/media-parent/Kids','/media-child/Library','/metadata-parent/Kids','/metadata-child/Library']) {
   const listing=await storage.vfs.list(base);assert.ok(listing.entries.some(entry=>entry.name==='Grand'));assert.equal(listing.deletionSafe,false);
  }
  for(const access of ['/media-parent/Kids/Grand/movie.mkv','/media-child/Library/Grand/movie.mkv','/media-grand/movie.mkv']) {
   assert.equal((await read(await storage.vfs.openRead(access))).toString(),'grand media');
   assert.equal((await read(await storage.metadataVfs.openRead(access.replace('.mkv','.nfo')))).toString(),'grand metadata');
  }
  assert.equal((await read(await storage.vfs.openRead('/media-parent/Kids/movie.mkv'))).toString(),'child media');
  await assert.rejects(storage.vfs.openRead('/media-parent/Kids/movie.nfo'),{code:'not-found'});
  await assert.rejects(storage.vfs.openRead('/metadata-parent/Kids/movie.mkv'),{code:'not-found'});
 };
 await verify();
 const conflict=storage.configuration();conflict.mounts.push({path:'/media-parent/Kids',instanceId:'media-parent',root:'/',capabilities});
 await assert.rejects(storage.configure(conflict),/Nested storage identity prefixes produce conflicting mounts/u);
 assert.deepEqual(storage.configuration(),saved);await verify();
 const equivalent=storage.configuration();equivalent.mounts.push({path:'/media-parent/Kids',instanceId:'media-child',root:'/Library',capabilities:{...capabilities,conditionalWrite:false}});
 await storage.configure(equivalent);await verify();
 await storage.close();await host.close();
 host=await openConfiguredPluginHost({directory});storage=await createConfiguredStorage(filename,{plugins:host,portableMountContract});
 assert.deepEqual(storage.configuration(),equivalent);assert.deepEqual(storage.portableMountContract,portableMountContract);await verify();
 assert.equal(await fs.readFile(path.join(root,'media-grand','movie.mkv'),'utf8'),'grand media');
 assert.equal(await fs.readFile(path.join(root,'metadata-grand','movie.nfo'),'utf8'),'grand metadata');
});

test('binding a parent library retains nested application defaults across restart',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-application-prefixes-'));let host,storage;
 t.after(async()=>{await storage?.close();await host?.close();await fs.rm(root,{recursive:true,force:true});});
 const options={programDataPath:path.join(root,'state'),dataPath:path.join(root,'state','data'),metadataPath:path.join(root,'state','metadata')};
 host=await openConfiguredPluginHost(options);storage=await createConfiguredStorage(undefined,{plugins:host});
 const defaults=storage.configuration().prefixes.filter(prefix=>prefix.purpose==='application');
 const definition=storage.configuration();definition.instances.push({id:'library',type:'local',config:{root:path.join(root,'library'),createRoot:true,writable:true}});
 await storage.configure(definition);
 await storage.bindPath({identityRoot:root,instanceId:'library',purpose:'library',style:process.platform==='win32'?'windows':'posix',
  caseSensitive:process.platform!=='win32',returnAccess:'Retain original application and library paths.',capabilities});
 assert.deepEqual(storage.configuration().prefixes.filter(prefix=>prefix.purpose==='application'),defaults);
 await storage.fileSystem.writeFile(path.join(options.dataPath,'retained.txt'),Buffer.from('retained application data'));
 const saved=storage.configuration();await storage.close();await host.close();
 host=await openConfiguredPluginHost(options);storage=await createConfiguredStorage(undefined,{plugins:host});
 assert.deepEqual(storage.configuration(),saved);
 assert.equal(await storage.fileSystem.readFile(path.join(options.dataPath,'retained.txt'),'utf8'),'retained application data');
});
