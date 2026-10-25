import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {parseQuery,sortItems} from '../../src/library/query.js';
import {idKey} from '../../src/library/records.js';
const bytes=await readFile(new URL('./fixtures/memory-sort-full/dispatch-native.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'da61634c62ecc5d8e44e4551a6ce626661cb2eec2cf56e8bfc6ba69eb765dacf');
const fixture=JSON.parse(bytes),native=fixture.native,controls=fixture.controlledSourceFacts;
const items=native.candidateItems.map(item=>({...item,...controls.byName[item.Name],PreferredMetadataCountryCode:controls.country,RunTimeTicks:item.RunTimeTicks==null?null:BigInt(item.RunTimeTicks)}));
const byId=new Map([...items,...controls.series].map(item=>[idKey(item.Id),item]));
const userData=new Map(native.candidateUserData.map(row=>[idKey(row.ItemId),row]));
const isPlayed=item=>userData.get(idKey(item.Id))?.Played??false;
const memoryContext={byId,defaultMetadataCountry:'US',preferredMetadataCountryFor:()=>controls.country};
const ordered=(input,query,context=memoryContext)=>sortItems(input,query,userData,isPlayed,{memory:true,memoryContext:context}).map(item=>item.Id);
const materialized=row=>row.inputOrder.map(id=>byId.get(idKey(id)));
test('30 enum keys match actual frozen comparer registry, 348 deterministic Sort sequences and 5684 pairwise comparisons',()=>{
 assert.equal(native.actualFrozenGetExportTypesInvoked,true);assert.equal(native.actualFrozenAddPartsInvoked,true);assert.equal(native.actualFrozenGetComparerAndSortInvoked,true);
 assert.equal(native.enums.length,30);assert.equal(native.registry.length,26);assert.equal(new Set(native.registry.map(row=>row.key)).size,25);
 assert.equal(native.dispatch.length,60);assert.equal(native.sorts.length,720);assert.equal(native.pairwise.length,5684);
 assert.deepEqual(native.dispatch.filter(row=>row.userProvided&&!row.comparerType&&!row.error).map(row=>row.key),['Default','IsPlayed','VideoBitRate','AirTime','SeriesDatePlayed']);
 const before=structuredClone(items),dataBefore=structuredClone([...userData]);
 let sequences=0;
 for(const row of native.sorts.filter(row=>row.userProvided&&!row.random)){
  const secondary=row.config.includes('name'),descending=row.config.startsWith('descending');
  const query=parseQuery({SortBy:secondary?[row.key,'Name']:[row.key],SortOrder:secondary?[descending?'Descending':'Ascending',descending?'Ascending':'Descending']:[descending?'Descending':'Ascending']});
  assert.equal(row.error,null);assert.deepEqual(ordered(materialized(row),query),row.ordered,row.key+' '+row.count+' '+row.config);sequences++;
 }
 assert.equal(sequences,348);
 for(const pair of native.pairwise)for(const direction of ['Ascending','Descending']){
  assert.equal(pair.error,null);const input=[byId.get(idKey(pair.left)),byId.get(idKey(pair.right))];
  const sign=direction==='Ascending'?pair.compare:-pair.compare;
  assert.deepEqual(ordered(input,parseQuery({SortBy:pair.key,SortOrder:direction})),sign>0?[pair.right,pair.left]:[pair.left,pair.right],`${pair.key}:${direction}:${pair.left}/${pair.right}`);
 }
 assert.deepEqual(items,before);assert.deepEqual([...userData],dataBefore);
});
test('Random Shuffle discards prior lazy keys and rebuilds subsequent ordering at 0/1/full input boundaries',()=>{
 assert.equal(fixture.randomChains.length,12);
 for(const row of fixture.randomChains){
  let calls=0;const context={...memoryContext,preferredMetadataCountryFor:()=>{calls++;return 'US';}};
  const input=materialized(row),before=structuredClone(input);
  const query=parseQuery({SortBy:row.orders.map(order=>order.key),SortOrder:row.orders.map(order=>order.direction)});
  const result=ordered(input,query,context);
  assert.deepEqual([...result].sort(),[...row.inputOrder].sort());assert.deepEqual(input,before);
  assert.deepEqual(row.inputAfter,row.inputOrder);
  if(['random-first','random-middle'].includes(row.name))assert.deepEqual(result,row.ordered);
  if(row.name!=='random-between-ratings'||row.count<2){assert.equal(calls,0);assert.equal(row.localizationCalls,0);}
  else{assert.ok(calls>0);assert.ok(row.localizationCalls>0);
   for(let index=1;index<result.length;index++){
    const a=byId.get(idKey(result[index-1])),b=byId.get(idKey(result[index]));const pair=native.pairwise.find(pair=>pair.key==='OfficialRating'&&pair.left===a.Id&&pair.right===b.Id);assert.ok(pair.compare>=0);
   }
  }
 }
 for(const row of native.sorts.filter(row=>row.userProvided&&row.random)){
  const secondary=row.config.includes('name'),desc=row.config.startsWith('descending');const query=parseQuery({SortBy:secondary?['Random','Name']:['Random'],SortOrder:secondary?[desc?'Descending':'Ascending',desc?'Ascending':'Descending']:[desc?'Descending':'Ascending']});
  const result=ordered(materialized(row),query);assert.deepEqual([...result].sort(),[...row.inputOrder].sort());if(secondary)assert.deepEqual(result,row.ordered);
 }
});
