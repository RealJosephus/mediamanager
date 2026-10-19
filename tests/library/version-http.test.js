import { createPlaybackState } from '../playback/runtime-state.js';
import path from 'node:path';
import { expandStatePath } from './fixture-state-path.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dependencyOrder } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordVersionHttp } from './version-http-scenario.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const fixture=JSON.parse(await readFile(new URL('./fixtures/media-versions/http-seed.json',import.meta.url),'utf8'),(_,v)=>v&&typeof v==='object'&&'$integer' in v?BigInt(v.$integer):v);
const native=parseLosslessJson(await readFile(new URL('./fixtures/media-versions/http-native.json',import.meta.url),'utf8'));
const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value)
  .filter(([key])=>!['PlaySessionId','traceId'].includes(key)).map(([key,v])=>[key,normalize(v)])):value;
const idKey = value => value == null ? null : String(value).replaceAll('-', '').toLowerCase();
function parentFirstBaseItems(rows) {
  const pending = [...rows], ordered = [], inserted = new Set();
  while (pending.length) {
    const index = pending.findIndex(row => [row.ParentId, row.OwnerId]
      .every(reference => reference == null || inserted.has(idKey(reference))));
    if (index < 0) throw new Error('BaseItems seed contains an unresolved parent or owner cycle.');
    const [row] = pending.splice(index, 1);
    ordered.push(row); inserted.add(idKey(row.Id));
  }
  return ordered;
}
test('16 actual native HTTP version/detail/permissions cases match on PostgreSQL',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'version_http');
  const state = await createPlaybackState();
  let runtime;
  try{
    for (const table of dependencyOrder()) {
      const rows = table.name === 'BaseItems'
        ? parentFirstBaseItems(fixture.tables[table.name] ?? []) : fixture.tables[table.name] ?? [];
      for (const source of rows) {
        const row = { ...source };
        if (table.name === 'BaseItems') for (const macro of ['%AppDataPath%', '%MetadataPath%']) row.Path = expandStatePath(row.Path, macro, macro);
        await db.insert(table.name, row);
      }
    }
    runtime=await createRuntime({...fixture.settings,programDataPath:state.root,metadataPath:path.join(state.root,'metadata'),database:db,onError:()=>{}});
    await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
    const actual=await recordVersionHttp(`http://127.0.0.1:${runtime.server.address().port}`);
    assert.equal(actual.length,16);
    assert.deepEqual(normalize(actual),normalize(native));
  }finally{
    try { if(runtime)await runtime.close(); } finally { await state.close(); }
  }
});
