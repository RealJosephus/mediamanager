import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { createMediaFixture, recordPlayback, movieId } from './http-scenario.js';
import libraryFixture from '../library/fixtures/reference-media.json' with { type: 'json' };
import streamsFixture from '../library/fixtures/reference-streams.json' with { type: 'json' };
import { subtitleLayoutProjection } from './layout-projection.js';
import { observeComparison } from '../comparison-observations.js';
import { consumerFixture } from '../consumer-contracts/fixture.js';
const expected = parseLosslessJson(await readFile(new URL('./fixtures/http-reference.json', import.meta.url), 'utf8'));
const readers = await consumerFixture('readers');
const subtitleRoot = 'Z:\\PlaybackSidecars';

async function seed(database) {
  for (const [table, rows] of Object.entries(libraryFixture.tables)) {
    const columns = tableDefinition(table).columns;
    const pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(id => !id || inserted.has(id))) : 0;
      assert.notEqual(index,-1);
      const [row] = pending.splice(index,1);
      await database.insert(table,Object.fromEntries(Object.entries(row).map(([name,value])=>[name,value!=null && columns.find(column=>column.name===name)?.type==='INTEGER' && typeof value==='string' ? BigInt(value):value])));
      inserted.add(row.Id);
    }
  }
  for (const row of streamsFixture.rows) await database.insert('MediaStreamInfos',row.StreamIndex===5 ? {...row,Path:subtitleRoot+'\\fixture.srt',Codec:'subrip'}:row);
  await database.update('BaseItems',{Id:'22222222-2222-2222-2222-222222222222'},{TotalBitrate:null});
}

test('native HTTP original bytes, complete negotiation and generated subtitle semantics on PostgreSQL',{skip:!process.env.MEDIAMANAGER_TEST_POSTGRES},async t=>{
  const schema = `playback_http_${Date.now()}`;
  let database, runtime, recorded, runtimePort, fixturePort;
  const delivered = [], layouts = [];
  const fixture = await createMediaFixture({subtitleRoot});
  try {
    database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true});await seed(database);
    runtime=await createRuntime({database,configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},serverId:libraryFixture.serverId,programDataPath:libraryFixture.programDataPath,vfs:fixture.vfs,identityMap:fixture.identityMap});
    const user=await runtime.users.createUser({Name:'CoreFlowAdmin',Password:'isolated-core-flow-password'});
    await runtime.users.updatePolicy(user.Id,{...libraryFixture.user.Policy});
    await runtime.users.updateConfiguration(user.Id,{...streamsFixture.user});
    await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
    runtime.server.prependListener('request', (request, response) => {
      const originalWrite = response.write.bind(response), originalEnd = response.end.bind(response);
      let length = 0, rewritten = false;
      response.write = (chunk, encoding, callback) => {
        let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        const layout = request.headers['x-test-layout'];
        if (layout && !rewritten && /\/Stream\.(?:vtt|subrip)(?:\?|$)/u.test(request.url) && response.statusCode === 200) {
          const text = bytes.toString('utf8'), lines = text.split(/\r\n|\r|\n/u);
          bytes = Buffer.from(lines.join(layout === 'cr' ? '\r' : '\n') + (layout === 'lf-tail' ? '\n\n' : ''));
          response.setHeader('Content-Length', bytes.length); rewritten = true;
        }
        length += bytes.length;
        return originalWrite(bytes, typeof encoding === 'function' ? encoding : callback);
      };
      response.end = (chunk, encoding, callback) => {
        if (chunk != null) length += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        return originalEnd(chunk, encoding, callback);
      };
      response.once('finish', () => delivered.push({ route: request.url, method: request.method, status: response.statusCode,
        contentType: response.getHeader('Content-Type'), contentLength: response.getHeader('Content-Length'), length }));
    });
    runtimePort = runtime.server.address().port;
    fixturePort = fixture.server.address().port;
    const actual=await recordPlayback(`http://127.0.0.1:${runtime.server.address().port}`);
    recorded = actual;
    assert.equal(actual.records.length,expected.records.length);
    const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,entry])=>{
      assert.notEqual(key, 'traceId', 'Undeclared response fields must not be discarded.');
      assert.notEqual(key, 'PlaySessionId', 'Only the validated top-level playback identity may differ.');
      return [key,normalize(entry)];
    })):typeof value==='string'?value.replaceAll(expected.accessToken,'<token>').replaceAll(actual.accessToken,'<token>').replaceAll(expected.subtitleRoot,'<subtitle-root>').replaceAll(subtitleRoot,'<subtitle-root>'):value;
    const nativeSessions = new Set(), candidateSessions = new Set();
    const generated = new Map([['subtitle-vtt', 'vtt'], ['subtitle-offset', 'vtt'], ['subtitle-copy', 'vtt'], ['subtitle-time-map', 'vtt'],
      ['subtitle-query-offset', 'vtt'], ['subtitle-alias-subrip', 'srt'], ['subtitle-alias-subrip-offset', 'srt'], ['subtitle-alias-webvtt', 'vtt']]);
    const contract = (record, sessions) => {
      if (generated.has(record.name)) {
        const { 'content-length': ignoredLength, ...headers } = record.headers;
        return { ...record, headers, body: subtitleLayoutProjection(Buffer.from(record.body.base64, 'base64').toString('utf8'), generated.get(record.name)) };
      }
      if (!record.body || !Object.hasOwn(record.body, 'PlaySessionId')) return normalize(record);
      assert.equal(record.status, 200);
      const { PlaySessionId, ...body } = record.body;
      assert.match(PlaySessionId, /^[a-f0-9]{32}$/u);
      assert.equal(sessions.has(PlaySessionId), false); sessions.add(PlaySessionId);
      return { ...normalize({ ...record, body }), body: { ...normalize(body), PlaySessionId: '$validated-play-session' } };
    };
    for(let index=0;index<expected.records.length;index++) {
      if (generated.has(expected.records[index].name)) observeComparison(t, expected.records[index].name + ' generated delivery', actual.records[index], expected.records[index]);
      assert.deepEqual(contract(actual.records[index], candidateSessions), contract(expected.records[index], nativeSessions), expected.records[index].name);
    }
    const sub = `/Videos/${movieId}/${movieId}/Subtitles/5`;
    for (const [name, route, format] of [['subtitle-vtt', sub + '/Stream.vtt', 'vtt'],
      ['subtitle-time-map', sub + '/Stream.vtt?addVttTimeMap=true', 'vtt'], ['subtitle-alias-subrip', sub + '/Stream.subrip', 'srt']]) {
      const original = actual.records.find(record => record.name === name);
      for (const layout of format === 'vtt' ? ['lf', 'cr', 'lf-tail'] : ['lf', 'cr']) {
        const response = await fetch(`http://127.0.0.1:${runtimePort}${route}`, { headers: { Authorization: `MediaBrowser Token="${actual.accessToken}"`, 'X-Test-Layout': layout } });
        const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
        assert.equal(response.status, original.status); assert.equal(response.headers.get('content-type'), original.headers['content-type']);
        assert.equal(Number(response.headers.get('content-length')), bytes.length);
        const proof = readers.input.subtitles.find(sample => sample.name === name + '--' + layout);
        assert.ok(proof, name + '/' + layout + ' must have an actual reader observation');
        assert.deepEqual(subtitleLayoutProjection(text, format), subtitleLayoutProjection(proof.text, format));
        assert.deepEqual(subtitleLayoutProjection(text, format), subtitleLayoutProjection(Buffer.from(original.body.base64, 'base64').toString('utf8'), format));
        layouts.push({ name, layout, status: response.status, contentType: response.headers.get('content-type'),
          contentLength: response.headers.get('content-length'), body: bytes.toString('base64'), reader: readers.native.subtitles.find(sample => sample.name === proof.name) });
      }
    }
    for (const result of delivered) if (result.method !== 'HEAD' && result.status !== 304 && result.contentLength != null)
      assert.equal(Number(result.contentLength), result.length, result.route + ' actual Content-Length');
    assert.equal(candidateSessions.size, 6); assert.equal(nativeSessions.size, 6);
    assert.equal(fixture.requests.filter(request=>request.url.startsWith('/d/')).every(request=>request.method==='GET'&&!request.authorization),true);
    const before=fixture.requests.length;
    assert.equal((await fetch(`http://127.0.0.1:${runtime.server.address().port}/Items/${movieId}/File`)).status,401);
    assert.equal(fixture.requests.length,before,'Unauthorized callers must not open storage.');
    fixture.setSlow(true);
    const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/Items/${movieId}/File`,{headers:{Authorization:`MediaBrowser Token="${actual.accessToken}"`}});
    assert.equal(response.status,200);
    const reader=response.body.getReader();assert.equal((await reader.read()).done,false);await reader.cancel();
    for(let attempt=0;attempt<100&&!fixture.cancelledReads;attempt++) await delay(10);
    assert.equal(fixture.cancelledReads,1,'Client cancellation must close the upstream original-byte stream.');
  } finally {
    await fixture.close();
    if(database) {await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);}
    if(runtime) await runtime.close();else await database?.close();
  }
  if (process.env.MEDIAMANAGER_PLAYBACK_HTTP_EVIDENCE) {
    const output = assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_PLAYBACK_HTTP_EVIDENCE));
    await mkdir(output, { recursive: false });
    await writeFile(path.join(output, 'postgres.json'), JSON.stringify({ actual: recorded, schema, subtitleRoot,
      runtimePort, fixturePort, delivered, layouts, upstreamRequests: fixture.requests, cancelledReads: fixture.cancelledReads,
      runtimeStopped: runtime.server.listening === false, fixtureStopped: fixture.server.listening === false },
      (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
  }
});
