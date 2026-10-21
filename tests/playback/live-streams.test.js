import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LiveTvTunerService } from '../../src/library/live-tv-tuner-service.js';
import { LiveStreamsService } from '../../src/playback/live-streams.js';
import { addLiveMediaInfo } from '../../src/playback/live-stream-probe.js';
import { md5Guid } from '../../src/core/identity.js';

const channelId = '123456781234123412341234567890ab';
const token = original => md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider') + '_LiveTvChannel_' + channelId + '_' + original;
const source = () => ({ Id: 'fixed-source', Path: 'http://127.0.0.1:1/original.ts', Protocol: 'Http',
  SupportsTranscoding: true, SupportsDirectPlay: true, SupportsDirectStream: true, SupportsProbing: false, RequiresOpening: true,
  RequiredHttpHeaders: {}, MediaStreams: [{ Type: 'Video', Index: 1, Width: 1920 }, { Type: 'Audio', Index: 2, BitRate: 128000 }] });
const turn = () => new Promise(resolve => setImmediate(resolve));

function input({ bytes = false } = {}) {
  const records = []; let stopped = false;
  const sharing = { get enabled() { return !stopped && records.some(record => !record.closed); }, retain: () => acquire() };
  function acquire() {
    const record = { closed: false, closes: 0, started: Promise.withResolvers(), closing: Promise.withResolvers(), pending: Promise.withResolvers(), offset: 0 };
    records.push(record);
    const iterator = { [Symbol.asyncIterator]() { return this; }, next() {
      record.started.resolve(); return record.offset++ === 0 ? Promise.resolve({ done: false, value: Buffer.from([0, 255, 71, 13, 10]) }) : record.pending.promise;
    }, return() { record.pending.resolve({ done: true }); return Promise.resolve({ done: true }); } };
    let closing;
    const close = () => closing ??= (async () => {
      record.closed = true; record.closes++; record.closing.resolve(); record.pending.resolve({ done: true });
      await record.gate?.promise;
    })();
    return { mode: 'native', tunerHostId: 'controlled-host', mediaSource: source(), sharing, ...(bytes ? { stream: iterator } : {}), close };
  }
  return { records, acquire, stop() { stopped = true; } };
}

function fixture({ bytes = false, probe = { async addMediaInfo(value) { return addLiveMediaInfo(value); } }, opening } = {}) {
  const inputs = [], calls = [], errors = [];
  const tuner = { async getChannelStreamMediaSources() { return [{ mode: 'native', mediaSource: source() }]; },
    async getChannelStream(channel, original, current, options) {
      calls.push({ channel, original, current }); const selected = input({ bytes }); inputs.push(selected);
      const owned = selected.acquire(); return opening ? opening(owned, options) : owned;
    } };
  const tuners = new LiveTvTunerService({ plugins: { entries: kind => kind === 'tuner' ? [tuner] : [] },
    sources: { async addProviderMetadata() {}, async getPrograms() { return []; } } });
  const library = { itemCreation: { async getItemById(id) {
    assert.equal(id.replaceAll('-', ''), channelId); return { Type: 'LiveTvChannel', ChannelType: 'TV', ExternalId: 'external-channel', ServiceName: 'Emby' };
  } } };
  const streams = new LiveStreamsService({ tuners, library, probe, getLocalApiUrl: () => 'http://127.0.0.1:1', onError: error => errors.push(error) });
  return { streams, tuners, inputs, calls, errors, async close() { await streams.close(); await tuners.close(); } };
}

test('public counter closes reuse only the same input while private HTTP readers drain independently', { timeout: 20000 }, async t => {
  const value = fixture({ bytes: true }), gate = Promise.withResolvers(); let listener, closing, reading;
  const release = () => gate.resolve(); t.signal.addEventListener('abort', release, { once: true });
  try {
    const first = await value.streams.open({ OpenToken: token('original') }), second = await value.streams.open({ OpenToken: token('ORIGINAL') });
    const id = first.MediaSource.LiveStreamId;
    assert.equal(second.MediaSource.LiveStreamId, id); assert.equal(value.inputs.length, 1);
    assert.equal(first.MediaSource.SupportsTranscoding, false); assert.equal(value.streams.snapshot()[0].ConsumerCount, 2);
    const unique = value.streams.snapshot()[0].UniqueId;
    listener = createServer((request, response) => { void value.streams.streamFile(unique, 'video/mp2t').send(request, response).catch(error => response.destroy(error)); });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const response = await fetch('http://127.0.0.1:' + listener.address().port + '/raw'), reader = response.body.getReader();
    assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from([0, 255, 71, 13, 10]));
    assert.equal(value.streams.snapshot()[0].ConsumerCount, 2); assert.equal(value.streams.snapshot()[0].ReaderCount, 1);
    assert.equal(value.tuners.getLiveStreams()[0].ConsumerCount, 2);
    await value.streams.closeLiveStream(id.toUpperCase()); assert.equal(value.streams.snapshot()[0].ConsumerCount, 1);
    assert.equal(value.inputs[0].records[2].closed, false);
    value.inputs[0].records[2].gate = gate;
    reading = reader.read(); void reading.catch(() => {}); let drained = false;
    closing = value.streams.closeLiveStream(id).then(() => { drained = true; });
    await value.inputs[0].records[2].closing.promise; await turn(); assert.equal(drained, false);
    assert.equal(value.streams.getLiveStream(id), null); assert.throws(() => value.streams.streamFile(unique, 'video/mp2t'), { status: 404 });
    release(); await closing; await Promise.allSettled([reading]); await reader.cancel().catch(() => {}); reader.releaseLock();
    assert.deepEqual(value.streams.snapshot(), []); assert.deepEqual(value.tuners.getLiveStreams(), []);
    assert.ok(value.inputs[0].records.every(record => record.closed && record.closes === 1));
  } finally {
    release(); await Promise.allSettled([closing, reading]); await value.close();
    if (listener) { listener.closeAllConnections(); await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  }
});

test('a fresh source with the same public ID replaces its visible input without reusing or counting retired ownership', async () => {
  const value = fixture();
  try {
    const first = await value.streams.open({ OpenToken: token('hidden-original') }), firstUnique = value.streams.snapshot()[0].UniqueId;
    const second = await value.streams.open({ OpenToken: token('visible-original') });
    assert.equal(first.MediaSource.LiveStreamId, second.MediaSource.LiveStreamId);
    assert.equal(value.streams.snapshot()[0].ConsumerCount, 1); assert.equal(value.inputs.length, 2);
    assert.throws(() => value.streams.streamFile(firstUnique, 'video/mp2t'), { status: 404 });
    await value.streams.open({ OpenToken: token('HIDDEN-ORIGINAL') });
    assert.equal(value.inputs.length, 3, 'The hidden input cannot participate in original-ID lookup.');
    assert.deepEqual(value.calls.map(call => call.current.length), [0, 1, 1]);
    assert.deepEqual(value.calls[2].current.map(item => item.OriginalStreamId), ['visible-original']);
    assert.deepEqual(value.tuners.getLiveStreams().map(item => item.ConsumerCount), [1, 1, 1]);
    await value.streams.closeLiveStream(first.MediaSource.LiveStreamId);
    assert.deepEqual(value.streams.snapshot(), []); assert.equal(value.inputs[2].records[0].closed, true);
    assert.equal(value.inputs[0].records[0].closed, false); assert.equal(value.inputs[1].records[0].closed, false);
    await value.close(); assert.ok(value.inputs.every(item => item.records.every(record => record.closed && record.closes === 1)));
  } finally { await value.close(); }
});

test('an admitted probe cancellation falls back while retaining its public input until explicit close', async () => {
  const entered = Promise.withResolvers(), request = new AbortController();
  const value = fixture({ probe: { async addMediaInfo(_source, { signal }) {
    entered.resolve(); await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } } });
  try {
    const pending = value.streams.open({ OpenToken: token('probe-cancel') }, { signal: request.signal });
    await entered.promise; request.abort(); const result = await pending;
    assert.equal(value.errors.length, 1); assert.equal(value.streams.snapshot()[0].ConsumerCount, 1);
    assert.equal(value.inputs[0].records[0].closed, false); assert.equal(result.MediaSource.Bitrate, 20128000);
    await value.streams.closeLiveStream(result.MediaSource.LiveStreamId); assert.equal(value.inputs[0].records[0].closed, true);
  } finally { await value.close(); }
});

test('a failure after registration preserves the actual native public ownership prefix for a later Close', async () => {
  const value = fixture({ probe: { addMediaInfo(source) { source.MediaStreams = null; throw new Error('Controlled failed probe.'); } } });
  try {
    await assert.rejects(value.streams.open({ OpenToken: token('invalid-probe-streams') }), { nativeException: 'ArgumentNullException' });
    assert.equal(value.streams.snapshot()[0].ConsumerCount, 1); assert.equal(value.inputs[0].records[0].closed, false);
    const id = value.streams.snapshot()[0].LiveStreamId; assert.equal(value.streams.getLiveStream(id).MediaStreams, null);
    await value.streams.closeLiveStream(id); assert.equal(value.inputs[0].records[0].closes, 1); assert.deepEqual(value.streams.snapshot(), []);
  } finally { await value.close(); }
});

test('shutdown closes a provider result arriving after cancellation and awaits its held release before returning', { timeout: 20000 }, async t => {
  const entered = Promise.withResolvers(), delivery = Promise.withResolvers(), release = Promise.withResolvers();
  let received;
  const value = fixture({ opening: async (owned, { signal }) => { received = { owned, signal }; entered.resolve(); await delivery.promise; return owned; } });
  const finish = () => { delivery.resolve(); release.resolve(); }; t.signal.addEventListener('abort', finish, { once: true });
  let pending, closing;
  try {
    pending = value.streams.open({ OpenToken: token('late') }); const rejected = assert.rejects(pending);
    await entered.promise; value.inputs[0].records[0].gate = release;
    let drained = false; closing = value.streams.close().then(() => { drained = true; });
    assert.equal(received.signal.aborted, true); delivery.resolve();
    await value.inputs[0].records[0].closing.promise; await turn(); assert.equal(drained, false);
    release.resolve(); await rejected; await closing; assert.deepEqual(value.streams.snapshot(), []);
    assert.equal(value.inputs[0].records[0].closes, 1); await assert.rejects(value.streams.open({ OpenToken: token('closed') }), { status: 503 });
  } finally { finish(); await Promise.allSettled([pending, closing]); await value.close(); }
});
