import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { StorageError } from '../../src/storage/errors.js';
import { dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPlaybackState } from './runtime-state.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/extraction-reference.json' with { type: 'json' };
import errors from './fixtures/extraction-errors.json' with { type: 'json' };
import libraryFixture from '../library/fixtures/reference-media.json' with { type: 'json' };
import { parseLosslessJson } from '../../src/core/json.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

const itemId = '22222222-2222-2222-2222-222222222222';
const id = itemId.replaceAll('-', '');
const source = reference.sources[0].source;
const subtitlePath = `/Videos/${id}/${id}/Subtitles/1/0/Stream.srt`;
const attachmentPath = `/Videos/${id}/${id}/Attachments/3`;
const normalize = (text, status) => projectProblemTrace(parseLosslessJson(text), status);
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

test('real embedded extraction, attachment MVC errors and controller disconnect preserve shared extraction on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const schema = `extraction_http_${randomBytes(8).toString('hex')}`;
  let fixture, state, database, runtime, inputGate, originalRead;
  t.after(async () => {
    inputGate?.release.resolve(); if (originalRead) fixture.adapter.openRead = originalRead;
    const cleanupErrors = [];
    for (const operation of [() => runtime ? runtime.close() : database?.close(),
      () => dropPostgresTestDatabase(database), () => fixture?.close(), () => state?.close()]) {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Extraction HTTP fixture cleanup failed.', { cause: cleanupErrors[0] });
  });
  try {
    fixture = await extractionFixture(Object.fromEntries(reference.sources.map(value => ['/' + value.name, Buffer.from(value.media, 'base64')])));
    state = await createPlaybackState();
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: libraryFixture.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap, onError: () => {} });
    const user = await runtime.users.createUser({ Name: 'ExtractionAdmin', Password: 'isolated-extraction-password' });
    await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy });

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
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
      assert.deepEqual(normalize(await response.text(), response.status), normalize(expected.text, expected.status), expected.name);
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
    inputGate = { entered: Promise.withResolvers(), release: Promise.withResolvers(), inputs: [] };
    originalRead = fixture.adapter.openRead.bind(fixture.adapter);
    fixture.adapter.openRead = async (...arguments_) => {
      const handle = await originalRead(...arguments_), input = { signal: arguments_[1]?.signal, closed: false };
      inputGate.inputs.push(input);
      return { ...handle, stream: (async function* () {
        for await (const chunk of handle.stream) {
          inputGate.entered.resolve(input); await inputGate.release.promise;
          input.signal?.throwIfAborted(); yield chunk;
        }
      })(), async close() { await handle.close(); input.closed = true; } };
    };
    const publicServer = runtime.networkHost.listeners.find(entry => entry.scheme === 'http').server;
    const requested = once(publicServer, 'request', { signal: t.signal });
    const controller = new AbortController();
    const pending = fetch(origin + subtitlePath, { headers, signal: AbortSignal.any([t.signal, controller.signal]) });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    void cancelled.catch(() => {});
    const [incoming, outgoing] = await requested; assert.equal(incoming.url, subtitlePath);
    const closed = once(outgoing, 'close', { signal: t.signal });
    const input = await Promise.race([inputGate.entered.promise, pending.then(() => { throw new Error('The extraction input was not held.'); })]);
    controller.abort(); await cancelled;
    await closed; assert.equal(outgoing.destroyed, true); assert.equal(outgoing.writableFinished, false);
    // The designated controller passes CancellationToken.None to its encoder.
    // A client disconnect does not cancel the admitted shared producer.
    assert.equal(input.signal.aborted, false);
    const sharedRequested = once(publicServer, 'request', { signal: t.signal });
    const shared = fetch(origin + subtitlePath, { headers, signal: t.signal }); void shared.catch(() => {});
    const [sharedIncoming] = await sharedRequested; assert.equal(sharedIncoming.url, subtitlePath);
    assert.equal(input.signal.aborted, false); inputGate.release.resolve();
    const expected = reference.outputs.find(value => value.source === 'media.mkv' && value.type === 'subtitle' && value.index === 1);
    const sharedResponse = await shared; assert.equal(sharedResponse.status, 200);
    assert.deepEqual(Buffer.from(await sharedResponse.arrayBuffer()), Buffer.from(expected.bytes, 'base64'));
    await runtime.playback.drainSubtitlePreparations();
    for (const owned of inputGate.inputs) assert.equal(owned.closed, true, 'The actual source read handle closed after production drained.');
    // Keep the source version metadata available while its body is unavailable.
    // The completed producer must leave a usable cache for a later HTTP reader.
    fixture.adapter.openRead = async () => { throw new StorageError('unavailable', 'The source body is unavailable after the completed extraction.'); };
    const cached = await fetch(origin + subtitlePath, { headers, signal: t.signal }); assert.equal(cached.status, 200);
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), Buffer.from(expected.bytes, 'base64'));
    assert.equal(fixture.requests.some(value => value.authorization), false, 'The private VFS bridge must never expose the user token upstream.');
  } finally {
    inputGate?.release.resolve();
  }
});
