import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deserialize} from 'node:v8';
import {PostgresDatabase} from '../../src/database/postgres.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import {newNativeItemEntity,cloneNativeItemEntity,releaseNativeItemLinks,publishNativeItemLinks,acquireNativeItemLinkOwner,acquireNativeItemLinkBranch,setNativeItemResource} from '../../src/library/native-item-entity.js';
import {createNativeItemCohort} from '../../src/library/native-item-cohort.js';
import {setFolderChildren,cachedFolderChildrenSnapshot} from '../../src/library/folder-cache.js';

async function observeStateRows(t, links, session, phase) {
 let observation;
 try { observation={phase,rows:String((await session.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".item_states`)).rows[0].count)}; }
 catch(reason){observation={phase,reasonType:typeof reason,message:reason?.message,code:reason?.code,stack:reason?.stack};}
 try {t.diagnostic(JSON.stringify({diagnosticOnly:true,typedStateRows:observation}));}catch{}
}

test('postgres: unpinned cohort release preserves retained links and drains a failed or held membership read', {
 skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
 const schema='native_empty_scope_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),query=database.client.query;
 const readEntered=Promise.withResolvers(),allowRead=Promise.withResolvers();
 let source,retained,empty,owner,closing,releasing,closed=false,holdRead=false,readHeld=false,faultPresent=false,fault;
 let releaseDelivered=false,releaseSettled=false,closeDelivered=false,primary,primaryFailed=false;
 try {
  await links.initialize();
  const folder=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  folder.Id='14600000-0000-0000-0000-000000000095';folder.Name='retained nonempty folder';folder.Path='/retained';
  owner=acquireNativeItemLinkOwner(folder);
  publishNativeItemLinks(folder,await links.withSession(async session=>{
   const writer=await links.createWriter({session,parentId:folder.Id});
   await writer.append({ItemId:null,Type:0,Path:'/retained/raw-child',LibraryItemId:null});return writer.finish();
  }));
  source=await createNativeItemCohort({linkedChildren:links});const slot=await source.capture(folder,{ordinal:1n});
  retained=source.retain();await source.release();source=null;owner.release();owner=null;await links.flushReleases();
  const readRetained=()=>retained.withSlot(slot,async item=>({name:item.Name,path:item.Path,
   links:(await links.page(item.LinkedChildren)).map(row=>({itemId:row.ItemId,path:row.Path,libraryItemId:row.LibraryItemId,type:row.Type}))}));
  const expected={name:'retained nonempty folder',path:'/retained',
   links:[{itemId:null,path:'/retained/raw-child',libraryItemId:null,type:0}]};
  assert.deepEqual(await readRetained(),expected);
  const membership=`SELECT EXISTS(SELECT 1 FROM "${links.schemaName}".pins WHERE scope_id=$1) AS present`;
  const controlledQuery=async(...args)=>{
   const result=await query(...args),text=typeof args[0]==='string'?args[0]:args[0]?.text??'';
   if(text===membership){
    assert.equal(result.rows[0].present,false);
    if(faultPresent){faultPresent=false;throw fault;}
    if(holdRead){holdRead=false;readHeld=true;readEntered.resolve();await allowRead.promise;}
   }
   return result;
  };
  database.client.query=controlledQuery;
  for(const reason of [new Error('Injected empty-scope membership failure'),false,0,'',null,undefined]){
   const scopeId=randomUUID();fault=reason;faultPresent=true;
   await assert.rejects(links.releaseStateScope(scopeId),actual=>{assert.equal(actual,reason);return true;});
   assert.equal(faultPresent,false);
   await links.releaseStateScope(scopeId);
   assert.deepEqual(await readRetained(),expected);
  }
  database.client.query=query;await retained.release();retained=null;
  // Keep the same physical query control after releasing the unrelated view.
  database.client.query=controlledQuery;
  empty=await createNativeItemCohort({linkedChildren:links});
  const movie=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  movie.Id='14600000-0000-0000-0000-000000000096';movie.Name='unpinned movie';
  const emptySlot=await empty.capture(movie,{ordinal:1n});
  assert.deepEqual(await empty.withSlot(emptySlot,item=>({id:item.Id,name:item.Name})),{id:movie.Id,name:'unpinned movie'});
  holdRead=true;releasing=empty.release();
  releasing.then(()=>{releaseSettled=true;},()=>{releaseSettled=true;});
  await Promise.race([readEntered.promise,releasing.then(()=>{
   throw new Error('The cohort release completed before the held membership read was observed.');
  },reason=>{if(!readHeld)releaseDelivered=true;throw reason;})]);
  closing=links.close();closing.then(()=>{closed=true;},()=>{});
  assert.throws(()=>links.admitScope(),/not active/);assert.equal(closed,false);assert.equal(releaseSettled,false);
  assert.notEqual((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
  assert.equal(releaseSettled,false);assert.equal(closed,false);
  allowRead.resolve();try{await releasing;}finally{releaseDelivered=true;}empty=null;
  database.client.query=query;
  try{await closing;}finally{closeDelivered=true;}
  assert.equal(closed,true);
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
  assert.equal((await database.client.query('SELECT 1 AS usable')).rows[0].usable,1);
 } catch(reason){primary=reason;primaryFailed=true;throw reason;}
 finally {
  allowRead.resolve();faultPresent=false;holdRead=false;
  const errors=[],attempt=async action=>{try{await action();}catch(reason){errors.push(reason);}};
  await attempt(()=>{database.client.query=query;});
  await attempt(()=>owner?.release());
  await attempt(async()=>{if(releasing&&!releaseDelivered){try{await releasing;}finally{releaseDelivered=true;}}});
  await attempt(()=>empty?.release());await attempt(()=>retained?.release());await attempt(()=>source?.release());
  await attempt(async()=>{if(!closeDelivered){try{await(closing??links.close());}finally{closeDelivered=true;}}});
  await attempt(()=>database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`));
  await attempt(()=>database.close());
  if(errors.length){
   if(primaryFailed)throw new AggregateError([primary,...errors],'Unpinned cohort operation and cleanup failed.',{cause:primary});
   if(errors.length===1)throw errors[0];
   throw new AggregateError(errors,'Unpinned cohort cleanup failed.',{cause:errors[0]});
  }
 }
});

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
  const value=item=>({id:item.Id,path:item.Path,children:cachedFolderChildrenSnapshot(item)?.map(child=>child.Name)});
  await selected.withSlot(secondSlot,item=>{
   assert.deepEqual(value(item),{id:first.Id,path:'/second',children:['Unsaved child']});item.Path='/unsaved';
  });
  assert.equal(second.Path,'/unsaved');assert.equal(first.Path,'/first');
  page=await selected.page();
  assert.deepEqual(page.entries.map(entry=>value(entry.item)),[
   {id:first.Id,path:'/first',children:[]},{id:first.Id,path:'/unsaved',children:['Unsaved child']},
   {id:first.Id,path:'/first',children:[]},
  ]);
  page.entries[0].item.Path='/first after page';
  assert.equal(page.entries[2].item.Path,'/first after page');assert.equal(first.Path,'/first after page');
  cachedFolderChildrenSnapshot(page.entries[1].item)[0].Name='Changed unsaved child';
  assert.equal(unsaved.Name,'Changed unsaved child');
  await page.release();page=null;
  await selected.withSlot(secondSlot,item=>assert.deepEqual(value(item),
   {id:first.Id,path:'/unsaved',children:['Changed unsaved child']}));
  await source.withSlot(firstSource,item=>assert.deepEqual(value(item),{id:first.Id,path:'/first after page',children:[]}));
 } finally {
  if(page)await page.release();if(selected)await selected.release();if(source)await source.release();
  for(const owner of owners)owner.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

for (const failCleanup of [false, true]) test(`postgres: exact Folder owners retain a typed SQL resource through shutdown${failCleanup ? ' and report its cleanup failure' : ''}`, {
 skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
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
   await observeStateRows(t,links,session,'last cached-child owner release');
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
  if(failCleanup)await assert.rejects(closing,error=>Array.isArray(error?.errors)
   && error.errors.some(group=>Array.isArray(group?.errors)&&group.errors.some(cause=>cause?.message==='Injected cached-child cleanup failure')));
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
}, async t=>{
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
    await observeStateRows(t,links,session,'last live-page owner release');
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
  await observeStateRows(t,links,database,'after last page release');
  await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
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
  assert.equal(Object.hasOwn(page.entries[0].item,'__proto__'),true);assert.equal(page.entries[0].item.__proto__.unknown,'observed');assert.equal(Object.hasOwn(page.entries[0].item.ProviderIds,'__proto__'),true);assert.equal(page.entries[0].item.ProviderIds.__proto__.nested,'observed');assert.equal(clone.ProviderIds.__proto__.nested,'original');
  assert.equal(Object.hasOwn(page.entries[0].item.Data.AddedFields,'__proto__'),true);assert.deepEqual(page.entries[0].item.Data.AddedFields.__proto__,{literal:'live addition'});assert.equal(Object.hasOwn(clone.Data,'AddedFields'),false);assert.equal(({}).unknown,undefined);assert.equal(({}).literal,undefined);
  page.entries[0].item.Name='changed during event';assert.equal(page.entries[1].item.Name,'changed during event');await page.release();page=null;
  page=await retained.page({after:128n});assert.equal(page.entries.length,128);assert.equal(page.entries[0].item.Name,'changed during event');await page.release();page=null;
  page=await retained.page({after:256n});assert.equal(page.entries.length,1);await page.release();page=null;releaseNativeItemLinks(clone);releaseNativeItemLinks(movie);
 }finally{
  if(page)await page.release();if(retained)await retained.release();if(event)await event.release();if(cohort)await cohort.release();await links.flushReleases();await links.close();await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: observed image aliases survive reassignment, typed slot serialization and later shared mutation', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async t=>{
 const schema='native_image_alias_'+randomUUID().replaceAll('-','').slice(0,16),database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1}),links=new PostgresLinkedChildrenStore({database});
 let cohort,page,clone;
 try{
  await links.initialize();
  const item=newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvProgram');item.Id='10000000000000000000000000000002';
  item.ImageInfos=[{Type:'Backdrop',Path:'http://example.invalid/first',Width:9},{Type:'Backdrop',Path:'http://example.invalid/second',Width:7}];
  cohort=await createNativeItemCohort({linkedChildren:links});const slot=await cohort.capture(item,{ordinal:1n});
  const first=item.ImageInfos[0];item.ImageInfos[1]=first;
  item.ImageInfos[1].Path='/converted-local';assert.equal(first.Path,'/converted-local');await cohort.flush();
  await cohort.withSlot(slot,restored=>{
   assert.equal(restored.ImageInfos[0].Path,'/converted-local');assert.equal(restored.ImageInfos[1].Path,'/converted-local');
   restored.ImageInfos[0].Width=42;assert.equal(restored.ImageInfos[1].Width,42);
  });
  page=await cohort.page();const restored=page.entries[0].item;
  assert.equal(restored.ImageInfos[0].Width,42);assert.equal(restored.ImageInfos[1].Width,42);
  clone=cloneNativeItemEntity(restored);
  clone.ImageInfos[1].Path='/clone-only';assert.equal(clone.ImageInfos[0].Path,'/clone-only');assert.equal(restored.ImageInfos[0].Path,'/converted-local');
  releaseNativeItemLinks(clone);clone=null;
  await page.release();page=null;await cohort.release();cohort=null;
  await observeStateRows(t,links,database,'after observed-image cohort release');
  await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 }finally{
  if(clone)releaseNativeItemLinks(clone);if(page)await page.release();if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: batched typed slots preserve same-ID values, links, mutations and clone isolation', {
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES, timeout:60000,
}, async()=>{
 const schema='native_batch_values_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),items=[],owners=[],clones=[],warm=new Map();let cohort;
 try{
  await links.initialize();
  for(const name of ['first','second']){
   const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
   item.Id='14600000-0000-0000-0000-000000000040';item.Name=name;item.Path='/'+name;item.Tags=[name];
   const image={Type:'Primary',Path:'/image-'+name,Width:12};item.ImageInfos=[image,image];
   owners.push(acquireNativeItemLinkOwner(item));items.push(item);
   publishNativeItemLinks(item,await links.withSession(async session=>{
    const writer=await links.createWriter({session,parentId:item.Id});
    await writer.append({ItemId:null,Type:0,Path:'/child-'+name,LibraryItemId:null});return writer.finish();
   }));
  }
  const unrelated=cloneNativeItemEntity(items[0]);clones.push(unrelated);unrelated.Name='uncaptured';unrelated.Path='/uncaptured';
  cohort=await createNativeItemCohort({linkedChildren:links,resolveLiveItem:(_id,slot)=>warm.get(slot)});
  const slots=await cohort.captureSlots([items[0],items[1],items[0]]);
  warm.set(slots[0],items[0]);warm.set(slots[1],unrelated);
  const seen=[];
  await cohort.withSlots(slots,async item=>{
   const position=seen.length;
   seen.push({name:item.Name,path:item.Path,links:(await links.page(item.LinkedChildren)).map(row=>row.Path)});
   if(position===0){
    item.Name='first live update';item.ImageInfos[1].Width=51;
    assert.equal(item.ImageInfos[0].Width,51);
    const clone=cloneNativeItemEntity(item);clones.push(clone);clone.ImageInfos[0].Width=77;
    assert.equal(clone.ImageInfos[1].Width,77);assert.equal(item.ImageInfos[0].Width,51);
    items[1].Name='second changed before consumption';items[1].Tags.push('observed');
   }else if(position===1){
    assert.deepEqual(item.Tags,['second','observed']);item.Name='second callback update';
   }else assert.equal(item.ImageInfos[0].Width,51);
  });
  assert.deepEqual(seen,[
   {name:'first',path:'/first',links:['/child-first']},
   {name:'second changed before consumption',path:'/second',links:['/child-second']},
   {name:'first live update',path:'/first',links:['/child-first']},
  ]);
  assert.equal(items[0].Name,'first live update');assert.equal(items[1].Name,'second changed before consumption');
  assert.equal(unrelated.Name,'uncaptured');assert.equal(unrelated.Path,'/uncaptured');
  assert.deepEqual(await cohort.withSlots([slots[1]],item=>({name:item.Name,path:item.Path,tags:[...item.Tags]})),[
   {name:'second callback update',path:'/second',tags:['second','observed']},
  ]);
 }finally{
  for(const clone of clones)releaseNativeItemLinks(clone);
  if(cohort)await cohort.release();for(const owner of owners)owner.release();
  for(const item of items)releaseNativeItemLinks(item);
  await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: batched slot errors retain earlier consumption and release page owners after cleanup failure', {
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES, timeout:60000,
}, async()=>{
 const schema='native_batch_errors_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),materializations=[];let cohort;
 const flushReleases=links.flushReleases.bind(links);
 try{
  await links.initialize();
  const first=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  first.Id='14600000-0000-0000-0000-000000000050';first.Name='first';first.Path='/first';
  const last=cloneNativeItemEntity(first);last.Name='last';last.Path='/last';
  cohort=await createNativeItemCohort({linkedChildren:links,onMaterialize:item=>materializations.push(item.Path)});
  await assert.rejects(cohort.captureSlots([first,null,last]),TypeError);
  assert.deepEqual(materializations,['/first']);
  const [slot]=await cohort.captureSlots([first]),consumed=[];
  await assert.rejects(cohort.withSlots([slot,42],item=>consumed.push(item.Name)),TypeError);
  assert.deepEqual(consumed,['first']);
  assert.deepEqual(await cohort.withSlots([slot],item=>item.Path),['/first']);
  let failCleanup=true;
  links.flushReleases=async()=>{await flushReleases();if(failCleanup){failCleanup=false;throw new Error('Injected batch release failure');}};
  await assert.rejects(cohort.withSlots([slot],()=>{throw new Error('Injected batch business failure');}),error=>{
   assert.equal(error.cause.message,'Injected batch business failure');
   assert.deepEqual(error.errors.map(cause=>cause.message),['Injected batch business failure','Injected batch release failure']);return true;
  });
  links.flushReleases=flushReleases;
  assert.deepEqual(await cohort.withSlots([slot],item=>item.Name),['first']);
  await cohort.release();cohort=null;await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 }finally{
  links.flushReleases=flushReleases;if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: typed capture and consumption preserve complete values within bounded SQL pages', {
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES, timeout:60000,
}, async t=>{
 const schema='native_batch_scale_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),query=database.client.query;let counting=false,roundTrips=0,maxRows=0;
 try{
  await links.initialize();
  database.client.query=async(...args)=>{
   const result=await query(...args);
   if(counting){roundTrips++;maxRows=Math.max(maxRows,result.rows?.length??0);}return result;
  };
  const measure=async count=>{
   const cohort=await createNativeItemCohort({linkedChildren:links});roundTrips=0;maxRows=0;counting=true;
   let consumed=0,first;
   try{
    for(let offset=0;offset<count;offset+=128){
     const items=Array.from({length:Math.min(128,count-offset)},(_value,index)=>{
      const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
      item.Id='14600000-0000-0000-0000-'+String(1000+offset+index).padStart(12,'0');
      item.Name='movie '+(offset+index);item.Path='/movie-'+(offset+index);return item;
     });
     const slots=await cohort.captureSlots(items);
     first??={item:items[0],slot:slots[0]};
     const values=await cohort.withSlots(slots,item=>({id:item.Id,name:item.Name,path:item.Path}));
     assert.deepEqual(values,items.map(item=>({id:item.Id,name:item.Name,path:item.Path})));consumed+=values.length;
    }
    // Later pages may have evicted the first slot's bounded read receipt.
    // Repeated assignments still preserve all current SQL-backed values.
    first.item.Name='updated after later pages';first.item.Name='updated after later pages';
    first.item.Tags=['retained','中文'];first.item.Tags=['retained','中文'];
    await cohort.flush();
    assert.deepEqual(await cohort.withSlots([first.slot],item=>({name:item.Name,tags:[...item.Tags],path:item.Path})),[
     {name:'updated after later pages',tags:['retained','中文'],path:'/movie-0'},
    ]);
    return{items:consumed,pages:Math.ceil(count/128),roundTrips,maxRows};
   }finally{counting=false;await cohort.release();}
  };
  const one=await measure(64),three=await measure(384);
  assert.equal(one.items,64);assert.equal(three.items,384);assert.ok(one.maxRows<=128&&three.maxRows<=128);
  t.diagnostic(JSON.stringify({boundedPageSqlGrowth:{one,three}}));
 }finally{
  database.client.query=query;await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: typed mutations retain actual committed state after a rejected write acknowledgement', {
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,timeout:60000,
},async()=>{
 const schema='native_state_ack_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database});let cohort;
 const query=database.client.query;let rejectAcknowledgement=false;
 try{
  await links.initialize();
  const movie=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  movie.Id='14600000-0000-0000-0000-000000000094';movie.Name='original';movie.OfficialRating='PG';
  cohort=await createNativeItemCohort({linkedChildren:links});const slot=await cohort.captureSlot(movie);
  database.client.query=async(...args)=>{
   const result=await query(...args),text=typeof args[0]==='string'?args[0]:args[0]?.text??'';
   if(rejectAcknowledgement&&text.startsWith(`INSERT INTO "${links.schemaName}".item_states`)){
    rejectAcknowledgement=false;throw false;
   }
   return result;
  };
  rejectAcknowledgement=true;movie.Name='committed before rejected acknowledgement';
  await assert.rejects(cohort.flush(),reason=>{assert.equal(reason,false);return true;});
  movie.OfficialRating='R';
  await assert.rejects(cohort.flush(),reason=>{assert.equal(reason,false);return true;});
  const rows=await links.withSession(async session=>(await session.client.query(
   `SELECT state,"Name","OfficialRating" FROM "${links.schemaName}".item_states WHERE slot_id=$1`,[slot])).rows);
  assert.equal(rows.length,1);const state=deserialize(rows[0].state);
  assert.equal(state.sorting.name,'committed before rejected acknowledgement');assert.equal(state.values.OfficialRating,'R');
  assert.equal(rows[0].Name.toString('utf8'),'committed before rejected acknowledgement');
  assert.equal(rows[0].OfficialRating.toString('utf8'),'R');
 }finally{
  database.client.query=query;
  if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

for(const mode of ['withSlot','withSlots','page']) test(`postgres: ${mode} releases restored nonempty links when materialization fails`,{
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,timeout:60000,
},async()=>{
 const schema='native_hook_links_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),failedItems=[];let cohort,owner,page,armed=false;
 try{
  await links.initialize();
  const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  item.Id='14600000-0000-0000-0000-000000000060';item.Name='retained folder';item.Path='/retained-folder';
  owner=acquireNativeItemLinkOwner(item);
  publishNativeItemLinks(item,await links.withSession(async session=>{
   const writer=await links.createWriter({session,parentId:item.Id});
   await writer.append({ItemId:null,Type:0,Path:'/retained-child',LibraryItemId:null});return writer.finish();
  }));
  cohort=await createNativeItemCohort({linkedChildren:links,onMaterialize:value=>{
   if(armed){failedItems.push(value);throw new Error('Injected materialization failure');}
  }});
  const slot=await cohort.capture(item,{ordinal:1n});owner.release();owner=null;await links.flushReleases();
  armed=true;let consumed=false;
  const consume=()=>{consumed=true;};
  await assert.rejects(mode==='page'?cohort.page():cohort[mode](mode==='withSlots'?[slot]:slot,consume),
   {message:'Injected materialization failure'});
  assert.equal(consumed,false);armed=false;
  const read=async value=>({name:value.Name,path:value.Path,loaded:value.LinkedChildrenLoaded,
   links:(await links.page(value.LinkedChildren)).map(row=>row.Path)});
  let actual;
  if(mode==='page'){
   page=await cohort.page();actual=await read(page.entries[0].item);await page.release();page=null;
  }else{
   actual=await cohort[mode](mode==='withSlots'?[slot]:slot,read);if(mode==='withSlots')actual=actual[0];
  }
  assert.deepEqual(actual,{name:'retained folder',path:'/retained-folder',loaded:true,links:['/retained-child']});
  await cohort.release();cohort=null;await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 }finally{
  armed=false;if(page)await page.release();owner?.release();
  for(const value of failedItems)releaseNativeItemLinks(value);
  if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

for(const failHook of [true,false]) test(`postgres: typed page ${failHook?'materialization':'release'} preserves ordered errors and releases later nonempty owners`,{
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,timeout:60000,
},async()=>{
 const schema='native_page_errors_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),owners=[],restored=[],released=[];let cohort,page,armed=false;
 try{
  await links.initialize();
  cohort=await createNativeItemCohort({linkedChildren:links,onMaterialize:item=>{
   if(!armed)return;
   restored.push(item);
   setNativeItemResource(item,Symbol('controlled retained folder resource'),{
    retain(){return{release(){released.push(item.Name);if(item.Name==='first')throw new Error('Injected first owner cleanup failure');}};},
   });
   if(failHook&&item.Name==='second')throw new Error('Injected later materialization failure');
  }});
  for(const [index,name] of ['first','second'].entries()){
   const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
   item.Id='14600000-0000-0000-0000-'+String(70+index).padStart(12,'0');item.Name=name;item.Path='/'+name;
   owners.push(acquireNativeItemLinkOwner(item));
   publishNativeItemLinks(item,await links.withSession(async session=>{
    const writer=await links.createWriter({session,parentId:item.Id});
    await writer.append({ItemId:null,Type:0,Path:'/child-'+name,LibraryItemId:null});return writer.finish();
   }));
   await cohort.capture(item,{ordinal:BigInt(index+1)});
  }
  for(const owner of owners)owner.release();await links.flushReleases();armed=true;
  const check=error=>{
   const messages=error.errors.map(value=>value.message);
   assert.deepEqual(messages,failHook?['Injected later materialization failure','Injected first owner cleanup failure']
    :['Injected first owner cleanup failure']);
   if(failHook)assert.equal(error.cause.message,'Injected later materialization failure');return true;
  };
  if(failHook)await assert.rejects(cohort.page(),check);
  else{page=await cohort.page();await assert.rejects(page.release(),check);page=null;}
  assert.deepEqual(released,['first','second']);armed=false;
  page=await cohort.page();
  assert.deepEqual(await Promise.all(page.entries.map(async entry=>({name:entry.item.Name,
   links:(await links.page(entry.item.LinkedChildren)).map(row=>row.Path)}))),[
   {name:'first',links:['/child-first']},{name:'second',links:['/child-second']},
  ]);
  await page.release();page=null;await cohort.release();cohort=null;await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 }finally{
  armed=false;if(page)await page.release();for(const owner of owners)owner.release();
  for(const item of restored)releaseNativeItemLinks(item);
  if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: typed capture and borrowing preserve a false primary reason before nonempty-link cleanup failure',{
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,timeout:60000,
},async()=>{
 const schema='native_false_reason_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database}),flushReleases=links.flushReleases.bind(links);
 let cohort,owner,armed=false,failFlush=false;
 try{
  await links.initialize();
  const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  item.Id='14600000-0000-0000-0000-000000000080';item.Name='false reason folder';
  owner=acquireNativeItemLinkOwner(item);
  publishNativeItemLinks(item,await links.withSession(async session=>{
   const writer=await links.createWriter({session,parentId:item.Id});
   await writer.append({ItemId:null,Type:0,Path:'/false-reason-child',LibraryItemId:null});return writer.finish();
  }));
  cohort=await createNativeItemCohort({linkedChildren:links,onMaterialize:()=>{if(armed)throw false;}});
  const slot=await cohort.capture(item,{ordinal:1n});
  links.flushReleases=async(...args)=>{
   await flushReleases(...args);
   if(failFlush){failFlush=false;throw new Error('Injected cleanup failure after actual link release');}
  };
  for(const mode of ['captureSlot','captureSlots','withSlot','withSlots','page']){
   armed=true;failFlush=true;let consumed=false;
   const pending=mode==='page'?cohort.page():mode==='captureSlot'?cohort.captureSlot(item)
    :mode==='captureSlots'?cohort.captureSlots([item]):cohort[mode](mode==='withSlots'?[slot]:slot,()=>{consumed=true;});
   await assert.rejects(pending,error=>{
    assert.equal(Object.hasOwn(error,'cause'),true);assert.equal(error.cause,false);
    assert.deepEqual(error.errors.map(value=>value instanceof Error?value.message:value),
     [false,'Injected cleanup failure after actual link release']);return true;
   });
   assert.equal(consumed,false);armed=false;
   assert.deepEqual(await cohort.withSlot(slot,async value=>(await links.page(value.LinkedChildren)).map(row=>row.Path)),['/false-reason-child']);
  }
  links.flushReleases=flushReleases;owner.release();owner=null;await flushReleases();
  await cohort.release();cohort=null;await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
 }finally{
  armed=false;failFlush=false;links.flushReleases=flushReleases;owner?.release();
  if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

for(const reason of [false,0,undefined]) test(`postgres: failed typed capture preserves ${String(reason)} through later reads and real shutdown`,{
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,timeout:60000,
},async()=>{
 const schema='native_capture_reason_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database});let cohort,owner;
 try{
  await links.initialize();
  const first=newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  first.Id='14600000-0000-0000-0000-000000000090';first.Name='captured before producer failure';
  owner=acquireNativeItemLinkOwner(first);
  publishNativeItemLinks(first,await links.withSession(async session=>{
   const writer=await links.createWriter({session,parentId:first.Id});
   await writer.append({ItemId:null,Type:0,Path:'/captured-child',LibraryItemId:null});return writer.finish();
  }));
  const broken=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  broken.Id='14600000-0000-0000-0000-000000000091';
  Object.defineProperty(broken,'ControlledMetadata',{enumerable:true,get(){throw reason;}});
  cohort=await createNativeItemCohort({linkedChildren:links});
  const rejected=actual=>{assert.equal(actual,reason);return true;};
  await assert.rejects(cohort.captureSlots([first,broken]),rejected);
  await assert.rejects(cohort.flush(),rejected);
  let consumed=false;
  await assert.rejects(cohort.page(),rejected);
  await assert.rejects(cohort.withSlots([],()=>{consumed=true;}),rejected);
  assert.equal(consumed,false);
  owner.release();owner=null;await cohort.release();cohort=null;await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
  assert.equal((await database.client.query('SELECT 1 AS usable')).rows[0].usable,1);
 }finally{
  owner?.release();if(cohort)await cohort.release();await links.flushReleases();await links.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});

test('postgres: typed SQL definitions retain fresh values across row arities, cohorts and runtime tables on one connection', {
 skip:!process.env.MEDIAMANAGER_TEST_POSTGRES,timeout:60000,
},async()=>{
 const schema='native_cohort_sql_'+randomUUID().replaceAll('-','').slice(0,16);
 const database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1});
 const links=new PostgresLinkedChildrenStore({database,relationDatabase:database});
 const otherLinks=new PostgresLinkedChildrenStore({database,relationDatabase:database});
 let first,sibling,other;
 const movie=(number,name)=>{
  const item=newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  item.Id='14600000-0000-0000-0000-'+String(number).padStart(12,'0');
  item.Name=name;item.OfficialRating='PG';return item;
 };
 const values=(cohort,slot)=>cohort.withSlot(slot,item=>({id:item.Id,name:item.Name,rating:item.OfficialRating}));
 try{
  await links.initialize();await otherLinks.initialize();
  first=await createNativeItemCohort({linkedChildren:links});
  sibling=await createNativeItemCohort({linkedChildren:links});
  other=await createNativeItemCohort({linkedChildren:otherLinks});
  const alpha=movie(101,'alpha'),beta=movie(102,'beta'),gamma=movie(103,'gamma');
  const [alphaSlot,betaSlot]=await first.captureSlots([alpha,beta]);
  await first.appendSlot(alphaSlot,{ordinal:1n});await first.appendSlot(betaSlot,{ordinal:2n});
  const gammaSlot=await first.capture(gamma,{ordinal:3n});
  const siblingSlot=await sibling.capture(alpha,{ordinal:9n});
  const delta=movie(104,'other runtime'),epsilon=movie(105,'other second');
  const [deltaSlot,epsilonSlot]=await other.captureSlots([delta,epsilon]);
  await other.appendSlot(deltaSlot,{ordinal:1n});await other.appendSlot(epsilonSlot,{ordinal:2n});
  alpha.Name='alpha updated';beta.OfficialRating='R';
  await Promise.all([first.flush(),sibling.flush()]);
  assert.deepEqual(await values(first,alphaSlot),{id:alpha.Id,name:'alpha updated',rating:'PG'});
  assert.deepEqual(await values(sibling,siblingSlot),{id:alpha.Id,name:'alpha updated',rating:'PG'});
  assert.deepEqual(await values(first,betaSlot),{id:beta.Id,name:'beta',rating:'R'});
  assert.deepEqual(await values(first,gammaSlot),{id:gamma.Id,name:'gamma',rating:'PG'});
  await first.appendSlot(betaSlot,{ordinal:1n});
  const plan=first.orderedPlan();
  const rows=await database.withConnection(async session=>(await session.client.query(plan.text+' ORDER BY "Ordinal"',plan.values)).rows);
  assert.deepEqual(rows.map(row=>[String(row.Ordinal),row.SlotKey]),[['1',betaSlot],['2',betaSlot],['3',gammaSlot]]);
  await first.release();first=null;await sibling.release();sibling=null;await links.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[links.schemaName])).rows[0].namespace,null);
  assert.deepEqual(await values(other,deltaSlot),{id:delta.Id,name:'other runtime',rating:'PG'});
  delta.Name='other updated after independent runtime close';await other.flush();
  assert.deepEqual(await values(other,deltaSlot),{id:delta.Id,name:delta.Name,rating:'PG'});
  assert.deepEqual(await values(other,epsilonSlot),{id:epsilon.Id,name:'other second',rating:'PG'});
  await other.release();other=null;await otherLinks.close();
  assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',[otherLinks.schemaName])).rows[0].namespace,null);
  assert.equal((await database.client.query('SELECT 1 AS usable')).rows[0].usable,1);
 }finally{
  if(first)await first.release();if(sibling)await sibling.release();if(other)await other.release();
  await links.flushReleases();await links.close();await otherLinks.flushReleases();await otherLinks.close();
  await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();
 }
});
