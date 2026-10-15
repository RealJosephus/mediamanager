import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { loadLibrary, idKey, nonemptyId } from '../../src/library/records.js';
import { preferredMetadataCountry, itemParentalRating } from '../../src/library/parental-rating.js';
import { collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { getRatingScore } from '../../src/core/localization-data.js';
import { sortMemoryItems } from '../../src/library/memory-sort.js';
import { observeComparison } from '../comparison-observations.js';

const fixture=JSON.parse(await readFile(new URL('./fixtures/metadata-country/native.json',import.meta.url),'utf8'));
assert.equal(fixture.summary.nativeVerified,true);assert.equal(fixture.summary.phaseAcceptance,false);
assert.deepEqual(fixture.summary.process,{code:0,signal:null});assert.equal(fixture.results.length,52);assert.equal(fixture.contextResults.length,5);assert.equal(fixture.resolverCases.length,280);
assert.equal(createHash('sha256').update(JSON.stringify(fixture.results)).digest('hex'),fixture.source.original52RowsSha256);
for(const [name,sha256] of Object.entries(fixture.source.oracleFiles))assert.equal(createHash('sha256').update(await readFile(new URL('./fixtures/metadata-country/'+name,import.meta.url))).digest('hex'),sha256,name);
for(const row of fixture.source.assemblies)assert.equal(row.loadedSha256,row.frozenSha256,row.name);
const columns=tableDefinition('BaseItems').columns.filter(column=>!column.generated),columnNames=new Set(columns.map(column=>column.name));
const empty=()=>Object.fromEntries(columns.map(column=>[column.name,column.nullable?null:column.clrType==='bool'?false:column.type==='TEXT'?'':column.clrType==='long'||column.clrType==='uint'?0n:0]));
const outcome=value=>Array.isArray(value)?value.map(outcome):value&&typeof value==='object'
  ?Object.hasOwn(value,'type')&&Object.hasOwn(value,'message')?{failed:true}:Object.fromEntries(Object.entries(value).map(([key,item])=>[key,outcome(item)])):value;
const equal=(left,right)=>JSON.stringify(outcome(left))===JSON.stringify(outcome(right));
const exception=error=>{
 assert.ok(error instanceof TypeError);assert.ok(error.message);
 return{type:error.nativeException?'System.'+error.nativeException:error.name,errorName:error.name,message:error.message};
};
const capture=callback=>{try{return{value:callback(),exception:null};}catch(error){return{value:null,exception:exception(error)};}};
const dialects=process.env.MEDIAMANAGER_COUNTRY_DIALECT?[process.env.MEDIAMANAGER_COUNTRY_DIALECT]:['postgres'];
if(dialects.some(dialect=>!['postgres'].includes(dialect)))throw new Error('Invalid country dialect.');
for(const dialect of dialects)test(dialect+': 52 country rows and five unknown-country memory contexts match frozen parents, paths, options and global values',{
 skip:dialect==='postgres'&&!process.env.MEDIAMANAGER_TEST_POSTGRES,
},async t=>{
 const schema='country_'+process.pid+'_'+randomBytes(4).toString('hex');
 const db=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true});
 const cases=[],differences=[],lazyProbes=[],cleanup={databaseClosed:false,schemasRemoved:false};
 try{
   for(const expected of [...fixture.results,...fixture.contextResults]){
   await db.client.query('DELETE FROM "AncestorIds"');await db.client.query('DELETE FROM "BaseItems"');
   const keys=new Set(expected.items.map(item=>idKey(item.Id))),placeholders=[];
   for(const item of expected.items)if(nonemptyId(item.ParentId)&&!keys.has(idKey(item.ParentId)))placeholders.push(item.ParentId);
   for(const Id of placeholders)await db.insert('BaseItems',{...empty(),Id,Type:'PLACEHOLDER',Data:'{}'});
   for(const item of expected.items){
    const row={...empty(),Name:item.Type,CleanName:item.Type.toLowerCase(),PresentationUniqueKey:item.Id,Data:JSON.stringify({PhysicalFolderIds:item.PhysicalFolderIds,PhysicalLocationsList:item.PhysicalLocationsList}),Tags:'',Genres:'',Studios:'',ProductionLocations:''};
    for(const [name,value] of Object.entries(item))if(columnNames.has(name))row[name]=name.endsWith('Id')&&!nonemptyId(value)?null:value;
    row.Type='MediaBrowser.Controller.Entities.'+(['Movie'].includes(item.Type)?'Movies.':['Episode','Season','Series'].includes(item.Type)?'TV.':'')+item.Type;
    if(!row.MediaType)row.MediaType=['Movie','Episode'].includes(item.Type)?'Video':'Unknown';await db.insert('BaseItems',row);
   }
   if(expected.spec.storedAncestor){const decoy=expected.items.find(item=>item.Type==='CollectionFolder'&&item.PreferredMetadataCountryCode==='US');await db.insert('AncestorIds',{ItemId:expected.itemId,ParentItemId:decoy.Id});}
    const state=await loadLibrary(db,{},dialect==='postgres'?{baseRows:await db.rows('BaseItems')}:{}),item=state.byId.get(idKey(expected.itemId)),anchor=state.byId.get(idKey(expected.anchorId));
   const libraryOptions=Object.fromEntries(expected.items.filter(item=>item.Type==='CollectionFolder').map(item=>[idKey(item.Id),{MetadataCountryCode:expected.optionsReadback.find(entry=>entry.path===item.Path+'\\options.xml')?.MetadataCountryCode??null}]));
   const options={libraryOptions,configuration:{MetadataCountryCode:expected.configurationReadback}};
   const rating=capture(()=>itemParentalRating(item,state,options));
   // This is the exact score/subscore formula of the recorded real comparer;
   // no HTTP or separate memory-sort coverage is claimed by this diagnostic.
   const comparison=capture(()=>{
    const left=getRatingScore(item.OfficialRating,preferredMetadataCountry(item,state,options),options.configuration.MetadataCountryCode)??{score:0,subScore:0};
    const right=getRatingScore(anchor.OfficialRating,preferredMetadataCountry(anchor,state,options),options.configuration.MetadataCountryCode)??{score:0,subScore:0};
    return Math.sign(left.score-right.score)||Math.sign((left.subScore??0)-(right.subScore??0));
   });
   const actual={country:preferredMetadataCountry(item,state,options),score:rating.value,scoreException:rating.exception,
    compare:comparison.value,compareException:comparison.exception,collectionFolders:collectionFoldersForItem(item,state).map(item=>item.Id)};
   observeComparison(t,expected.spec.name+' country diagnostics',actual,{country:expected.country,score:expected.score,scoreException:expected.scoreException,
    compare:expected.compare,compareException:expected.compareException,collectionFolders:expected.collectionFolders});
   if(expected.index>=52){
    const memory=capture(()=>sortMemoryItems([item,anchor],[{name:'officialrating',column:'OfficialRating',sign:1}],new Map(),()=>false,item=>item.SortName,
     {countryFor:entry=>preferredMetadataCountry(entry,state,options),defaultMetadataCountry:options.configuration.MetadataCountryCode}).map(entry=>entry.Id));
    const wanted=expected.compareException?null:expected.compare>0?[anchor.Id,item.Id]:[item.Id,anchor.Id];
    if(!equal(memory,{value:wanted,exception:expected.compareException}))differences.push({index:expected.index,name:expected.spec.name,field:'memoryCountryContext',expected:{value:wanted,exception:expected.compareException},actual:memory});
   }
   for(const name of Object.keys(actual))if(!equal(actual[name],expected[name]))differences.push({index:expected.index,name:expected.spec.name,field:name,expected:expected[name],actual:actual[name]===undefined?{$undefined:true}:actual[name]});
   cases.push({index:expected.index,name:expected.spec.name,actual,placeholderIds:placeholders});
   // Recorded call counts establish that native owns/near-parent values stop
   // before unrelated entity lookups, collection membership or option reads.
   if(expected.spec.name==='item/"AU"')lazyProbes.push(()=>{
    assert.equal(expected.countryCalls.GetCollectionFolders,undefined);
    assert.equal(preferredMetadataCountry(item,{get byId(){throw new Error('Unexpected parent read');},get items(){throw new Error('Unexpected root read');}},
     {get libraryOptions(){throw new Error('Unexpected options read');},get configuration(){throw new Error('Unexpected configuration read');}}),'AU');
   });
   if(expected.spec.name==='parent/"AU"')lazyProbes.push(()=>{
    assert.equal(expected.countryCalls.GetCollectionFolders,undefined);
    const oneParent={...state,byId:{get:key=>{if(key!==idKey(item.ParentId))throw new Error('Unexpected farther parent read');return state.byId.get(key);}}};
    assert.equal(preferredMetadataCountry(item,oneParent,options),'AU');
   });
  }
  for(const verify of lazyProbes)verify();
 }finally{
  if(dialect==='postgres'){
   await db.client.query('DROP SCHEMA '+quoteIdentifier(db.schemaName)+' CASCADE');await db.client.query('DROP SCHEMA '+quoteIdentifier(db.controlSchema)+' CASCADE');
   cleanup.schemasRemoved=(await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',[[db.schemaName,db.controlSchema]])).rows.length===0;
  }
  await db.close();cleanup.databaseClosed=true;
  if(process.env.MEDIAMANAGER_COUNTRY_ARTIFACT_DIR){const directory=path.resolve(process.env.MEDIAMANAGER_COUNTRY_ARTIFACT_DIR);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,dialect+'.json'),JSON.stringify({phaseAcceptance:false,dialect,schema,cases,differences,cleanup},null,2)+'\n');}
 }
 assert.deepEqual(cleanup,{databaseClosed:true,schemasRemoved:true});assert.equal(cases.length,57);assert.deepEqual(differences,[]);
});

test('280 actual DLL rating rows preserve configured null/empty lookup, unknown-country prefix fallback and early returns',t=>{
 const differences=[];
 for(const expected of fixture.resolverCases){
  assert.equal(expected.globalReadback,expected.global);
  const actual=capture(()=>getRatingScore(expected.rating,expected.country,expected.global));
  observeComparison(t,'rating '+expected.rating,actual,{value:expected.score,exception:expected.exception});
  if(!equal(actual,{value:expected.score,exception:expected.exception}))differences.push({rating:expected.rating,country:expected.country,global:expected.global,expected:{value:expected.score,exception:expected.exception},actual});
 }
 assert.deepEqual(differences,[]);
});
