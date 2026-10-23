import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {tableDefinition} from '../../src/database/model.js';
import {idKey} from '../../src/library/records.js';
import {recordItemFilterCandidate} from './item-filter-http-scenario.js';
import {validationOutputRoot} from '../../tools/validation/paths.js';
import {writeHttpEndpointEvidence} from './http-endpoint-evidence.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,value])=>[key,key==='ServerId'?'$server':normalize(value)])):value;
const columns=tableDefinition('BaseItems').columns;
const scopes={main:'All30 memory keys plus six new repository keys and four null-user SQL negative keys; directions, opposite Name secondary and empty results. Eleven media tables + UserData native invariants; candidate additional ApiKeys, full four domains and cleanup.',edges:'First128 realHTTP with directions/Default/SeriesDatePlayed mixed keys, omitted/empty/whitespace/nonblank SearchTerm. Original seeder coalesced explicit PresentationUniqueKey null to id; this leaf does not prove NULL groups.', 'edges-null':'Second128 independent realHTTP preserving 32 outer PresentationUniqueKey NULL rows and played NULL SeriesPresentationUniqueKey; whitespace search bypasses provider, actual correlated SQL NULL equality versus noSearch preaggregation excludes NULL. Original128 raw unchanged.',search:'Initial80 independent SearchProvider HTTP: four score tiers, OriginalTitle-only, diacritics/trim, noIds/Ids union, limit*3/default100/start/page/zero, nohits/whitespace, type/media and stable random equal-key group ordering.', 'search-null':'Second88 independent SearchProvider HTTP preserving Movie MediaType=NULL; Video provider and repository filters reject raw NULL despite Movie entity DTO MediaType Video. Includes prior80 scenarios, source/raw initial failures preserved.',redirect:'Eight actual search requests under movies CollectionFolder redirect to root for BoxSet/Playlist, linked child ancestor constraint, noIds/Ids union, user/API key and private Playlist DTO visibility with query count unchanged.'};
for(const [scenario,count,nativeHash,inputHash]of [["main",1216,"e31ca371e5c02c3f4bba16efc9cd98e381114253abfd8362bb9d5dab74528bc4","bef410309698f51a766e79f2cc57cd85907f82baa9b70f1b9351a4c1e9802434"],["edges",128,"b9b527ca9b1b4434d9c47ce0c8f0857c91950572e0534ceaf1172526d90bf183","af70a6cf73b85d72483452e63269a817defe404e1215baaf517153df73a16e75"],["edges-null",128,"c0db49a3146bb31f3bf24edb151ff592d66b4cafa5894cb2b207958f41dbd885","af70a6cf73b85d72483452e63269a817defe404e1215baaf517153df73a16e75"],["search",80,"2f3991d511ece70fb3bf629d7c5962a32bdbd93fd7040ee6f71ecd721d4735ef","cca35f4fed9f4989e612b620a54097eeca1160f0bc969c4545fa89249f5d02bc"],["search-null",88,"c98c33438887b3a38f6c3dc8e3eafc5c596cb947a3271912792ab347984ef4ab","5077d689a9552a738076d9ce0c1ea3aaac1178d58325e55431c915ed04e5b209"],["redirect",8,"e8894d66fabd4b5a560ff18c670bec45185b352a1b54d64f22d62dbb1ffb5513","95d1ec8a342d69433979388005262278759f2b2e5f6975c7c7fe57d08553f686"]]){
 const bytes=await readFile(new URL(`./fixtures/memory-sort-full/${scenario}-native.json`,import.meta.url)),inputBytes=await readFile(new URL(`./fixtures/memory-sort-full/${scenario}-input.json`,import.meta.url));
 assert.equal(sha(bytes),nativeHash);assert.equal(sha(inputBytes),inputHash);
 const native=JSON.parse(bytes),fixture=JSON.parse(inputBytes);
 assert.equal(native.frozenJellyfin,true);assert.equal(native.audit.passed,true);assert.equal(native.inputSha256,inputHash);assert.equal(native.audit.responses,count);assert.equal(native.audit.endpointSnapshots,count);assert.equal(native.audit.completeStageWindows,3);assert.equal(native.audit.allRecordedStateEqual,true);assert.equal(native.audit.tables.length,12);assert.equal(native.audit.processReclaimed,true);
 if(scenario==='main'){assert.equal(native.summary.passed,false);assert.deepEqual(native.audit.statusCounts,{200:1088,400:64,500:64});}
 for(const dialect of ['postgres'])test(`${dialect}: ${scenario} full frozen HTTP sort matrix (${count} responses and endpoint states)`,{skip:dialect==='postgres'&&!process.env.MEDIAMANAGER_TEST_POSTGRES},async()=>{
  const actual=await recordItemFilterCandidate({dialect,connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,fixture,scenarioName:'memory-sort-full-'+scenario,fields:'SortName',
   captureOrder:true,captureStartIndex:true,captureSortNames:true,captureResponseBodies:true,captureEndpointStages:true,captureCaseRuntimeErrors:true,captureFilesystemDomains:true,trackFilesystem:true,trackUserData:true,
   configuration:{EnableGroupingMoviesIntoCollections:false,EnableGroupingShowsIntoCollections:false},
   prepareScenario:async({database,programDataPath,user})=>{
    const paths={userRoot:path.join(programDataPath,'root/default'),physicalA:path.join(programDataPath,'library-content/A'),physicalB:path.join(programDataPath,'library-content/B'),collections:path.join(programDataPath,'data/collections'),libraryA:path.join(programDataPath,'root/default/Library A'),libraryB:path.join(programDataPath,'root/default/Library B'),collectionLibrary:path.join(programDataPath,'root/default/Collection Library')};
    for(const value of Object.values(paths))await mkdir(value,{recursive:true});
    const itemPath=item=>paths[item.pathKind]??(item.pathKind==='boxset'?path.join(paths.collections,item.key):item.pathKind==='child'?path.join(itemPath(fixture.items.find(row=>row.id===item.parentId)),item.key+(item.type==='Movie'?'.mkv':'')):path.join(paths.physicalA,item.key));
    for(const item of fixture.items){if(item.type==='AggregateFolder')continue;const row=native.seedBaseItems.find(row=>idKey(row.Id)===idKey(item.id));assert.ok(row,item.key);
     const values=Object.fromEntries(columns.filter(column=>!['Id','ParentId','TopParentId','Path','Data'].includes(column.name)).map(column=>[column.name,column.clrType.replace('?','')==='long'&&row[column.name]!=null?BigInt(row[column.name]):row[column.name]]));
     const data=JSON.parse(row.Data??'{}');if(item.type==='CollectionFolder')data.PhysicalLocationsList=data.PhysicalFolderIds.map(id=>itemPath(fixture.items.find(row=>idKey(row.id)===idKey(id))));
     await database.update('BaseItems',{Id:item.id},{...values,Path:itemPath(item),Data:JSON.stringify(data)});
    }
    for(const row of fixture.userData){const item=fixture.items.find(item=>item.key===row.itemKey);await database.insert('UserData',{ItemId:item.id,UserId:user.Id,CustomDataKey:item.id,AudioStreamIndex:null,SubtitleStreamIndex:null,IsFavorite:row.isFavorite,LastPlayedDate:row.lastPlayedDate,Likes:row.likes??null,PlayCount:row.playCount,PlaybackPositionTicks:BigInt(row.positionTicks),Played:row.played,Rating:null,RetentionDate:null});}
   }});
  const differences=[];const check=(name,scope,fn)=>{try{fn();}catch(error){differences.push({name,scope,message:error.message});}};
  check('matrix','complete response/stage count',()=>{assert.equal(actual.httpCases,count);assert.equal(actual.caseStages.length,count);});
  const endpoints=actual.cases.flatMap(item=>item.endpoints.map(endpoint=>({name:item.name,...endpoint})));
  for(const [i,endpoint]of endpoints.entries())check(endpoint.name,'complete status/content type/body/diagnostics',()=>{
   const record=native.http.records[i],response=native.http.responses[record.responseIndex],input=fixture.cases[i];assert.deepEqual([endpoint.name,endpoint.endpoint],[record.name,record.endpoint]);assert.equal(endpoint.response.status,response.status);assert.equal(endpoint.response.contentType,response.contentType);
   if(response.status>=400)assert.equal(endpoint.response.bodyText,response.bodyText);
   else{
    const expected=normalize(response.bodyJson),observed=normalize(endpoint.response.body);
    const query=new URLSearchParams(input.query),random=(query.get('SortBy')??'').split(',').includes('Random');
    if(random&&query.get('SearchTerm')?.trim()){
     const term=query.get('SearchTerm').trim().normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
     const groups=body=>{const result=[];for(const dto of body.Items){const item=native.seedBaseItems.find(row=>idKey(row.Id)===idKey(dto.Id));assert.ok(item);const clean=item.CleanName??'';const score=clean===term?100:clean.startsWith(term)?80:clean.includes(term+' ')?75:50;
      const key=JSON.stringify([score,dto.SortName]);if(result.at(-1)?.key!==key)result.push({key,Items:[]});result.at(-1).Items.push(dto);
     }return result.map(group=>({...group,Items:group.Items.sort((a,b)=>a.Id.localeCompare(b.Id))}));};
     assert.deepEqual({...observed,Items:groups(observed)},{...expected,Items:groups(expected)});
    }else{
     if(random){expected.Items.sort((a,b)=>a.Id.localeCompare(b.Id));observed.Items.sort((a,b)=>a.Id.localeCompare(b.Id));}
     assert.deepEqual(observed,expected);
    }
   }
   const errors=response.status===400?[{name:'Error',message:`Sort key '${input.sortKey}' requires a user, but none was provided.`}]:response.status===500?[{name:'Error',message:'Error processing request.'}]:[];
   assert.deepEqual(endpoint.runtimeErrors,errors);
  });
  for(const [i,stage]of actual.caseStages.entries())check(stage.name,'complete candidate media/UserData/four-domain state at endpoint',()=>{
   assert.deepEqual([stage.name,stage.endpoint],[native.http.records[i].name,native.http.records[i].endpoint]);
   for(const timing of ['before','after']){assert.deepEqual(stage[timing].database,actual.beforeReads);assert.deepEqual(stage[timing].userData,actual.userDataBeforeReads);assert.deepEqual(stage[timing].filesystemDomains,actual.filesystemDomainsBeforeReads);}
  });
  check('shutdown','state after all hosts stopped',()=>{assert.deepEqual(actual.afterReads,actual.beforeReads);assert.deepEqual(actual.afterShutdown,actual.beforeReads);assert.deepEqual(actual.userDataAfterReads,actual.userDataBeforeReads);assert.deepEqual(actual.userDataAfterShutdown,actual.userDataBeforeReads);assert.deepEqual(actual.filesystemDomainsAfterReads,actual.filesystemDomainsBeforeReads);assert.deepEqual(actual.filesystemDomainsAfterShutdown,actual.filesystemDomainsBeforeReads);});
  check('cleanup','owned resources',()=>assert.deepEqual(actual.cleanup,{runtimeClosed:true,databaseClosed:true,portReleased:true,postgresSchemasRemoved:dialect==='postgres'?true:null,programDataDirectoryRemoved:true}));
  check('runtime','unexpected diagnostics',()=>{assert.deepEqual(actual.runtimeErrors,[]);assert.deepEqual(actual.handledExpectedRuntimeErrors,[]);});
  const output=process.env.MEDIAMANAGER_MEMORY_SORT_FULL_EVIDENCE??path.join(validationOutputRoot(),'memory-sort-full');
  await writeHttpEndpointEvidence(path.resolve(output,scenario),dialect,actual,{passed:differences.length===0,phaseAcceptance:false,dialect,responses:count,endpointSnapshots:count,nativeSha256:sha(bytes),inputSha256:sha(inputBytes),testSha256:sha(await readFile(new URL(import.meta.url))),harnessSha256:sha(await readFile(new URL('./item-filter-http-scenario.js',import.meta.url))),normalization:'Only isolated ServerId. Ordinary Random compares full DTO members with raw permutation retained. Search+Random permits permutations solely within adjacent equal source score and exact materialized SortName groups, preserving every other group order and full DTO field. No business fields omitted.',scope:scopes[scenario],differences,cleanup:actual.cleanup});
  assert.equal(differences.length,0,JSON.stringify(differences.slice(0,2)));
 });
}
