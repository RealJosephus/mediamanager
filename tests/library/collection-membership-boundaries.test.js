import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { idKey } from '../../src/library/records.js';
import { collectionFoldersForItem, userRootFolders } from '../../src/library/collection-membership.js';

const reference=JSON.parse(await readFile(new URL('./fixtures/collection-membership-boundaries/native.json',import.meta.url),'utf8'));
assert.equal(reference.summary.nativeVerified,true);assert.equal(reference.summary.phaseAcceptance,false);
assert.equal(reference.nullable.length,36);assert.equal(reference.librarySeed.length,16);
assert.deepEqual(reference.summary.processResult,{code:0,signal:null});
for(const [name,hash] of Object.entries(reference.source.oracleFiles))assert.equal(createHash('sha256')
 .update(await readFile(new URL('./fixtures/collection-membership-boundaries/'+name,import.meta.url))).digest('hex'),hash,name);
for(const assembly of reference.source.assemblies)assert.equal(assembly.loadedSha256,assembly.frozenSha256,assembly.name);
const id=index=>'84000000-0000-0000-0000-'+String(index).padStart(12,'0');
const emptyRow=table=>Object.fromEntries(tableDefinition(table).columns.filter(column=>!column.generated).map(column=>[column.name,
 column.nullable?null:column.clrType==='bool'?false:column.type==='TEXT'?'':column.clrType==='long'||column.clrType==='uint'?0n:0]));
const row=(index,Type,extra={})=>({...emptyRow('BaseItems'),Id:id(index),PresentationUniqueKey:id(index),
 Type:'MediaBrowser.Controller.Entities.'+Type,IsFolder:true,Name:Type,CleanName:Type.toLowerCase(),SortName:Type.toLowerCase(),
 MediaType:'Unknown',Data:'{}',Tags:'',Genres:'',Studios:'',ProductionLocations:'',...extra});
const dialects=process.env.MEDIAMANAGER_MEMBERSHIP_BOUNDARIES_DIALECT?[process.env.MEDIAMANAGER_MEMBERSHIP_BOUNDARIES_DIALECT]:['postgres'];
if(dialects.some(dialect=>!['postgres'].includes(dialect)))throw new Error('Invalid boundaries dialect.');
for(const dialect of dialects)test(dialect+': root-child scope, 36 nullable path rows and ignored alias match frozen DLL',{
 skip:dialect==='postgres'&&!process.env.MEDIAMANAGER_TEST_POSTGRES,
},async()=>{
 const schema='member_bounds_'+process.pid+'_'+randomBytes(4).toString('hex');
 const db=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true});
 const store=new DomainStore(db);
 let library,itemCreation,linkedChildren,state;
 const cases=[],differences=[],cleanup={libraryClosed:false,databaseClosed:false,schemasRemoved:false};
 try{
  linkedChildren=new PostgresLinkedChildrenStore({database:db});await linkedChildren.initialize();
  library=new LibraryService({fileSystem:testFileSystem,store,linkedChildren,serverId:'membership-boundaries-test'});
  itemCreation=new ItemCreationService({store,library,linkedChildren,loadContext:async()=>{
   throw new Error('Metadata mutation is outside the nullable collection membership scenario.');
  }});library.itemCreation=itemCreation;
  for(const item of [row(1,'UserRootFolder'),row(2,'Folder'),row(3,'CollectionFolder',{ParentId:id(1)})])await db.insert('BaseItems',item);
  for(const expected of reference.nullable){
   await db.update('BaseItems',{Id:id(2)},{Path:expected.rootPath});
   await db.update('BaseItems',{Id:id(3)},{Path:expected.collectionPath,Data:JSON.stringify({PhysicalFolderIds:[id(2)],PhysicalLocationsList:expected.locations})});
   state=await store.run(async database=>library.load(database,null,{includeUserData:false,baseRows:await database.rows('BaseItems')}));
   const physical=state.byId.get(idKey(id(2)));
   const actual={helper:collectionFoldersForItem(physical,state).map(folder=>folder.Id),service:(await library.getCollectionFolders(physical)).map(folder=>folder.Id)};
   for(const [field,ids] of Object.entries(actual))if(JSON.stringify(ids)!==JSON.stringify(expected.collectionFolders))differences.push({case:cases.length,field,expected:expected.collectionFolders,actual:ids});
   cases.push({rootPath:expected.rootPath,collectionPath:expected.collectionPath,locations:expected.locations,actual});
   await state.dispose();state=null;
  }
  await db.delete('BaseItems',{Id:id(3)});
  await db.insert('BaseItems',row(4,'CollectionFolder',{ParentId:id(1),Path:'Z:\\Library',Data:reference.alias.json}));
  const aliasFolders=await library.getCollectionFolders(await library.getItemRecord(id(2)));
  if(JSON.stringify(aliasFolders.map(folder=>folder.Id))!==JSON.stringify(reference.alias.collectionFolders))differences.push({field:'ignoredAlias',expected:reference.alias.collectionFolders,actual:aliasFolders.map(folder=>folder.Id)});
  await db.delete('BaseItems',{Id:id(4)});await db.delete('BaseItems',{Id:id(2)});await db.delete('BaseItems',{Id:id(1)});
  for(const item of [row(11,'UserRootFolder'),row(12,'AggregateFolder'),row(13,'Folder',{ParentId:id(12),Path:'Z:\\Refresh'}),
   row(14,'CollectionFolder',{ParentId:id(11),Data:JSON.stringify({PhysicalLocationsList:['z:/refresh/']})}),
   row(15,'CollectionFolder',{ParentId:id(12),Data:JSON.stringify({PhysicalLocationsList:['Z:\\Refresh']})})])await db.insert('BaseItems',item);
  state=await store.run(async database=>library.load(database,null,{includeUserData:false,baseRows:await database.rows('BaseItems')}));
  const children=userRootFolders(state).map(item=>item.Id);
  if(JSON.stringify(children)!==JSON.stringify(reference.scope.rootChildren))differences.push({field:'rootChildren',expected:reference.scope.rootChildren,actual:children});
  const physical=state.byId.get(idKey(id(13)));
  const scopeFolders=await library.getCollectionFolders(physical);
  if(JSON.stringify(scopeFolders.map(item=>item.Id))!==JSON.stringify(reference.scope.rootChildMembership))differences.push({field:'rootScope',expected:reference.scope.rootChildMembership,actual:scopeFolders.map(item=>item.Id)});
  const explicit=collectionFoldersForItem(physical,state,[state.byId.get(idKey(id(14))),state.byId.get(idKey(id(15)))]).map(item=>item.Id);
  if(JSON.stringify(explicit)!==JSON.stringify(reference.scope.explicitlyIncludingNested))differences.push({field:'explicitNested',expected:reference.scope.explicitlyIncludingNested,actual:explicit});
  await state.dispose();state=null;
  // Source GetCachedChildren uses Parent=this and default binary SortName. No
  // by-type or virtual-root fallback participates in this entity Children path.
  await db.update('BaseItems',{Id:id(14)},{SortName:'z'});
  await db.insert('BaseItems',row(16,'Folder',{ParentId:id(11),SortName:'A'}));
  await db.insert('BaseItems',row(17,'PlaylistsFolder',{ParentId:id(12),SortName:null}));
  await db.insert('BaseItems',row(18,'Folder',{ParentId:id(11),SortName:null}));
  state=await store.run(async database=>library.load(database,null,{includeUserData:false,baseRows:await database.rows('BaseItems')}));
  assert.deepEqual(userRootFolders(state).map(item=>item.Id),[id(18),id(16),id(14)]);
  assert.deepEqual(userRootFolders({...state,items:state.items.filter(item=>item.Type!=='UserRootFolder')}),[]);
 }finally{
  await state?.dispose();await itemCreation?.close();await library?.close();cleanup.libraryClosed=true;
  await linkedChildren?.close();
  if(dialect==='postgres'){
   await db.client.query('DROP SCHEMA '+quoteIdentifier(db.schemaName)+' CASCADE');
   await db.client.query('DROP SCHEMA '+quoteIdentifier(db.controlSchema)+' CASCADE');
   cleanup.schemasRemoved=(await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',[[db.schemaName,db.controlSchema]])).rows.length===0;
  }
  await store.close();cleanup.databaseClosed=true;
  if(process.env.MEDIAMANAGER_MEMBERSHIP_BOUNDARIES_ARTIFACT_DIR){
   const directory=path.resolve(process.env.MEDIAMANAGER_MEMBERSHIP_BOUNDARIES_ARTIFACT_DIR);await mkdir(directory,{recursive:true});
   await writeFile(path.join(directory,dialect+'.json'),JSON.stringify({phaseAcceptance:false,dialect,schema,cases,differences,cleanup},null,2)+'\n');
  }
 }
 assert.deepEqual(cleanup,{libraryClosed:true,databaseClosed:true,schemasRemoved:true});assert.equal(cases.length,36);assert.deepEqual(differences,[]);
});
