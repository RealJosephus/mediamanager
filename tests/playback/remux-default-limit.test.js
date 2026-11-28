import { createPlaybackState } from './runtime-state.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { extractionFixture } from './extraction-fixture.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import reference from './fixtures/remux-reference.json' with { type: 'json' };
import extracted from './fixtures/extraction-reference.json' with { type: 'json' };
import library from '../library/fixtures/reference-media.json' with { type: 'json' };
import { playbackTransportSummary, withStreamDiagnostics } from '../helpers/playback-transport-projection.js';

const itemId = '22222222-2222-2222-2222-222222222222';
const id = itemId.replaceAll('-', '');
const headersOf = response => ({ status: response.status, contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges'), length: response.headers.get('content-length') });
const packetProjection = probe => ({ streams: probe.streams?.map(value => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels'].filter(key => value[key] != null).map(key => [key, value[key]]))),
  packets: probe.packets?.map(value => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags'].filter(key => value[key] != null).map(key => [key, value[key]]))) });
async function seed(database) {
  for (const [table, rows] of Object.entries(reference.tables)) {
    const columns = tableDefinition(table).columns, pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
}
async function eventually(condition) { for (let index = 0; index < 300; index++) { if (condition()) return; await delay(10); } assert.fail('Expected the asynchronous operation to finish.'); }

test('observe a stopped progressive stream at the standard four-encoder limit', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `remux_http_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture(Object.fromEntries(reference.sources.map(source => ['/' + source.name, Buffer.from(source.media, 'base64')])));
  fixture.identityMap = new IdentityAccessMap();
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Remux', accessRoot: '/', style: 'windows', returnAccess: 'Isolated HTTP fixture.' });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-remux-'));
  const processes = [];
  const state = await createPlaybackState();
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId, programDataPath: state.root,
      vfs: fixture.vfs, identityMap: fixture.identityMap, remuxOptions: { onProcess: entry => processes.push(entry.args) }, onError: () => {} });
    const user = await runtime.users.createUser({ Name: 'RemuxReader', Password: 'isolated-remux-password' });
    const policy = { ...library.user.Policy, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true };
    await runtime.users.updatePolicy(user.Id, policy);

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="Remux Fixture", Device="Isolated", DeviceId="remux-fixture", Version="1"' }, body: JSON.stringify({ Username: 'RemuxReader', Pw: 'isolated-remux-password' }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).AccessToken, headers = { Authorization: `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' };
    const normalize = body => playbackTransportSummary(body, token);
    const expectedInfo = body => withStreamDiagnostics(body, () => ['ContainerNotSupported']);
    const info = async (entry, sourceId = id) => {
      const response = await fetch(origin + `/Items/${sourceId}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({ DeviceProfile: entry.profile, MediaSourceId: sourceId, ...entry.options }) });
      assert.equal(response.status, 200); return response.json();
    };
    const remuxUrl=(await info(reference.profiles.find(p=>p.name==='mp4'))).MediaSources[0].TranscodingUrl;
    const otherSession = suffix => {
      const url=new URL(remuxUrl,origin);url.searchParams.set('PlaySessionId','default-'+suffix);return url;
    };
    assert.equal(runtime.remux.maxConcurrentRemuxes,4);
    const holders=[],holdingRequests=[];
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const bridge = runtime.remux.bridge, originalLease = bridge.lease;
    let first = true;
    bridge.lease = async function(...args) {
      const lease = await originalLease.apply(this,args);
      if (!first) return lease;
      first = false;
      return {...lease, async release() {
        await lease.release();
        entered.resolve();
        await release.promise;
      }};
    };
    try {
      fixture.setDelay(15000);
      const abandonedUrl = otherSession('audit-abandoned'), client = new AbortController();
      const before = fixture.requests.length;
      const abandoned = assert.rejects(fetch(abandonedUrl, { headers, signal:client.signal }),{name:'AbortError'});
      await eventually(()=>fixture.requests.slice(before).some(request=>request.method==='GET'));
      for(let i=0;i<3;i++){
        const holder=new AbortController();holders.push(holder);
        holdingRequests.push(fetch(otherSession('other-'+i),{headers,signal:holder.signal}).then(r=>r.arrayBuffer()).catch(()=>undefined));
      }
      await eventually(()=>processes.length>=4 && fixture.requests.slice(before).filter(request=>request.method==='GET').length>=4);
      const activeBeforeCancel=processes.length;
      client.abort(); await abandoned;
      assert.ok(await Promise.race([entered.promise.then(()=>true),delay(8000,false,{ref:false})]),'previous stream reached final source release');
      const target = new URLSearchParams({deviceId:abandonedUrl.searchParams.get('DeviceId'),playSessionId:abandonedUrl.searchParams.get('PlaySessionId')});
      let stopStatus;
      const closing = fetch(origin+'/Videos/ActiveEncodings?'+target,{method:'DELETE',headers}).then(r=>{stopStatus=r.status;});
      await Promise.race([closing,delay(700,undefined,{ref:false})]);
      const stopStatusWhileHeld = stopStatus ?? null;
      fixture.setDelay(0);
      const next = otherSession('audit-replacement');
      const blocked = await fetch(next,{headers}); await blocked.arrayBuffer();
      release.resolve(); await closing;
      let lastStatus, attempts=0;
      for (;attempts<40;attempts++) {
        const r=await fetch(next,{headers});lastStatus=r.status;await r.arrayBuffer();
        if(lastStatus===200)break;
        await delay(50);
      }
      const dest=path.join(process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT,'implementation-audit');
      await mkdir(dest,{recursive:true});
      await writeFile(path.join(dest,'remux-default.json'),JSON.stringify({defaultLimit:runtime.remux.maxConcurrentRemuxes,activeBeforeCancel,otherClients:holders.length,previousSourceReleaseHeld:true,stopStatusWhileHeld,
        replacementWhileHeld:blocked.status,finalStopStatus:stopStatus,replacementAfterRelease:lastStatus,attemptsAfterRelease:attempts+1},null,2));
    } finally {release.resolve();bridge.lease=originalLease;for(const holder of holders)holder.abort();await Promise.allSettled(holdingRequests);}

  } finally {
    if (database) { await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); }
    if (runtime) await runtime.close(); else await database?.close();
    await fixture.close(); await state.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mediamanager-remux-'));
    await rm(directory, { recursive: true, force: true });
  }
});
