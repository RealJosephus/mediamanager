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
import { cleanValue, idKey } from '../../src/library/records.js';
import { collectionFoldersForItem, parentChainForItem } from '../../src/library/collection-membership.js';
import { visibleItem } from '../../src/library/permissions.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';

const fixture=JSON.parse(await readFile(new URL('./fixtures/collection-membership/native.json',import.meta.url),'utf8'));
assert.equal(fixture.summary.nativeVerified,true);
assert.equal(fixture.summary.phaseAcceptance,false);
assert.deepEqual(fixture.summary.processResult,{code:0,signal:null});
assert.equal(fixture.results.length,30);
for(const [name,expected] of Object.entries(fixture.source.oracleFiles))assert.equal(createHash('sha256')
  .update(await readFile(new URL('./fixtures/collection-membership/'+name,import.meta.url))).digest('hex'),expected,name);
for(const assembly of fixture.source.frozenAssemblies)assert.equal(assembly.sha256,assembly.originalSha256,assembly.name);

const {ids,paths}=fixture.input;
const emptyRow=table=>Object.fromEntries(tableDefinition(table).columns.filter(column=>!column.generated)
  .map(column=>[column.name,column.nullable?null:column.clrType==='bool'?false:column.type==='TEXT'?''
    :column.clrType==='uint'||column.clrType==='long'?0n:0]));
const row=(name,type,extra={})=>({...emptyRow('BaseItems'),Id:ids[name],PresentationUniqueKey:ids[name],
  Type:`MediaBrowser.Controller.Entities.${type==='Movie'?'Movies.Movie':type}`,Name:name,CleanName:cleanValue(name),
  SortName:name,IsFolder:type!=='Movie',MediaType:type==='Movie'?'Video':'Unknown',Data:'{}',Tags:'',Genres:'',Studios:'',ProductionLocations:'',Path:paths[name],...extra});
const accountFor=policy=>({Id:ids.user,Username:'Readonly',MaxParentalRatingScore:null,MaxParentalRatingSubScore:null,
  Policy:{EnableAllFolders:['all-folders','blocked-library-tag'].includes(policy),
    EnabledFolders:policy==='enabled-library'?[ids.collection]:[],
    BlockedMediaFolders:policy==='blocked-library'?[ids.collection]:policy==='blocked-unrelated'?[fixture.input.unrelatedBlockedId]:[],
    BlockedTags:policy==='blocked-library-tag'?['blocked-library']:[],AllowedTags:[],BlockUnratedItems:[],
    EnableContentDeletion:false,EnableContentDeletionFromFolders:[ids.collection]},Configuration:{}});
const dialects=process.env.MEDIAMANAGER_COLLECTION_MEMBERSHIP_DIALECT?[process.env.MEDIAMANAGER_COLLECTION_MEMBERSHIP_DIALECT]:['postgres'];
if(dialects.some(dialect=>!['postgres'].includes(dialect)))throw new Error('Invalid membership dialect.');

for(const dialect of dialects)test(`${dialect}: collection membership, standalone visibility and deletion match 30 frozen entity cases`,{
  skip:dialect==='postgres'&&!process.env.MEDIAMANAGER_TEST_POSTGRES,
},async()=>{
  const schema='collection_'+process.pid+'_'+randomBytes(4).toString('hex');
  const db=await PostgresDatabase.open({
    connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true});
  const store=new DomainStore(db);
  const library=new LibraryService({fileSystem: testFileSystem, store,serverId:'membership-dll-regression',programDataPath:'D:/unused-instance'});
  const cases=[],differences=[];
  const cleanup={libraryClosed:false,databaseClosed:false,schemasRemoved:false};
  try{
    for(const item of [row('aggregate','AggregateFolder'),row('userRoot','UserRootFolder'),
      row('physical','Folder',{ParentId:ids.aggregate,TopParentId:ids.physical}),
      row('collection','CollectionFolder',{ParentId:ids.userRoot}),
      row('movie','Movie',{ParentId:ids.physical,TopParentId:ids.physical,UnratedType:'Movie',Data:'{"VideoType":"VideoFile"}'})])await db.insert('BaseItems',item);
    await db.insert('Users',{...emptyRow('Users'),Id:ids.user,Username:'Readonly',NormalizedUsername:'READONLY',InternalId:1});
    await db.insert('AncestorIds',{ItemId:ids.movie,ParentItemId:ids.physical});
    for(const expected of fixture.results){
      const user=accountFor(expected.policy);
      await db.update('BaseItems',{Id:ids.collection},{Tags:expected.policy==='blocked-library-tag'?'blocked-library':'',
        Data:JSON.stringify({CollectionType:fixture.input.collectionType,PhysicalFolderIds:expected.physicalFolderIds,PhysicalLocationsList:expected.physicalLocations})});
      const state=await store.run(async database=>library.load(database,user,{includeUserData:false,baseRows:await database.rows('BaseItems')}));
      const movie=state.byId.get(idKey(ids.movie)),collection=state.byId.get(idKey(ids.collection));
      const dto=await projectItem(movie,state,user,dtoOptions({fields:['CanDelete'],enableimages:false,enableuserdata:false}),library.options);
      const actual={collectionFolders:collectionFoldersForItem(movie,state).map(item=>item.Id),
        serviceCollectionFolders:(await library.getCollectionFolders(movie)).map(item=>item.Id),
        inheritedTags:[...new Set([movie,...parentChainForItem(movie,state),...collectionFoldersForItem(movie,state)].flatMap(item=>item.Tags))],
        parents:parentChainForItem(movie,state).map(item=>item.Id),
        collectionVisible:visibleItem(collection,user,state,{...library.options,query:false,checkStandaloneParents:false}),
        itemVisible:visibleItem(movie,user,state,{...library.options,query:false,checkStandaloneParents:false}),
        itemVisibleStandalone:visibleItem(movie,user,state,{...library.options,query:false}),canDelete:dto.CanDelete};
      for(const field of Object.keys(actual)){
        const wanted=expected[field==='serviceCollectionFolders'?'collectionFolders':field];
        if(JSON.stringify(actual[field])!==JSON.stringify(wanted))differences.push({case:cases.length,field,expected:wanted,actual:actual[field]});
      }
      const access={};
      try{access.record={returned:(await library.getItemRecord(ids.movie,{user})).Id};}
      catch(error){access.record={error:error.message,status:error.status};}
      try{const single=await library.getItem(ids.movie,{user,Fields:'CanDelete',EnableImages:false,EnableUserData:false});access.dto={Id:single.Id,CanDelete:single.CanDelete};}
      catch(error){access.dto={error:error.message,status:error.status};}
      if(expected.itemVisibleStandalone){
        if(access.record.returned!==ids.movie)differences.push({case:cases.length,field:'itemRecord',expected:ids.movie,actual:access.record});
        if(access.dto.Id!==ids.movie.replaceAll('-','')||access.dto.CanDelete!==expected.canDelete)differences.push({case:cases.length,field:'itemDto',expected:{Id:ids.movie.replaceAll('-',''),CanDelete:expected.canDelete},actual:access.dto});
      }else if(access.record.status!==404||access.dto.status!==404)differences.push({case:cases.length,field:'itemAccess',expected:404,actual:access});
      cases.push({pathMode:expected.pathMode,storedMode:expected.storedMode,policy:expected.policy,actual,access});
    }
  }finally{
    await library.close();cleanup.libraryClosed=true;
    if(dialect==='postgres'){
      await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.schemaName)} CASCADE`);
      await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.controlSchema)} CASCADE`);
      cleanup.schemasRemoved=(await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',[[db.schemaName,db.controlSchema]])).rows.length===0;
    }
    await store.close();cleanup.databaseClosed=true;
    if(process.env.MEDIAMANAGER_COLLECTION_MEMBERSHIP_ARTIFACT_DIR){
      const directory=path.resolve(process.env.MEDIAMANAGER_COLLECTION_MEMBERSHIP_ARTIFACT_DIR);
      await mkdir(directory,{recursive:true});
      await writeFile(path.join(directory,dialect+'.json'),JSON.stringify({dialect,schema,cases,differences,cleanup,phaseAcceptance:false},null,2)+'\n');
    }
  }
  assert.deepEqual(cleanup,{libraryClosed:true,databaseClosed:true,schemasRemoved:true});
  assert.equal(cases.length,30);
  assert.deepEqual(differences,[]);
});
