import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { createPlaybackState } from './runtime-state.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/extraction-reference.json' with { type: 'json' };
import errors from './fixtures/extraction-errors.json' with { type: 'json' };
import libraryFixture from '../library/fixtures/reference-media.json' with { type: 'json' };

const itemId = '22222222-2222-2222-2222-222222222222';
const id = itemId.replaceAll('-', '');
const source = reference.sources[0].source;
const subtitlePath = `/Videos/${id}/${id}/Subtitles/1/0/Stream.srt`;
const attachmentPath = `/Videos/${id}/${id}/Attachments/3`;
const normalize = text => {
  const value = JSON.parse(text); if (value && typeof value === 'object') delete value.traceId; return value;
};
async function seed(database) {
  for (const [table, rows] of Object.entries(libraryFixture.tables)) {
    const columns = tableDefinition(table).columns, pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  await database.update('BaseItems', { Id: itemId }, { Path: source.Path });
  for (const stream of source.MediaStreams) await database.insert('MediaStreamInfos', probeStreamRow(itemId, stream));
  for (const stream of source.MediaAttachments) await database.insert('AttachmentStreamInfos', Object.fromEntries(tableDefinition('AttachmentStreamInfos').columns.map(column => [column.name,
    ({ ...stream, ItemId: itemId, Filename: stream.FileName })[column.name] ?? null])));
}

test('real embedded extraction, attachment MVC errors and access cancellation on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `extraction_http_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture(Object.fromEntries(reference.sources.map(value => ['/' + value.name, Buffer.from(value.media, 'base64')])));
  const state = await createPlaybackState();
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: libraryFixture.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap, onError: () => {} });
    const user = await runtime.users.createUser({ Name: 'ExtractionAdmin', Password: 'isolated-extraction-password' });
    await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="Extraction Test", Device="Isolated", DeviceId="extraction-test", Version="1"' },
      body: JSON.stringify({ Username: 'ExtractionAdmin', Pw: 'isolated-extraction-password' }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).AccessToken;
    const headers = { Authorization: `MediaBrowser Token="${token}"` };
    const before = fixture.requests.length;
    assert.equal((await fetch(origin + subtitlePath)).status, 401);
    assert.equal(fixture.requests.length, before, 'Unauthorized subtitle access must not open VFS.');
    for (const expected of errors) {
      const response = await fetch(origin + expected.path, { headers: { ...(!expected.anonymous ? headers : {}), ...(expected.accept ? { Accept: expected.accept } : {}) } });
      assert.equal(response.status, expected.status, expected.name);
      assert.equal(response.headers.get('content-type'), expected.contentType, expected.name);
      assert.equal(response.headers.get('content-length'), expected.length, expected.name);
      assert.deepEqual(normalize(await response.text()), normalize(expected.text), expected.name);
    }
    assert.equal(fixture.requests.length, before, 'Missing item/source/attachment must not touch VFS.');
    for (const expected of reference.outputs.filter(value => value.source === 'media.mkv')) {
      const response = await fetch(origin + `/Videos/${id}/${id}/Subtitles/${expected.index}/0/Stream.${expected.format}`, { headers });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()), recorded = Buffer.from(expected.bytes, 'base64');
      if (expected.format === 'ass') {
        const lines = value => value.toString('latin1').replace(/\r?\n/gu, '\n');
        assert.equal(lines(bytes), lines(recorded), 'ASS line terminators may differ; every other byte stays exact.');
      } else assert.deepEqual(bytes, recorded);
      assert.equal(response.headers.get('content-type'), expected.format === 'ass' ? 'text/x-ssa' : 'application/x-subrip');
    }
    const converted = await fetch(origin + `/Videos/${id}/${id}/Subtitles/1/15000000/Stream.vtt?endPositionTicks=26000000`, { headers });
    assert.equal(converted.status, 200);
    assert.match(await converted.text(), /00:00:00\.000 --> 00:00:01\.000/);
    const attachment = await fetch(origin + attachmentPath, { headers });
    assert.equal(attachment.status, 200);
    assert.equal(Buffer.from(await attachment.arrayBuffer()).toString('base64'), reference.attachment);
    assert.equal(attachment.headers.get('content-type'), source.MediaAttachments[0].MimeType);
    await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy, AllowedTags: ['not-present-in-fixture'] });
    const visibleReads = fixture.requests.length;
    assert.equal((await fetch(origin + attachmentPath, { headers })).status, 404);
    assert.equal((await fetch(origin + subtitlePath, { headers })).status, 404);
    assert.equal(fixture.requests.length, visibleReads, 'Authenticated visibility checks must happen before cache and VFS access.');
    await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy });
    fixture.replace('/media.mkv', Buffer.from(reference.sources[0].media, 'base64'));
    fixture.setDelay(1000);
    const controller = new AbortController();
    const readCount = fixture.requests.filter(value => value.method === 'GET').length;
    const pending = fetch(origin + subtitlePath, { headers, signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; i < 300 && fixture.requests.filter(value => value.method === 'GET').length === readCount; i++) await delay(10);
    assert.ok(fixture.requests.filter(value => value.method === 'GET').length > readCount);
    controller.abort(); await cancelled;
    for (let i = 0; i < 300 && !fixture.closedReads; i++) await delay(10);
    assert.ok(fixture.closedReads, 'Disconnecting the HTTP client must cancel the extraction input.');
    assert.equal(fixture.requests.some(value => value.authorization), false, 'The private VFS bridge must never expose the user token upstream.');
  } finally {
    if (database) { await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); }
    try { if (runtime) await runtime.close(); else await database?.close(); await fixture.close(); }
    finally { await state.close(); }
  }
});
