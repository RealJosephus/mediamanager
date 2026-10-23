import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/database/postgres.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import {newNativeItemEntity,cloneNativeItemEntity,releaseNativeItemLinks,publishNativeItemLinks,acquireNativeItemLinkOwner,acquireNativeItemLinkBranch,setNativeItemResource} from '../../src/library/native-item-entity.js';
import {createNativeItemCohort} from '../../src/library/native-item-cohort.js';
import {setFolderChildren,cachedFolderChildrenSnapshot} from '../../src/library/folder-cache.js';

test('postgres: cyclic raw branch borrowers release independent SQL resources and preserve live cohort revisions', {
 skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
 const schema='native_branch_cycle_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),items=[0,1].map(index=>{
  const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  item.Id='14600000-0000-0000-0000-'+String(index+10).padStart(12,'0');return item;
 });
 const owners=items.map(acquireNativeItemLinkOwner),cohorts=[],slots=[],borrowers=[];
 let closing,detached=0;
 try {
  await links.initialize();
  for(const item of items){
   publishNativeItemLinks(item,await links.withSession(async session=>{
    const writer=await links.createWriter({session,parentId:item.Id});
    await writer.append({ItemId:null,Type:0,Path:'/unresolved',LibraryItemId:null});
    return writer.finish();
   }));
  }
  for(let index=0;index<2;index++){
   const target=items[1-index],cohort=await createNativeItemCohort({linkedChildren:links});cohorts.push(cohort);
   slots.push(await cohort.capture(target,{ordinal:1n}));
   const branch=acquireNativeItemLinkBranch(target);borrowers.push(branch);
   setNativeItemResource(items[index],Symbol('cyclic cached-child branch'),{
    retain(){const held=cohort.retain();return{release(){links.queueOwnedRelease(async()=>{
     branch.release();await held.release();
    });}};},detached(){detached++;},
   });
  }
  await cohorts[0].release();
  owners[0].release();
  await links.resourceGraph.collect();
  assert.equal(detached,1);assert.equal(items[0].LinkedChildrenLoaded,true);
  await links.recordResolution(items[0].LinkedChildren,1n,'14600000-0000-0000-0000-000000000020');
  await cohorts[1].flush();
  await cohorts[1].withSlot(slots[1],async item=>{
   assert.equal((await links.page(item.LinkedChildren))[0].ItemId,'14600000-0000-0000-0000-000000000020');
  });
  await cohorts[1].release();
  owners[1].release();await links.resourceGraph.collect();assert.equal(detached,2);
  closing=links.close();await closing;
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 } finally {
  for(const item of items)releaseNativeItemLinks(item);
  for(const owner of owners)owner.release();for(const branch of borrowers)branch.release();
  for(const cohort of cohorts)await cohort.release();
  try{await(closing??links.close());}
  finally{await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();}
 }
});

test('postgres: delegated slots borrow each exact source cache branch without holding the relation connection', {
 skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
 const schema='native_source_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database});let source,selected,page;
 const first=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
 first.Id='14500000-0000-0000-0000-000000000002';first.Path='/first';
 const second=cloneNativeItemEntity(first);second.Path='/second';
 const unsaved=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');unsaved.Name='Unsaved child';
 setFolderChildren(first,[]);setFolderChildren(second,[unsaved]);
 const owners=[acquireNativeItemLinkOwner(first),acquireNativeItemLinkOwner(second)],sources=new Map(),mapping=new Map();
 try {
  await links.initialize();
  source=await createNativeItemCohort({linkedChildren:links,resolveLiveItem:(_id,slot)=>sources.get(slot)});
  const firstSource=await source.capture(first,{ordinal:1n}),secondSource=await source.capture(second,{ordinal:2n});
  sources.set(firstSource,first);sources.set(secondSource,second);
  selected=await createNativeItemCohort({linkedChildren:links,resolveSourceSlot:async slot=>
   callback=>source.withSlot(mapping.get(slot),callback)});
  const firstSlot=await selected.capture(first,{ordinal:1n}),secondSlot=await selected.capture(second,{ordinal:2n});
  await selected.appendSlot(firstSlot,{ordinal:3n});mapping.set(firstSlot,firstSource);mapping.set(secondSlot,secondSource);
  await selected.withSlot(secondSlot,item=>{
   assert.equal(item,second);assert.deepEqual(cachedFolderChildrenSnapshot(item),[unsaved]);item.Path='/unsaved';
  });
  page=await selected.page();
  assert.deepEqual(page.entries.map(entry=>entry.item),[first,second,first]);
  assert.deepEqual(cachedFolderChildrenSnapshot(page.entries[0].item),[]);
  assert.deepEqual(cachedFolderChildrenSnapshot(page.entries[1].item),[unsaved]);
  assert.equal(page.entries[1].item.Path,'/unsaved');
  await page.release();page=null;
  await selected.withSlot(secondSlot,item=>assert.equal(item,second));
 } finally {
  if(page)await page.release();if(selected)await selected.release();if(source)await source.release();
  for(const owner of owners)owner.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

for (const failCleanup of [false, true]) test(`postgres: exact Folder owners retain a typed SQL resource through shutdown${failCleanup ? ' and report its cleanup failure' : ''}`, {
 skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
 const schema='native_resource_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database});
 const releaseEntered=Promise.withResolvers(), allowRelease=Promise.withResolvers();
 let cohort, first, second, held, closing, detached=false, closed=false, released=0;
 try {
  await links.initialize();
  const child=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  child.Id='14500000-0000-0000-0000-000000000001';child.Name='Captured child';
  cohort=await createNativeItemCohort({linkedChildren:links,onRelease:async({session})=>{
   assert.equal(BigInt((await session.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".item_states`)).rows[0].count),1n);
   released++;
  }});
  const slot=await cohort.capture(child,{ordinal:1n});
  const parent=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  first=acquireNativeItemLinkOwner(parent);second=acquireNativeItemLinkOwner(parent);
  setNativeItemResource(parent,Symbol('cached children'),{
   retain(){held=cohort.retain();return{release(){links.queueOwnedRelease(async()=>{
    releaseEntered.resolve();await allowRelease.promise;await held.release();
    if(failCleanup)throw new Error('Injected cached-child cleanup failure');
   });}};},
   detached(){detached=true;},
  });
  await cohort.release();cohort=null;
  closing=links.close();closing.then(()=>{closed=true;},()=>{});
  assert.throws(()=>links.admitScope(),/not active/);
  second.release();second=null;
  assert.equal(detached,false);assert.equal(await held.count(),1n);
  first.release();first=null;
  await releaseEntered.promise;
  assert.equal(detached,true);assert.equal(closed,false);
  await held.withSlot(slot,item=>assert.equal(item.Name,'Captured child'));
  allowRelease.resolve();
  if(failCleanup)await assert.rejects(closing,error=>error instanceof AggregateError
   && error.errors.some(group=>group instanceof AggregateError&&group.errors.some(cause=>cause.message==='Injected cached-child cleanup failure')));
  else {await closing;assert.equal(closed,true);}
  assert.equal(released,1);
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 } finally {
  allowRelease.resolve();first?.release();second?.release();
  if(cohort)await cohort.release();
  try {await (closing??links.close());}catch(error){if(!failCleanup)throw error;}
  finally {await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();}
 }
});

test('postgres: typed pages update captured live fields without adopting an uncaptured same-ID cache value', {
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async()=>{
 const schema='native_live_page_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database});let cohort,page;
 try {
  await links.initialize();
  const first=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  first.Id='10000000000000000000000000000003';first.Name='first';first.Tags=['initial'];
  const second=cloneNativeItemEntity(first);second.Name='captured second';
  const unrelated=cloneNativeItemEntity(first);unrelated.Name='uncaptured cached value';
  const sources=new Map();let sourceReleases=0;
  cohort=await createNativeItemCohort({linkedChildren:links,resolveLiveItem:(_id,slot)=>sources.get(slot),
   onRelease:async({session})=>{
    assert.equal(BigInt((await session.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".item_states`)).rows[0].count),2n);
    sources.clear();sourceReleases++;
   }});
  const firstSlot=await cohort.capture(first,{ordinal:1n}),secondSlot=await cohort.capture(second,{ordinal:2n});
  sources.set(firstSlot,first);sources.set(secondSlot,unrelated);
  page=await cohort.page();
  page.entries[0].item.Name='live metadata update';page.entries[0].item.Tags.push('metadata');
  assert.equal(first.Name,'live metadata update');assert.deepEqual(first.Tags,['initial','metadata']);
  assert.equal(page.entries[1].item.Name,'captured second');page.entries[1].item.Name='owned page update';
  assert.equal(unrelated.Name,'uncaptured cached value');assert.equal(second.Name,'captured second');
  await page.release();page=null;
  await cohort.withSlot(secondSlot,item=>assert.equal(item.Name,'owned page update'));
  page=await cohort.page();
  await cohort.release();cohort=null;assert.equal(sourceReleases,0);
  page.entries[0].item.Tags.push('retained page');assert.deepEqual(first.Tags,['initial','metadata','retained page']);
  await page.release();page=null;assert.equal(sourceReleases,1);
  assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".item_states`)).rows[0].count),0n);
 } finally {
  if(page)await page.release();if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: typed slots preserve repeated captured values, observer mutations and event retention after TEMP disposal',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async()=>{
 const schema='native_cohort_'+randomUUID().replaceAll('-','').slice(0,20),database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1}),links=new PostgresLinkedChildrenStore({database});
 let cohort,event,retained,page;
 try{
  await links.initialize();const movie=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');movie.Id='10000000000000000000000000000001';movie.Name='captured';movie.OfficialRating='PG';movie.Tags=['one'];movie.ProviderIds={Tmdb:'old'};
  Object.defineProperty(movie.ProviderIds,'__proto__',{value:{nested:'original'},enumerable:true,writable:true,configurable:true});
  Object.defineProperty(movie,'__proto__',{value:{unknown:'preserved'},enumerable:true,writable:true,configurable:true});
  cohort=await createNativeItemCohort({linkedChildren:links});const slot=await cohort.captureSlot(movie);assert.equal(await cohort.count(),0n);await cohort.appendSlot(slot,{ordinal:1n});assert.equal(await cohort.count(),1n);
  const clone=cloneNativeItemEntity(movie);clone.Name='independent';movie.Name='live';movie.OfficialRating='R';movie.Tags.push('two');movie.ProviderIds.Tmdb='new';movie.ProviderIds.__proto__.nested='observed';movie.__proto__.unknown='observed';movie.Data.AddedFields={};movie.Data.AddedFields.__proto__={literal:'live addition'};await cohort.flush();
  await database.withConnection(async session=>{await session.client.query('CREATE TEMP TABLE cohort_input("Ordinal" bigint,"SlotKey" uuid)');await session.client.query('INSERT INTO cohort_input SELECT number,$1 FROM generate_series(1,257) number',[slot]);event=await cohort.view({session,plan:{text:'SELECT * FROM cohort_input ORDER BY "Ordinal"',values:[]}});await session.client.query('DROP TABLE cohort_input');});
  retained=event.retain();await event.release();event=null;await cohort.release();cohort=null;assert.equal(await retained.count(),257n);
  page=await retained.page();assert.equal(page.entries.length,128);assert.equal(page.entries[0].item.Name,'live');assert.equal(page.entries[0].item.OfficialRating,'R');assert.deepEqual(page.entries[0].item.Tags,['one','two']);assert.equal(page.entries[0].item.ProviderIds.Tmdb,'new');
  assert.equal(Object.getPrototypeOf(page.entries[0].item),Object.prototype);assert.equal(page.entries[0].item.__proto__.unknown,'observed');assert.equal(Object.hasOwn(page.entries[0].item.ProviderIds,'__proto__'),true);assert.equal(page.entries[0].item.ProviderIds.__proto__.nested,'observed');assert.equal(clone.ProviderIds.__proto__.nested,'original');
  assert.equal(Object.getPrototypeOf(page.entries[0].item.Data.AddedFields),Object.prototype);assert.equal(Object.hasOwn(page.entries[0].item.Data.AddedFields,'__proto__'),true);assert.deepEqual(page.entries[0].item.Data.AddedFields.__proto__,{literal:'live addition'});assert.equal(Object.hasOwn(clone.Data,'AddedFields'),false);
  page.entries[0].item.Name='changed during event';assert.equal(page.entries[1].item.Name,'changed during event');await page.release();page=null;
  page=await retained.page({after:128n});assert.equal(page.entries.length,128);assert.equal(page.entries[0].item.Name,'changed during event');await page.release();page=null;
  page=await retained.page({after:256n});assert.equal(page.entries.length,1);await page.release();page=null;releaseNativeItemLinks(clone);releaseNativeItemLinks(movie);
 }finally{
  if(page)await page.release();if(retained)await retained.release();if(event)await event.release();if(cohort)await cohort.release();await links.flushReleases();await links.close();await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: observed image aliases survive reassignment, typed slot serialization and later shared mutation', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async()=>{
 const schema='native_image_alias_'+randomUUID().replaceAll('-','').slice(0,16),database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1}),links=new PostgresLinkedChildrenStore({database});
 let cohort,page,clone;
 try{
  await links.initialize();
  const item=newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvProgram');item.Id='10000000000000000000000000000002';
  item.ImageInfos=[{Type:'Backdrop',Path:'http://example.invalid/first',Width:9},{Type:'Backdrop',Path:'http://example.invalid/second',Width:7}];
  cohort=await createNativeItemCohort({linkedChildren:links});const slot=await cohort.capture(item,{ordinal:1n});
  const first=item.ImageInfos[0];item.ImageInfos[1]=first;
  assert.equal(item.ImageInfos[0],item.ImageInfos[1],'Assigning an observed image must not wrap its existing reference again.');
  item.ImageInfos[1].Path='/converted-local';assert.equal(first.Path,'/converted-local');await cohort.flush();
  await cohort.withSlot(slot,restored=>{
   assert.equal(restored.ImageInfos[0],restored.ImageInfos[1]);assert.equal(restored.ImageInfos[0].Path,'/converted-local');
   restored.ImageInfos[0].Width=42;assert.equal(restored.ImageInfos[1].Width,42);
  });
  page=await cohort.page();const restored=page.entries[0].item;
  assert.equal(restored.ImageInfos[0],restored.ImageInfos[1]);assert.equal(restored.ImageInfos[1].Width,42);
  clone=cloneNativeItemEntity(restored);assert.equal(clone.ImageInfos[0],clone.ImageInfos[1]);assert.notEqual(clone.ImageInfos[0],restored.ImageInfos[0]);
  clone.ImageInfos[1].Path='/clone-only';assert.equal(clone.ImageInfos[0].Path,'/clone-only');assert.equal(restored.ImageInfos[0].Path,'/converted-local');
  await page.release();page=null;await cohort.release();cohort=null;
  const stateCount=await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".item_states`);assert.equal(BigInt(stateCount.rows[0].count),0n);
 }finally{
  if(clone)releaseNativeItemLinks(clone);if(page)await page.release();if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});
