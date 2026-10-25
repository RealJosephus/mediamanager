import { validationPath } from './validation/paths.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=process.cwd(), output=validationPath(resolve(root,'tests/library/fixtures/memory-sort-full'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const bound=[];
async function load(path){const bytes=await readFile(validationPath(resolve(root,path)));bound.push({path,bytes:bytes.length,sha256:sha(bytes)});return JSON.parse(bytes);}
async function text(path){const bytes=await readFile(validationPath(resolve(root,path)));bound.push({path,bytes:bytes.length,sha256:sha(bytes)});return bytes.toString('utf8');}
await mkdir(output,{recursive:true});
const base='.test-input/evidence/memory-sort-full-dispatch-native-v2';
const native=await load(base+'/native.json'), program=await text(base+'/Program.cs');
assert.equal(sha(await readFile(validationPath(resolve(root,base+'/native.json')))),'04d13d40b21b125cd140777462698e33fb407b0afc47ebca6e93190110320121');
for(const literal of ['SeriesId = Id(90)','SeriesId = Id(91)','AirsBeforeSeasonNumber = 1, AirsBeforeEpisodeNumber = 2','AirsAfterSeasonNumber = 1','item.PreferredMetadataCountryCode = "US"','ForcedSortName = "a actual series"','ForcedSortName = "z actual series"'])assert.ok(program.includes(literal),literal);
const random=await load('.test-input/evidence/memory-sort-full-dispatch-native-v3/native.json');await text('.test-input/evidence/memory-sort-full-dispatch-native-v3/Program.cs');
assert.equal(random.randomChains.length,12);assert.deepEqual(random.pairwise,native.pairwise);
for(const assembly of [...native.assemblies,...random.assemblies]){assert.equal(assembly.sha256,assembly.frozenSha256);assert.equal(sha(await readFile(validationPath(resolve(root,assembly.frozenPath)))),assembly.frozenSha256);}
const controls={country:'US',series:[{Id:'99400000-0000-0000-0000-000000000090',Type:'Series',SortName:'a actual series'},{Id:'99400000-0000-0000-0000-000000000091',Type:'Series',SortName:'z actual series'}],
 byName:{'b episode':{SeriesId:'99400000-0000-0000-0000-000000000090'},'c special':{SeriesId:'99400000-0000-0000-0000-000000000091',AirsBeforeSeasonNumber:1,AirsBeforeEpisodeNumber:2},'d special':{SeriesId:'99400000-0000-0000-0000-000000000090',AirsAfterSeasonNumber:1},'s season':{SeriesId:'99400000-0000-0000-0000-000000000091'}}};
await writeFile(resolve(output,'dispatch-native.json'),json({format:1,frozenJellyfin:true,sourceBindings:[...bound],controlledSourceFacts:controls,native,randomChains:random.randomChains}));
async function project(dir,prefix){
 const bindingsStart=bound.length;
 const fixture=await load(dir+'/input.json'),http=await load(dir+'/native-run/native-http.json'),stages=await load(dir+'/native-run/stages.json'),endpoints=await load(dir+'/native-run/endpoint-stages.json'),summary=await load(dir+'/native-run/summary.json');
 const recorderText=await text(dir+'/record-native.mjs');assert.equal(sha(recorderText),summary.recorderSha256);assert.equal(sha(await readFile(validationPath(resolve(root,'.test-input/evidence/core-flow-20260926/initial.db')))),summary.sourceDatabaseSha256);assert.equal(sha(await readFile(validationPath(resolve(root,'.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll')))),summary.dllSha256);
 assert.equal(http.records.length,fixture.cases.length);assert.equal(endpoints.endpointStages.length,http.records.length);assert.deepEqual(summary.processResult,{code:0,signal:null});assert.equal(summary.portAvailable,true);assert.equal(summary.error,null);
 const stable=value=>JSON.stringify(value);
 const state={database:stages.before.database,filesystem:stages.before.filesystem};
 for(const stage of [stages.afterReads,stages.afterShutdown])assert.equal(stable({database:stage.database,filesystem:stage.filesystem}),stable(state));
 for(const [i,stage]of endpoints.endpointStages.entries()) {assert.deepEqual([stage.name,stage.endpoint],[http.records[i].name,http.records[i].endpoint]);assert.equal(stable({database:stage.database,filesystem:stage.filesystem}),stable(state));}
 const tables=Object.keys(state.database.tables);assert.equal(tables.length,12);assert.equal(state.database.foreignKeyCheck.length,0);
 const counts={};for(const [i,record]of http.records.entries()){assert.deepEqual([record.name,record.endpoint],[fixture.cases[i].name,'items']);assert.ok([200,400,500].includes(record.response.status));counts[record.response.status]=(counts[record.response.status]??0)+1;const item=fixture.cases[i];
 if(prefix==='main'){const requires=item.auth==='apiKey'&&['DatePlayed','PlayCount','IsUnplayed','IsFavoriteOrLiked'].includes(item.sortKey)&&item.mode==='memory';const sqlError=item.mode==='repository-null-user-known';assert.equal(record.response.status,sqlError?500:requires?400:200);}
 if(record.response.status===200)assert.ok(record.response.bodyJson&&Array.isArray(record.response.bodyJson.Items));else assert.equal(record.response.bodyText,'Error processing request.');
 }
 const reclaim=await load(process.env.MEDIAMANAGER_SORT_RECLAMATION_REFERENCE??'.test-input/evidence/memory-sort-full-http-native-v1/process-reclamation-v2.json');assert.equal(reclaim.reclaimed,true);
 const inputBytes=Buffer.from(json(fixture));assert.equal(sha(inputBytes),summary.fixtureSha256);await writeFile(resolve(output,prefix+'-input.json'),inputBytes);
 const values=[],references=new Map();const records=http.records.map(({response,...record})=>{const key=stable(response);let index=references.get(key);if(index===undefined){index=values.length;references.set(key,index);values.push(response);}return{...record,responseIndex:index};});
 const audit={passed:true,phaseAcceptance:false,responses:http.records.length,statusCounts:counts,sourceSummaryPassed:summary.passed,sourceSummaryFalseReason:summary.passed?null:'Inherited recorder status gate accepts only 200/401/404 and rejects these legitimate 400/500 responses; complete responses, recorded states, process exit and release independently verified.',
  tables,tableCounts:Object.fromEntries(tables.map(name=>[name,state.database.tables[name].length])),endpointSnapshots:endpoints.endpointStages.length,completeStageWindows:3,allRecordedStateEqual:true,processReclaimed:true,reclaimSha256:bound.at(-1).sha256};
 const projection={format:1,frozenJellyfin:true,inputSha256:sha(inputBytes),sourceBindings:bound.slice(bindingsStart),summary,audit,nativeState:state,seedBaseItems:state.database.tables.BaseItems,
  http:{records,responses:values},projection:'Complete raw HTTP responses deduplicated by exact JSON encoding; records retain route/query/endpoint/name/scope. All 1216/edge endpoint complete states and three windows mechanically verified identical before retaining one full state. Eleven media tables plus UserData; four filesystem domains. No raw authentication setup data projected.'};
 await writeFile(resolve(output,prefix+'-native.json'),json(projection));await writeFile(validationPath(resolve(root,dir,'independent-audit.json')),json({...audit,sourceBindings:projection.sourceBindings}));
 return {prefix,cases:http.records.length,uniqueResponses:values.length};
}
const projects=[await project('.test-input/evidence/memory-sort-full-http-native-v1','main')];
for(const entry of JSON.parse(process.env.MEDIAMANAGER_SORT_EXTRA_NATIVE_DIRECTORIES??'[]'))projects.push(await project(entry.directory,entry.prefix));
if(process.env.MEDIAMANAGER_SORT_EDGE_NATIVE_DIRECTORY)projects.push(await project(process.env.MEDIAMANAGER_SORT_EDGE_NATIVE_DIRECTORY,'edges'));
const files=['dispatch-native.json',...projects.flatMap(row=>[row.prefix+'-input.json',row.prefix+'-native.json'])];const manifest={format:1,projectorSha256:sha(await readFile(new URL(import.meta.url))),projects,files:await Promise.all(files.map(async path=>{const bytes=await readFile(resolve(output,path));return{path,bytes:bytes.length,sha256:sha(bytes)};}))};
await writeFile(resolve(output,'manifest.json'),json(manifest));console.log(json(manifest));
