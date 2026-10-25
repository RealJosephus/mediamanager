import test from 'node:test';
import assert from 'node:assert/strict';
import {setupChildrenFixture} from './children-fixture.js';
import {SeriesMetadataLifecycleHost} from '../../src/metadata/series-lifecycle-host.js';

test('postgres: a failed sequence close still releases every later TV sequence and authoritative context',
  {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const fixture=await setupChildrenFixture(t,'postgres');
  const seriesId='99540000000000000000000000000001';
  await fixture.seed({target:'series',items:[{key:'series',Id:seriesId,type:'Series',Name:'Series'},
    {key:'season',Id:'99540000000000000000000000000002',type:'Season',Name:'Season',parent:'series',IndexNumber:1}]});
  let disposed=false;
  const loadContext=Object.assign(async(...args)=>{const loaded=await fixture.loadContext(...args),dispose=loaded.dispose.bind(loaded);loaded.dispose=async()=>{await dispose();disposed=true;};return loaded;},fixture.loadContext);
  const host=new SeriesMetadataLifecycleHost({store:fixture.store,loadContext,updates:fixture.host.updates,itemCreation:fixture.library.itemCreation});
  const series=await fixture.library.itemCreation.getItemById(seriesId);
  const state=await host.load(series);
  try{
    const first=await state.children(),second=await state.recursive();let failed=false;
    const hook=fixture.database.queryHook;
    fixture.database.queryHook=async function(...args){const result=await this.query(...args),text=typeof args[0]==='string'?args[0]:args[0].text;
      if(!failed&&/DROP TABLE IF EXISTS.+mm_unpin_/iu.test(text)){failed=true;await this.query('SELECT 1/0');}return result;};
    const divisionFailure=error=>error.code==='22012'||error.errors?.some(divisionFailure);
    try{await assert.rejects(state.close(),error=>error instanceof AggregateError&&divisionFailure(error));}
    finally{fixture.database.queryHook=hook;}
    assert.equal(failed,true);assert.throws(()=>first.count(),/released/);assert.throws(()=>second.count(),/released/);assert.equal(disposed,true);await state.close();
  }finally{await state.close();}
});
