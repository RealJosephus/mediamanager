import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { PlaybackService } from '../../src/playback/service.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { createTestApplication } from '../helpers/application.js';
import { openHttpStorage } from '../storage/http-fixture.js';

const payload = Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nRecovered subtitle source.\r\n\r\n');
const itemId = 'f9a10000-0000-0000-0000-000000000001'.replaceAll('-', '');
const failurePayload = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(failurePayload);
  const keys = value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, failurePayload(value[key])]));
};
const closeServer = server => server?.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined;

async function fixture(t, protocol, { readFailure, failRead = true, closeFailure, failClose = true }) {
  const sockets = new Set(), diagnostics = [];
  let faults = { readFailure, failRead, closeFailure, failClose }, storage, playback, application;
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-subrip', 'Content-Length': payload.length });
    if (faults.failRead) response.write(payload.subarray(0, 8));
    else response.end(payload);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    const errors = [];
    for (const operation of [() => playback?.beginClose(), () => application?.beginClose(),
      () => application?.drainRequests(), () => playback?.drainSubtitlePreparations(),
      () => closeServer(application?.server), () => storage?.close(), () => closeServer(upstream)]) {
      try { await operation(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Subtitle reader fixture cleanup failed.', { cause: errors[0] });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening', { signal: t.signal });
  const url = `http://127.0.0.1:${upstream.address().port}/source.srt`;
  storage = await openHttpStorage();
  const identityPath = protocol === 'Http' ? url : 'Z:\\Captions\\source.srt';
  const identityMap = protocol === 'Http' ? storage.identityMap : new IdentityAccessMap();
  if (protocol === 'File') identityMap.addPrefix({ identityRoot: identityPath, accessRoot: storage.access(url), style: 'windows',
    returnAccess: 'The isolated File identity reads the owned HTTP storage object.' });
  const openRead = storage.vfs.openRead.bind(storage.vfs);
  storage.vfs.openRead = async (...args) => {
    const selected = faults, handle = await openRead(...args);
    if (!selected.failRead && !selected.failClose) return handle;
    return { ...handle,
      stream: selected.failRead ? (async function* () {
        for await (const _chunk of handle.stream) throw selected.readFailure;
      })() : handle.stream,
      async close() { await handle.close(); if (selected.failClose) throw selected.closeFailure; },
    };
  };
  const item = { Id: itemId, Path: 'Z:\\Captions\\unread.mkv', MediaType: 'Video' };
  const source = { Id: itemId, Path: item.Path, Protocol: 'File', MediaStreams: [{ Type: 'Subtitle', Index: 0, Codec: 'subrip',
    IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: identityPath }] };
  playback = new PlaybackService({ library: { async getItemRecord() { return item; }, async getMediaSources() { return [source]; } },
    vfs: storage.vfs, identityMap, getEncodingOptions: () => defaultConfiguration('encoding') });
  application = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true }, playback,
    authentication: { async authenticate() { return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }; }, authorize() {} },
    onError: (error, context) => diagnostics.push({ error, phase: context.phase }),
  });
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening', { signal: t.signal });
  const request = async () => {
    const result = {};
    try {
      const response = await fetch(`http://127.0.0.1:${application.server.address().port}/Videos/${itemId}/${itemId}/Subtitles/0/Stream.srt`, { signal: t.signal });
      result.status = response.status; result.contentType = response.headers.get('content-type');
      result.bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) { result.transportError = failurePayload(error); }
    await application.drainRequests();
    await Promise.all([...sockets].map(socket => socket.closed ? undefined : new Promise(resolve => socket.once('close', resolve))));
    return result;
  };
  return { diagnostics, request, recover() { faults = { failRead: false, failClose: false }; } };
}

test('formatted subtitle reads retain their original failure before an actual source handle close failure', { timeout: 30000 }, async t => {
  for (const protocol of ['File', 'Http']) for (const kind of ['error', 'false', 'zero', 'undefined']) await t.test(`${protocol}/${kind}`, async t => {
    const readFailure = kind === 'error' ? Object.assign(new Error('The subtitle source read failed.', { cause: new Error('The upstream reader stopped.') }),
      { code: 'unavailable', status: 503 }) : { false: false, zero: 0, undefined: undefined }[kind];
    const closeFailure = Object.assign(new Error('The subtitle source handle closed with an error.', { cause: new Error('The source socket was already released.') }),
      { code: 'close-failed', status: 507 });
    const owned = await fixture(t, protocol, { readFailure, closeFailure });
    const failed = await owned.request();
    assert.equal(failed.status, kind === 'error' ? 503 : 500);
    assert.equal(failed.bytes.toString(), 'Error processing request.');
    const observed = owned.diagnostics.find(value => value.phase === 'response-stream')?.error;
    assert.deepEqual(observed.errors.map(failurePayload), [readFailure, closeFailure].map(failurePayload));
    assert.deepEqual(failurePayload(observed.cause), failurePayload(readFailure));
    if (kind === 'error') { assert.equal(observed.code, readFailure.code); assert.equal(observed.status, readFailure.status); }
    owned.recover(); const recovered = await owned.request();
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.bytes, payload);
  });
});

test('a solitary falsy File subtitle read rejection retains its original reason and allows a later read', { timeout: 30000 }, async t => {
  for (const [kind, readFailure] of [['false', false], ['zero', 0], ['undefined', undefined]]) await t.test(kind, async t => {
    const owned = await fixture(t, 'File', { readFailure, failClose: false });
    const failed = await owned.request(); assert.equal(failed.status, 500);
    const observed = owned.diagnostics.find(value => value.phase === 'response-stream')?.error;
    assert.equal(Object.hasOwn(observed, 'cause'), true); assert.equal(observed.cause, readFailure);
    owned.recover(); const recovered = await owned.request();
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.bytes, payload);
  });
});

test('a solitary subtitle handle close failure remains the original diagnostic after response publication', { timeout: 30000 }, async t => {
  for (const protocol of ['File', 'Http']) for (const kind of ['error', 'false', 'zero', 'undefined']) await t.test(`${protocol}/${kind}`, async t => {
    const closeFailure = kind === 'error' ? Object.assign(new Error('The source handle could not finish its close.', { cause: new Error('The actual HTTP owner was released.') }),
      { code: 'close-failed', status: 507 }) : { false: false, zero: 0, undefined: undefined }[kind];
    const owned = await fixture(t, protocol, { failRead: false, closeFailure });
    const failed = await owned.request();
    const observed = owned.diagnostics.find(value => value.phase === 'response-stream')?.error;
    if (kind === 'error') assert.deepEqual(failurePayload(observed), failurePayload(closeFailure));
    else { assert.equal(Object.hasOwn(observed, 'cause'), true); assert.equal(observed.cause, closeFailure); }
    if (failed.status !== undefined) assert.equal(failed.status, 200);
    if (failed.bytes) assert.deepEqual(failed.bytes, payload); else assert.ok(failed.transportError);
    owned.recover(); const recovered = await owned.request();
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.bytes, payload);
  });
});
