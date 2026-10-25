import { validationPath } from './validation/paths.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),leaf='.test-input/evidence/sort-asp-binding-native-v2',out=validationPath(path.resolve(root,'tests/library/fixtures/sort-binding')),bindings=[];
const sha=b=>createHash('sha256').update(b).digest('hex'),json=v=>JSON.stringify(v,null,2)+'\n';
async function load(relative,expected){const b=await readFile(validationPath(path.resolve(root,relative)));if(expected)assert.equal(sha(b),expected);bindings.push({path:relative,bytes:b.length,sha256:sha(b)});return{bytes:b,value:JSON.parse(b)};}
const input=await load(leaf+'/input.json','a4e77c6dd0328e33c60319124000a27f889093d9bddc0d6bfa380f796d3686c9');
const http=await load(leaf+'/native-run/native-http.json','e8fa3214786d87988b100fc4583219e81ad162fbfa308a58c4bca8ee2bcc7e46');
const stages=await load(leaf+'/native-run/stages.json','b2701c72ed88ee157dea364f524e39c6fbab01353afccbf2368fb67d1e735664');
const endpoints=await load(leaf+'/native-run/endpoint-stages.json'),summary=await load(leaf+'/native-run/summary.json'),audit=await load(leaf+'/independent-audit.json');
const oracle=await load('.test-input/evidence/sort-asp-binding-converter-native-v1/native.json'),partial=await load('.test-input/evidence/sort-asp-binding-converter-native-v2/native.json');
assert.equal(audit.value.passed,true);assert.equal(summary.value.passed,false);assert.deepEqual(audit.value.statusCounts,{200:252,400:4});
assert.equal(http.value.records.length,256);assert.equal(oracle.value.rows.length,128);assert.equal(partial.value.rows.length,2);
const stable=v=>JSON.stringify(v),state={database:stages.value.before.database,filesystem:stages.value.before.filesystem};
for(const s of [stages.value.afterReads,stages.value.afterShutdown])assert.equal(stable({database:s.database,filesystem:s.filesystem}),stable(state));
for(const [i,s]of endpoints.value.endpointStages.entries()){assert.deepEqual([s.name,s.endpoint],[http.value.records[i].name,http.value.records[i].endpoint]);assert.equal(stable({database:s.database,filesystem:s.filesystem}),stable(state));}
for(const r of audit.value.sourceBindings){const b=await readFile(validationPath(path.resolve(root,r.path)));assert.equal(sha(b),r.sha256,r.path);}
for(const [dir,o]of [['sort-asp-binding-converter-native-v1',oracle.value],['sort-asp-binding-converter-native-v2',partial.value]]){
 assert.equal(o.actualBinder,true);assert.equal(o.actualGetOrderBy,true);for(const a of o.assemblies)assert.equal(sha(await readFile(a.path)),a.sha256);
 for(const file of ['Program.cs','Oracle.csproj']){const relative='.test-input/evidence/'+dir+'/'+file,b=await readFile(validationPath(path.resolve(root,relative)));bindings.push({path:relative,bytes:b.length,sha256:sha(b)});}
}
const responses=[],indices=new Map(),records=http.value.records.map(({response,...r})=>{const key=stable(response);let index=indices.get(key);if(index===undefined){index=responses.length;indices.set(key,index);responses.push(response);}return{...r,responseIndex:index};});
await mkdir(out,{recursive:true});
const projected={format:1,frozenJellyfin:true,inputSha256:sha(input.bytes),sourceBindings:bindings,summary:summary.value,audit:audit.value,nativeState:state,seedBaseItems:state.database.tables.BaseItems,http:{records,responses},
 converters:{rows:oracle.value.rows,partialDirections:partial.value.rows,assemblies:oracle.value.assemblies,runtime:oracle.value.runtime},
 projection:'Mechanical exact JSON deduplication of all 256 complete original responses. All 256 endpoint states and three windows independently verified equal before retaining one complete recorded state. Eleven media tables plus UserData and four filesystem domains. No authentication setup, token or password data. Numeric Random with Name is deterministic only in memory: SQL Random remains primary, so repository Random compares all complete DTO members and preserves the raw permutation.'};
const files=[['input.json',input.bytes],['native.json',Buffer.from(json(projected))]];
for(const [name,bytes]of files)await writeFile(path.join(out,name),bytes,{flag:'wx'});
const manifest={format:1,projectorSha256:sha(await readFile(new URL(import.meta.url))),files:files.map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:sha(bytes)}))};
await writeFile(path.join(out,'manifest.json'),json(manifest),{flag:'wx'});console.log(json(manifest));
