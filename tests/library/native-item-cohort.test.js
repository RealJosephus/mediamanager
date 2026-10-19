import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/database/postgres.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import {newNativeItemEntity,cloneNativeItemEntity,releaseNativeItemLinks} from '../../src/library/native-item-entity.js';
import {createNativeItemCohort} from '../../src/library/native-item-cohort.js';

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
