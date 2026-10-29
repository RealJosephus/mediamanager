import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {observeComparison} from '../comparison-observations.js';
import {tableDefinition} from '../../src/database/model.js';
import {idKey} from '../../src/library/records.js';
import {parseQuery,sortItems} from '../../src/library/query.js';
import {recordItemFilterCandidate} from './item-filter-http-scenario.js';
import {projectItemBody} from '../helpers/http-body-projection.js';
import {projectItemDataIdentities} from '../helpers/fixture-identity-projection.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item,2)+'\n';
const inputBytes=await readFile(new URL('./fixtures/sort-binding/input.json',import.meta.url));
const nativeBytes=await readFile(new URL('./fixtures/sort-binding/native.json',import.meta.url));
assert.equal(sha(inputBytes),'a4e77c6dd0328e33c60319124000a27f889093d9bddc0d6bfa380f796d3686c9');
assert.equal(sha(nativeBytes),'d9a371ceb0b9965a8f368f5b5ce598564ebffb281e9da47d2cfd27edeb8b4e1b');
const fixture=JSON.parse(inputBytes),native=JSON.parse(nativeBytes);
const observedNativeServerId=native.http.responses.flatMap(response=>response.bodyJson?.Items??[]).find(item=>typeof item.Id==='string'&&typeof item.Type==='string')?.ServerId;
assert.equal(typeof observedNativeServerId,'string');
const columns=tableDefinition('BaseItems').columns;

test('actual ASP enum binding and GetOrderBy: 128 original cases and two partial-direction DLL controls',t=>{
  assert.equal(native.frozenJellyfin,true);assert.equal(native.audit.passed,true);assert.equal(native.summary.passed,false);
  assert.deepEqual(native.audit.statusCounts,{200:252,400:4});assert.equal(native.audit.endpointSnapshots,256);
  assert.equal(native.audit.completeStageWindows,3);assert.equal(native.audit.allRecordedStateEqual,true);
  assert.equal(native.audit.processReclaimed,true);assert.equal(native.audit.tables.length,12);
  assert.equal(native.converters.rows.length,128);assert.equal(native.converters.partialDirections.length,2);
  for(const row of [...native.converters.rows,...native.converters.partialDirections]){
    assert.equal(row.modelStateInvalid,false);
    if(row.error){
      assert.throws(()=>parseQuery(new URLSearchParams(row.query)),error=>{
        assert.equal(error.status,400);
        observeComparison(t,row.name+' binding error',{name:error.name,message:error.message,nativeException:error.nativeException,parameterName:error.parameterName},row.error);
        return true;
      },row.name);
      continue;
    }
    const query=parseQuery(new URLSearchParams(row.query));
    assert.deepEqual(query.sortby??[],row.by.map(value=>value.name),row.name+': keys');
    assert.deepEqual(query.sortorder??[],row.order.map(value=>value.name),row.name+': directions');
    const result=(query.sortby??[]).map((name,i)=>({name,direction:query.sortorder?.[i]??query.sortorder?.[0]??'Ascending'}));
    assert.deepEqual(result,row.result.map(({name,direction})=>({name,direction})),row.name+': GetOrderBy');
  }
  // A third comparer inherits the first of two directions; this control makes
  // the preceding keys equal so the inherited direction changes the result.
  const items=[{Id:'a',ProductionYear:2000,CleanName:'same',Name:'same',RunTimeTicks:1},{Id:'b',ProductionYear:2000,CleanName:'same',Name:'same',RunTimeTicks:2}];
  const query=parseQuery(new URLSearchParams(native.converters.partialDirections[0].query));
  assert.deepEqual(sortItems(items,query,new Map(),()=>false).map(item=>item.Id),['b','a']);
});

for(const dialect of ['postgres'])test(`${dialect}: 256 full native numeric, invalid and repeated SortBy/SortOrder HTTP responses`,{
  skip:dialect==='postgres'&&!process.env.MEDIAMANAGER_TEST_POSTGRES,
},async t=>{
  const queryFailures=new Map(),observedRuntimes=new WeakSet();let currentCase;
  const actual=await recordItemFilterCandidate({dialect,connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,fixture,
    scenarioName:'sort-asp-binding',fields:'SortName',captureOrder:true,captureStartIndex:true,captureSortNames:true,
    captureResponseBodies:true,captureEndpointStages:true,captureCaseRuntimeErrors:true,captureFilesystemDomains:true,
    trackFilesystem:true,trackUserData:true,configuration:{EnableGroupingMoviesIntoCollections:false,EnableGroupingShowsIntoCollections:false},
    prepareCase:({testCase,runtime})=>{
      currentCase=testCase.name;
      if(observedRuntimes.has(runtime))return;
      observedRuntimes.add(runtime);
      const query=runtime.library.queryItems;
      runtime.library.queryItems=async function(...args){
        try{return await query.apply(this,args);}
        catch(error){
          const failure={message:error.message,status:error.status??error.statusCode??500,code:error.code??null};
          const failures=queryFailures.get(currentCase)??[];failures.push(failure);queryFailures.set(currentCase,failures);
          observeComparison(t,currentCase+' actual query failure',{...failure,name:error.name,stack:error.stack},null);
          throw error;
        }
      };
    },
    prepareScenario:async({database,programDataPath,user})=>{
      const paths={userRoot:path.join(programDataPath,'root/default'),physicalA:path.join(programDataPath,'library-content/A'),physicalB:path.join(programDataPath,'library-content/B'),
        collections:path.join(programDataPath,'data/collections'),libraryA:path.join(programDataPath,'root/default/Library A'),libraryB:path.join(programDataPath,'root/default/Library B'),collectionLibrary:path.join(programDataPath,'root/default/Collection Library')};
      for(const value of Object.values(paths))await mkdir(value,{recursive:true});
      const itemPath=item=>paths[item.pathKind]??(item.pathKind==='boxset'?path.join(paths.collections,item.key):item.pathKind==='child'
        ?path.join(itemPath(fixture.items.find(row=>row.id===item.parentId)),item.key+(item.type==='Movie'?'.mkv':'')):path.join(paths.physicalA,item.key));
      const pathMappings=new Map(fixture.items.filter(item=>item.type!=='AggregateFolder').map(item=>[native.seedBaseItems.find(row=>idKey(row.Id)===idKey(item.id))?.Path,itemPath(item)]));
      for(const item of fixture.items){
        if(item.type==='AggregateFolder')continue;
        const row=native.seedBaseItems.find(row=>idKey(row.Id)===idKey(item.id));assert.ok(row,item.key);
        const values=Object.fromEntries(columns.filter(column=>!['Id','ParentId','TopParentId','Path','Data'].includes(column.name))
          .map(column=>[column.name,column.clrType.replace('?','')==='long'&&row[column.name]!=null?BigInt(row[column.name]):row[column.name]]));
        await database.update('BaseItems',{Id:item.id},{...values,Path:itemPath(item),Data:projectItemDataIdentities(row.Data,row.Type,new Map(),{paths:pathMappings})});
      }
      for(const row of fixture.userData){const item=fixture.items.find(item=>item.key===row.itemKey);
        await database.insert('UserData',{ItemId:item.id,UserId:user.Id,CustomDataKey:item.id,AudioStreamIndex:null,SubtitleStreamIndex:null,IsFavorite:row.isFavorite,
          LastPlayedDate:row.lastPlayedDate,Likes:row.likes??null,PlayCount:row.playCount,PlaybackPositionTicks:BigInt(row.positionTicks),Played:row.played,Rating:null,RetentionDate:null});}
    }});
  const differences=[],check=(name,scope,fn)=>{try{fn();}catch(error){differences.push({name,scope,message:error.message});}};
  const endpoints=actual.cases.flatMap(item=>item.endpoints.map(endpoint=>({name:item.name,...endpoint})));
  check('matrix','all responses and endpoint stages',()=>{assert.equal(actual.httpCases,256);assert.equal(actual.caseStages.length,256);assert.equal(endpoints.length,256);});
  for(const [i,endpoint]of endpoints.entries())check(endpoint.name,'complete status/content type/body/diagnostics',()=>{
    const record=native.http.records[i],response=native.http.responses[record.responseIndex],input=fixture.cases[Math.floor(i/2)];
    assert.deepEqual([endpoint.name,endpoint.endpoint],[record.name,record.endpoint]);
    assert.equal(endpoint.response.status,response.status);assert.equal(endpoint.response.contentType,response.contentType);
    if(response.status===200){
      const expected=structuredClone(response.bodyJson),observed=projectItemBody(endpoint.response.body,{serverId:actual.serverId,serverToken:observedNativeServerId,date:value=>value});
      const repositoryRandom=input.mode==='repository'&&parseQuery(new URLSearchParams(input.query)).sortby?.includes('Random');
      if(repositoryRandom){expected.Items.sort((a,b)=>a.Id.localeCompare(b.Id));observed.Items.sort((a,b)=>a.Id.localeCompare(b.Id));}
      assert.deepEqual(observed,expected);
    }else assert.equal(endpoint.response.bodyText,response.bodyText);
    observeComparison(t,endpoint.name+' query error',endpoint.runtimeErrors,response.status===400?[native.converters.rows.find(row=>row.name===input.name).error]:[]);
    if(response.status===400){
      const failures=queryFailures.get(input.name)??[];
      assert.ok(failures.some(failure=>failure.status===response.status),'The actual item query must reject at the matching HTTP boundary.');
    }
  });
  for(const [i,stage]of actual.caseStages.entries())check(stage.name,'complete recorded state per endpoint',()=>{
    assert.deepEqual([stage.name,stage.endpoint],[native.http.records[i].name,native.http.records[i].endpoint]);
    for(const timing of ['before','after']){assert.deepEqual(stage[timing].database,actual.beforeReads);assert.deepEqual(stage[timing].userData,actual.userDataBeforeReads);assert.deepEqual(stage[timing].filesystemDomains,actual.filesystemDomainsBeforeReads);}
  });
  check('shutdown','complete recorded state after reads and shutdown',()=>{
    assert.deepEqual(actual.afterReads,actual.beforeReads);assert.deepEqual(actual.afterShutdown,actual.beforeReads);
    assert.deepEqual(actual.userDataAfterReads,actual.userDataBeforeReads);assert.deepEqual(actual.userDataAfterShutdown,actual.userDataBeforeReads);
    assert.deepEqual(actual.filesystemDomainsAfterReads,actual.filesystemDomainsBeforeReads);assert.deepEqual(actual.filesystemDomainsAfterShutdown,actual.filesystemDomainsBeforeReads);
  });
  check('cleanup','owned resources',()=>assert.deepEqual(actual.cleanup,{runtimeClosed:true,databaseClosed:true,portReleased:true,postgresSchemasRemoved:dialect==='postgres'?true:null,programDataDirectoryRemoved:true}));
  if(process.env.MEDIAMANAGER_SORT_BINDING_EVIDENCE){
    const out=path.resolve(process.env.MEDIAMANAGER_SORT_BINDING_EVIDENCE);await mkdir(out,{recursive:true});
    await writeFile(path.join(out,dialect+'.json'),json(actual),{flag:'wx'});
    await writeFile(path.join(out,dialect+'-comparison.json'),json({passed:!differences.length,phaseAcceptance:false,dialect,responses:256,endpointSnapshots:256,
      nativeSha256:sha(nativeBytes),inputSha256:sha(inputBytes),testSha256:sha(await readFile(new URL(import.meta.url))),harnessSha256:sha(await readFile(new URL('./item-filter-http-scenario.js',import.meta.url))),
      normalization:'Only isolated ServerId; repository bound Random compares full DTO member permutations while retaining raw order. Memory Random with distinct Name secondary remains exact. No business field or error response omitted.',differences,cleanup:actual.cleanup}),{flag:'wx'});
  }
  assert.equal(differences.length,0,JSON.stringify(differences.slice(0,2)));
});
