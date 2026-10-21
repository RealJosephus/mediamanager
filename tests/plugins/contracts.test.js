import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'acorn';
import {StorageRegistry} from '../../src/storage/registry.js';
import {createConfiguredStorage} from '../../src/storage-bootstrap.js';
import {pluginFixture} from './fixture.js';

const sourceFiles=async directory=>{
 const files=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const name=path.join(directory,entry.name);if(entry.isDirectory())files.push(...await sourceFiles(name));else if(name.endsWith('.js'))files.push(name);
 }return files;
};
test('core imports no concrete official plugin and managed content has no native filesystem fallback',async()=>{
 const resources=new Set(['src/library/external-urls.js','src/library/media-streams.js','src/library/user-view-labels.js']);
 for(const filename of await sourceFiles('src')){
  const name=filename.replaceAll('\\','/'),source=await fs.readFile(filename,'utf8');
  const tree=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  for(const node of tree.body){
   if(!node.source)continue;
   assert.doesNotMatch(node.source.value,/(?:^|\/)plugins\/(?:tmdb|nfo|alist|webdav|local|m3u|xmltv)(?:\/|$)|^@mediamanager\/(?:tmdb|nfo|alist|webdav|local|m3u|xmltv)(?:\/|$)/u,name);
   // OS font files and fontconfig are infrastructure inputs, outside managed
   // media/metadata access. The rest of the image pipeline still uses storage.
   if(/^src\/(?:metadata|images|library)\//u.test(name)&&!resources.has(name)&&!name.startsWith('src/images/system-fonts/'))assert.doesNotMatch(node.source.value,/^(?:node:)?fs(?:\/|$)/u,name);
  }
 }
});

const capabilities={randomRead:false,reliableLength:true,reliableVersion:false,directorySnapshot:true,
 create:false,replace:false,mkdir:false,delete:false,rename:false,atomicReplace:false,conditionalWrite:false,directLease:false,watch:false};
test('storage shutdown and type removal drain a factory and close its late adapter',async()=>{
 for(const operation of ['close','unregisterType']){
  const registry=new StorageRegistry(),ready=Promise.withResolvers();let closed=0;
  registry.registerType('pending',async()=>{await ready.promise;return {capabilities:Object.freeze(capabilities),stat(){},listPage(){},openRead(){},health(){},close(){closed++;}};});
  const creating=registry.createInstance('instance','pending',{});
  const rejected=assert.rejects(creating,error=>['closed','not-supported'].includes(error.code));
  let drained=false;const closing=registry[operation]('pending').then(()=>{drained=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
  ready.resolve();await rejected;await closing;assert.equal(closed,1);assert.equal(registry.hasInstance('instance'),false);await registry.close();
 }
});

test('third-party storage uses the same instance lifecycle and rolls back an unusable update',async t=>{
 const fixture=await pluginFixture(t);let storage;
 t.after(()=>storage?.close());
 const source=path.join(fixture.root,'storage-package');await fs.mkdir(source);
 await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'@test/storage',version:'0.1.0',type:'module',mediamanager:{id:'storage-fixture',name:'Controlled storage',entry:'index.js'}}));
 const packageCode=broken=>`import fs from 'node:fs/promises';import path from 'node:path';
 export async function activate(context){await context.register('storage',{type:'controlled',async create(){
 ${broken?'throw new Error("Controlled storage initialization failure");':''}
 const log=()=>fs.appendFile(path.join(context.dataPath,'closed'),'closed\\n');
 return {capabilities:Object.freeze(${JSON.stringify(capabilities)}),
 async stat(){return {kind:'file',size:4n,modified:'2026-01-01T00:00:00Z',version:null};},
 async listPage(){return {entries:[],complete:true,nextCursor:null,snapshot:'fixture',consistency:'snapshot',deletionSafe:true};},
 async openRead(){return {stream:[Buffer.from('test')],size:4n,close:async()=>{}};},async health(){return {available:true};},close:log};
 }});}`;
 await fs.writeFile(path.join(source,'index.js'),packageCode(false));await fixture.host.install(source);
 storage=await createConfiguredStorage(undefined,{plugins:fixture.host});
 await storage.configure({instances:[{id:'external',type:'controlled',config:{}}],mounts:[{path:'/external',instanceId:'external',capabilities:{}}],prefixes:[]});
 assert.equal((await storage.vfs.stat('/external/file')).size,4n);
 const before=fixture.host.get('storage-fixture');await fs.writeFile(path.join(source,'index.js'),packageCode(true));
 await assert.rejects(fixture.host.update('storage-fixture',source),/Controlled storage/);
 assert.equal(fixture.host.get('storage-fixture').digest,before.digest);
 assert.equal((await storage.vfs.stat('/external/file')).size,4n);
 const handle=await storage.vfs.openRead('/external/file');const chunks=[];for await(const value of handle.stream)chunks.push(value);await handle.close();assert.equal(Buffer.concat(chunks).toString(),'test');
 await fixture.host.setEnabled('storage-fixture',false);await assert.rejects(storage.vfs.stat('/external/file'),{code:'not-supported'});
 assert.equal(storage.configuration().instances.length,1);
 await fixture.host.setEnabled('storage-fixture',true);assert.equal(storage.status()[0].available,true);
 await fixture.host.uninstall('storage-fixture');assert.match(await fs.readFile(path.join(fixture.host.directory,'data','storage-fixture','closed'),'utf8'),/closed/);
 assert.equal(storage.configuration().instances.length,1);
});
