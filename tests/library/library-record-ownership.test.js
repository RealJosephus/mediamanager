import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DomainStore} from '../../src/database/domain-store.js';
import {LibraryService} from '../../src/library/library-service.js';
import {PostgresLinkedChildrenStore,EMPTY_NATIVE_LINKS} from '../../src/library/postgres-linked-children.js';
import {createPostgresTestDatabase,postgresTestRow} from '../database/postgres-fixture.js';

const id=n=>n.toString(16).padStart(32,'0');
async function fixture(t){
  const database=await createPostgresTestDatabase(t,'record_owner',{maxPoolSize:1}),store=new DomainStore(database),links=new PostgresLinkedChildrenStore({database});await links.initialize();
  const library=new LibraryService({fileSystem: testFileSystem, store,linkedChildren:links,serverId:'record-owner',configuration:{CacheSize:3}});
  const frames=new Set(),load=library.load.bind(library);library.load=async(...args)=>{const state=await load(...args),dispose=state.dispose.bind(state);frames.add(state);state.dispose=async options=>{try{await dispose(options);}finally{frames.delete(state);}};return state;};
  await database.insert('BaseItems',postgresTestRow('BaseItems',{Id:id(1),Type:'MediaBrowser.Controller.Entities.UserRootFolder',Name:'Root',Data:'{}',IsFolder:true}));
  await database.insert('BaseItems',postgresTestRow('BaseItems',{Id:id(2),Type:'MediaBrowser.Controller.Entities.CollectionFolder',Name:'Collection',ParentId:id(1),Data:JSON.stringify({PhysicalFolderIds:[id(3)]}),IsFolder:true}));
  for(let value=3;value<=12;value++)await database.insert('BaseItems',postgresTestRow('BaseItems',{Id:id(value),Type:value===4?'MediaBrowser.Controller.Entities.Audio.Audio':value===5?'MediaBrowser.Controller.Entities.Movies.Movie':'MediaBrowser.Controller.Entities.Folder',Name:'item '+value,ParentId:value===3?null:id(3),TopParentId:id(3),Data:'{}',IsFolder:value!==4&&value!==5,MediaType:value===4?'Audio':value===5?'Video':'Unknown'}));
  t.after(async()=>{await library.close();assert.equal(frames.size,0);await links.flushReleases();await links.close();await store.close();});
  return{database,store,links,library,frames};
}
async function attach(links,item){item.LinkedChildren=await links.withSession(async session=>{const writer=await links.createWriter({session,parentId:item.Id});await writer.append({ItemId:id(5),Type:0});return writer.finish();});}

test('postgres: fresh records retain only returned owners and release frames on lookup, denial and callback failure',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const{database,library,links,frames}=await fixture(t);
  const first=await library.getItemRecord(id(3));await attach(links,first);assert.equal(await links.count(first.LinkedChildren),1n);assert.equal(frames.size,0);
  await database.update('BaseItems',{Id:id(3)},{Name:'fresh changed'});
  const second=await library.getItemRecord(id(3));assert.equal(second.Name,'fresh changed');assert.equal(first.LinkedChildren,EMPTY_NATIVE_LINKS,'replacement released the old raw branch');assert.equal(frames.size,0);
  assert.equal((await library.getItemRecord(id(4))).Type,'Audio');assert.equal((await library.getItemRecord(id(5))).Type,'Movie');
  await assert.rejects(library.getItemRecord(id(99)),error=>error.status===404);
  await database.update('BaseItems',{Id:id(5)},{Tags:'blocked'});
  const denied={Id:id(100),Policy:{EnableAllFolders:true,EnabledFolders:[],BlockedMediaFolders:[],BlockedTags:['blocked'],AllowedTags:[],BlockUnratedItems:[]},Configuration:{}};
  await assert.rejects(library.getItemRecord(id(5),{user:denied}),error=>error.status===404);assert.equal(frames.size,0);
  let captured;
  await assert.rejects(library.withItemRecord(id(3),{},async item=>{captured=item;await attach(links,item);for(let value=6;value<=12;value++)await library.getItemRecord(id(value));assert.equal(await links.count(item.LinkedChildren),1n);throw new Error('callback failure');}),/callback failure/);
  assert.equal(captured.LinkedChildren,EMPTY_NATIVE_LINKS,'callback owner survived eviction and was released on failure');assert.equal(frames.size,0);
});

test('postgres: library close drains an admitted raw record callback and rejects new lookup admission',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const{library,links,frames}=await fixture(t);let release,started;const wait=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  let item,finished=false;
  const operation=library.withItemRecord(id(3),{},async value=>{item=value;await attach(links,value);started();await wait;assert.equal(await links.count(value.LinkedChildren),1n);assert.equal((await library.getItemRecord(id(4))).Type,'Audio');});
  await ready;const closing=library.close().then(()=>{finished=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);await assert.rejects(library.getItemRecord(id(3)),error=>error.status===503);
  release();await operation;await closing;assert.equal(item.LinkedChildren,EMPTY_NATIVE_LINKS);assert.equal(frames.size,0);
});

test('postgres: a callback inherited from a finished parent cannot enter a closing library',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const{library}=await fixture(t);let release;
  const gate=new Promise(resolve=>{release=resolve;});let late;
  await library.withItemRecord(id(3),{},async()=>{late=gate.then(()=>library.getItemRecord(id(4)));});
  await library.close();release();await assert.rejects(late,error=>error.status===503);
});

test('postgres: close drains a nested operation admitted after its first pending-operation snapshot',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const{library}=await fixture(t);let begin,nestedRelease,parentReady,nestedReady;
  const parentGate=new Promise(resolve=>{begin=resolve;}),nestedGate=new Promise(resolve=>{nestedRelease=resolve;}),ready=new Promise(resolve=>{parentReady=resolve;}),started=new Promise(resolve=>{nestedReady=resolve;});
  let nested;
  const parent=library.withItemRecord(id(3),{},async()=>{parentReady();await parentGate;nested=library.withItemRecord(id(4),{},async item=>{nestedReady();await nestedGate;assert.equal(item.Type,'Audio');});await started;});
  await ready;let closed=false;const closing=library.close().then(()=>{closed=true;});begin();await parent;await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  nestedRelease();await nested;await closing;
});

test('postgres: query failure keeps its cause when actual PostgreSQL cleanup also fails',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const{library,frames}=await fixture(t),load=library.load.bind(library);
  library.load=async(...args)=>{const state=await load(...args),dispose=state.dispose.bind(state);state.dispose=async options=>{await dispose(options);await args[0].client.query('SELECT 1/0');};return state;};
  await assert.rejects(library.getItemRecord(id(99)),error=>error instanceof AggregateError&&error.cause?.status===404&&error.errors[0]===error.cause&&error.errors[1].code==='22012');
  assert.equal(frames.size,0);library.load=load;
});
