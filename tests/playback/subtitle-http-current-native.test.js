import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { subtitleProfile } from '../../src/playback/profile.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { subtitleLayoutProjection } from './layout-projection.js';
import { createSubtitleHttpSource } from './http-subtitle-source.js';
import { captureCurrentHttpSubtitles, hash, json, errorValue } from './fixtures/subtitle-http-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL && postgresTestConnectionString);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const fileValue = value => value.exists ? { exists: true, bytes: value.bytes, base64: value.base64, sha256: value.sha256 } : { exists: false };
const stateValue = value => ({ source: fileValue(value.source), cache: fileValue(value.cache), meta: fileValue(value.meta),
  sourceOnline: value.sourceOnline, sourceMode: value.sourceMode });
const rawHeaders = value => Object.fromEntries(['allow', 'content-type', 'content-length', 'accept-ranges', 'content-range', 'content-disposition',
  'content-encoding', 'etag', 'last-modified', 'cache-control', 'vary', 'location']
  .filter(name => Object.hasOwn(value, name)).map(name => [name, value[name]]));
const cueValue = text => {
  const value = parseLosslessJson(text);
  return { ...value, TrackEvents: value.TrackEvents.map(cue => ({ ...cue, Text: cue.Text.split(/\r\n|\r|\n/u) })) };
};

test('current Native HTTP subtitle identities deliver raw responses, formatted text and persistent cold/warm SRT caches through storage plugins', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'subtitle-http-current-' + randomUUID()); await fs.mkdir(output);
  const report = { schemaVersion: 1,
    scope: 'Independent actual Native SubtitleController/helper/ActionResult and ISubtitleEncoder caller-token components compared with Node PostgreSQL/VFS/HTTP consumers. HEAD independently uses actual Native MVC method routing. Native component host does not certify full MVC binding, authentication or PlaybackInfo. Encoder-token cancellation and actual controller client disconnect remain separate observations.',
    profiles: [], actions: [], imports: [], mediaCommands: [], bridgeLeases: [], releasedLeases: [], diagnostics: [], cleanup: [], failures: [],
    componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  const failures = [], fail = error => { failures.push(error); report.failures.push(errorValue(error)); };
  const node = path.join(output, 'node'), sourceRoot = path.join(node, 'source'), metadataRoot = path.join(node, 'metadata');
  const dataPath = path.join(node, 'data', 'data'), storageFile = path.join(node, 'storage.json');
  const tools = { ffmpeg: validationExecutable('ffmpeg'), ffprobe: validationExecutable('ffprobe') };
  const samples = new Map();
  let resource, captured, source, runtime, database, lastDatabase, schema, token, origin, generation = 0, gate, pending, cancellation, storageDefinition;
  const processChannel = 'tracing:child_process.spawn:start';
  const bridgeChannel = 'http.server.request.start';
  const observe = ({ process: child }) => {
    const tool = Object.keys(tools).find(name => tools[name] === child.spawnfile); if (!tool) return;
    const entry = { generation, tool, executable: child.spawnfile, arguments: child.spawnargs.slice(1), spawned: false, closed: false, errors: [] };
    report.mediaCommands.push(entry);
    child.once('spawn', () => { Object.assign(entry, { pid: child.pid, spawned: true }); if (gate && entry.arguments.includes('-c:s')) gate.ffmpegSpawned = true; });
    child.once('error', error => entry.errors.push(errorValue(error)));
    child.once('close', (exitCode, signal) => Object.assign(entry, { closed: true, exitCode, signal }));
  };
  const observeBridge = ({ request: incoming, response }) => {
    if (!gate) return;
    if (gate.stage === 'controller-disconnect' && incoming.socket.localPort === Number(new URL(origin).port)
      && incoming.url.startsWith(`/Videos/${gate.publicId}/${gate.publicId}/Subtitles/`)) {
      const selected = gate;
      response.once('close', () => selected.publicClosed.resolve({ method: incoming.method, path: incoming.url, writableFinished: response.writableFinished }));
    }
    if (!['ffmpeg', 'controller-disconnect'].includes(gate.stage) || !gate.ffmpegSpawned || incoming.method !== 'GET') return;
    const lease = report.bridgeLeases.find(value => {
      const address = new URL(value.url); return value.generation === generation && incoming.socket.localPort === Number(address.port) && incoming.url === address.pathname;
    });
    if (lease) { gate.bridgeRead = true; gate.actualBridgeRequest = { method: incoming.method, localPort: incoming.socket.localPort, path: incoming.url, lease: lease.url }; }
  };
  const close = async () => {
    if (!runtime) return;
    const owned = runtime; runtime = undefined;
    try {
      await owned.close();
      const listenersClosed = owned.networkHost.listeners.every(listener => !listener.server.listening);
      report.cleanup.push({ generation, runtimeClosed: true, listenersClosed, databaseClosed: database.closed });
      assert.ok(listenersClosed); assert.equal(database.closed, true);
      for (const command of report.mediaCommands.filter(value => value.generation === generation)) {
        assert.equal(command.closed, true, 'An actual media child closed before runtime shutdown returned.');
        if (command.pid) assert.equal(alive(command.pid), false);
      }
    } finally { lastDatabase = database; database = undefined; }
  };
  const create = async () => {
    generation++; database ??= await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema });
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(node), storageConfiguration: storageFile,
      mediaEncoderOptions: { startupFFmpegPath: tools.ffmpeg }, autoDiscoveryOptions: { enabled: false },
      onError: (error, context) => report.diagnostics.push({ generation, route: context?.request?.url, phase: context?.phase, error: errorValue(error) }) });
    const bridge = runtime.extraction.bridge, lease = bridge.lease.bind(bridge);
    bridge.lease = async (...arguments_) => { const owned = await lease(...arguments_); report.bridgeLeases.push({ generation, path: arguments_[0], url: owned.url }); return owned; };
    await runtime.start(); origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
    if (report.databaseRows) assert.deepEqual(await database.rows('MediaStreamInfos'), report.databaseRows, 'Cold PostgreSQL reopens retain original HTTP subtitle identity rows.');
  };
  const file = async (filename, metadata = false) => {
    let stat, bytes;
    try { stat = metadata ? await runtime.fileSystem.stat(filename, { bigint: true }) : await fs.stat(filename, { bigint: true });
      bytes = metadata ? await runtime.fileSystem.readFile(filename) : await fs.readFile(filename); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code)) return { filename, exists: false }; throw error; }
    return { filename, exists: true, bytes: bytes.length, base64: bytes.toString('base64'), sha256: hash(bytes), text: bytes.toString('utf8'), modifiedNanoseconds: String(stat.mtimeNs) };
  };
  const paths = definition => runtime.extraction.subtitleCache.paths(definition.mediaSourceId, definition.streamIndex);
  const snapshot = async definition => {
    const sample = samples.get(definition.name), cache = paths(definition);
    return { source: await file(sample.filename), cache: await file(cache.filename, true), meta: await file(cache.metadata, true),
      sourceOnline: source.online, sourceMode: sample.mode };
  };
  const request = async (definition, action, signal = t.signal) => {
    const id = definition.mediaSourceId.replaceAll('-', '').toLowerCase();
    const route = `/Videos/${id}/${id}/Subtitles/${definition.streamIndex}/Stream.${action.op === 'raw' ? 'srt?format=' : action.format + '?copyTimestamps=true&startPositionTicks=0&endPositionTicks=0'}`;
    const headers = { Authorization: `MediaBrowser Token="${token}"`, ...action.headers };
    const response = await fetch(origin + route, { method: action.method ?? 'GET', headers, signal });
    let bytes;
    if (action.cancelAfterBytes) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (size < action.cancelAfterBytes) { const next = await reader.read(); assert.equal(next.done, false); chunks.push(next.value); size += next.value.byteLength; }
      bytes = Buffer.concat(chunks).subarray(0, action.cancelAfterBytes);
      await gate.entered.promise; cancellation.abort(); await reader.cancel().catch(() => {});
    } else bytes = Buffer.from(await response.arrayBuffer());
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && action.method !== 'HEAD' && !action.cancelAfterBytes) assert.equal(BigInt(contentLength), BigInt(bytes.length), 'A declared response length describes the actual complete body.');
    return { route, method: action.method ?? 'GET', status: response.status, headers: Object.fromEntries(response.headers),
      base64: bytes.toString('base64'), bytes: bytes.length, sha256: hash(bytes), text: bytes.toString('utf8'), partial: Boolean(action.cancelAfterBytes) };
  };
  const compareWire = (actual, expected, action, label, definition) => {
    const original = definition && samples.get(definition.name).source;
    const sourceFormat = definition && path.win32.extname(source.origin + definition.sourceTarget).slice(1).toLowerCase();
    const generatedSrt = action.op === 'format' && action.format === 'srt'
      && original?.extension === '.smi' && original.codec === 'sami' && sourceFormat === 'smi';
    assert.equal(actual.status, expected.status, label + ': actual delivered status');
    assert.equal(actual.headers['content-type'], expected.headers['content-type'], label + ': actual delivered MIME');
    if (action.op === 'raw') {
      assert.deepEqual(rawHeaders(actual.headers), rawHeaders(expected.headers), label + ': selected raw response headers');
      assert.equal(actual.base64, expected.base64, label + ': complete original or declared partial bytes');
    } else if (actual.status === 200 && generatedSrt) {
      assert.deepEqual(subtitleLayoutProjection(actual.text, 'srt'), subtitleLayoutProjection(expected.text, 'srt'), label + ': complete generated SRT lines');
    } else if (actual.status !== 200 || ['srt', 'ass', 'ssa', 'smi'].includes(action.format)) {
      assert.equal(actual.base64, expected.base64, label + ': original or persistent SRT bytes');
    } else if (action.format === 'json') assert.deepEqual(cueValue(actual.text), cueValue(expected.text), label + ': complete cue values and text');
    else assert.deepEqual(subtitleLayoutProjection(actual.text, action.format), subtitleLayoutProjection(expected.text, action.format), label + ': complete generated subtitle body');
  };
  const releasedLeases = async () => {
    for (const lease of report.bridgeLeases.filter(value => value.generation === generation)) {
      const response = await fetch(lease.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) }); await response.arrayBuffer();
      report.releasedLeases.push({ ...lease, status: response.status }); assert.equal(response.status, 404);
    }
  };
  subscribe(processChannel, observe);
  subscribe(bridgeChannel, observeBridge);
  try {
    resource = await acquireTestResource('native-media-5244', { signal: t.signal });
    report.testInput = await describeFile(fileURLToPath(import.meta.url));
    captured = await captureCurrentHttpSubtitles({ output: path.join(output, 'native'), signal: t.signal }); report.native = captured.report;
    report.nativePublicScope = captured.native.scope;
    await fs.mkdir(sourceRoot, { recursive: true }); await fs.mkdir(metadataRoot);
    const configuration = path.join(node, 'config'); await fs.mkdir(configuration);
    await writeConfigurationFile(path.join(configuration, 'system.xml'), 'server', { ...defaultConfiguration('server'), IsStartupWizardCompleted: true });
    await writeConfigurationFile(path.join(configuration, 'network.xml'), 'network', { ...defaultConfiguration('network'), InternalHttpPort: 0,
      LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true });
    const style = process.platform === 'win32' ? 'windows' : 'posix';
    storageDefinition = { instances: [{ id: 'source', type: 'http', config: {} }, { id: 'subtitle-cache', type: 'local', config: { root: metadataRoot, writable: true } },
      { id: 'unread-media', type: 'local', config: { root: sourceRoot, writable: false } }], mounts: [
      { path: '/http-subtitles', instanceId: 'source', capabilities: {} },
      { path: '/subtitle-cache', instanceId: 'subtitle-cache', capabilities: { create: true, replace: true, mkdir: true, delete: true } },
      { path: '/unread-media', instanceId: 'unread-media', capabilities: {} }], prefixes: [
      { identityRoot: 'http://127.0.0.1:5244/source', accessRoot: '/http-subtitles', style: 'uri', purpose: 'library', returnAccess: 'Retain each original HTTP subtitle identity and selected read-only source.' },
      { identityRoot: dataPath, accessRoot: '/subtitle-cache', style, purpose: 'metadata', returnAccess: 'Independent persistent subtitle cache owner.' },
      { identityRoot: sourceRoot, accessRoot: '/unread-media', style, purpose: 'library', returnAccess: 'Controlled File media descriptor only; no media bytes are claimed.' }] };
    await fs.writeFile(storageFile, json(storageDefinition), { flag: 'wx' });
    const imported = { name: 'native-http-cache-import', source: 'sami-bom', sourceTarget: '/source/native-cache.sami', mediaSourceId: 'f8a00000-0000-0000-0000-000000000100', streamIndex: 0, mediaProtocol: 'File' };
    const readonlyMiss = { ...imported, name: 'readonly-cache-miss', sourceTarget: '/source/readonly-miss.sami', mediaSourceId: 'f8a00000-0000-0000-0000-000000000101' };
    for (const definition of [...captured.input.cases, imported, readonlyMiss]) {
      const bytes = captured.input.sources.find(value => value.name === definition.source), filename = path.join(sourceRoot, definition.name + bytes.extension);
      await fs.writeFile(filename, Buffer.from(bytes.base64, 'base64'), { flag: 'wx' });
      samples.set(definition.name, { definition, source: bytes, filename, mode: 'online', changed: false });
    }
    source = createSubtitleHttpSource(samples); report.sourceRequests = source.receipts; report.sourceLifecycle = source.lifecycle; await source.start();
    database = await createPostgresTestDatabase(null, 'http_subtitles'); schema = database.schemaName; lastDatabase = database;
    report.postgresSchemas = [schema, database.controlSchema]; await create(); token = (await runtime.apiKeys.create('Current HTTP subtitles')).AccessToken;
    for (const definition of [...captured.input.cases, imported, readonlyMiss]) {
      const Id = definition.mediaSourceId.toUpperCase(), sample = samples.get(definition.name);
      const mediaPath = definition.mediaProtocol === 'Http' ? source.origin + '/unread-media/' + definition.name + '.mkv' : path.join(sourceRoot, 'unread-' + definition.name + '.mkv');
      await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video',
        Name: definition.name, SortName: definition.name, Path: mediaPath, IsFolder: false, RunTimeTicks: 120000000n }));
      await database.insert('MediaStreamInfos', probeStreamRow(Id, { Type: 'Subtitle', Index: definition.streamIndex, Codec: sample.source.codec,
        Language: 'eng', IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: source.origin + definition.sourceTarget }));
    }
    report.databaseRows = await database.rows('MediaStreamInfos');
    for (const definition of captured.input.profiles) {
      const stream = { Type: 'Subtitle', Index: 0, IsExternal: definition.external ?? true, SupportsExternalStream: true, IsTextSubtitleStream: true,
        Codec: definition.codec, Language: 'eng', Path: source.origin + '/profile-source.subtitle' };
      const mediaSource = { Id: 'f8a00000-0000-0000-0000-000000000099', Protocol: 'File', MediaStreams: [stream], Container: 'mkv' };
      const actual = subtitleProfile(mediaSource, stream, { SubtitleProfiles: [{ Method: definition.method, Format: definition.candidate, Container: 'mkv' }] }, 'mkv',
        { PlayMethod: definition.playMethod, CanExtractSubtitle: value => runtime.extraction.supportsSubtitle(mediaSource, value) });
      const expected = captured.native.profiles.find(value => value.name === definition.name).profile;
      report.profiles.push({ name: definition.name, input: definition, native: expected, node: actual });
      assert.deepEqual({ Format: actual.Format, Method: actual.Method }, { Format: expected.Format, Method: expected.Method }, definition.name + ': advertised delivery format and method');
    }
    for (const definition of captured.input.cases) {
      await source.start(); const sample = samples.get(definition.name), native = captured.native.cases.find(value => value.name === definition.name);
      const [actualSource] = await runtime.library.getMediaSources(definition.mediaSourceId);
      assert.equal(actualSource.Protocol, definition.mediaProtocol); assert.equal(actualSource.MediaStreams[0].Path, native.subtitlePath);
      for (const actionDefinition of definition.actions) {
        if (actionDefinition.cold) { await close(); await create(); }
        const expected = native.actions.find(value => value.name === actionDefinition.name), action = { generation, caseName: definition.name, ...actionDefinition, before: await snapshot(definition) };
        report.actions.push(action); const requestStart = source.receipts.length;
        assert.deepEqual(stateValue(action.before), stateValue(expected.before), definition.name + '/' + actionDefinition.name + ': durable bytes and source state before');
        switch (actionDefinition.op) {
          case 'source-mode': sample.mode = actionDefinition.mode; if (sample.mode === 'offline') await source.stop(); else await source.start(); break;
          case 'write-source': await source.write(sample, actionDefinition.revision); break;
          case 'seed-cache': {
            const cache = paths(definition); await runtime.fileSystem.mkdir(cache.directory, { recursive: true });
            if (Object.hasOwn(actionDefinition, 'cacheBase64')) await runtime.fileSystem.writeFile(cache.filename, Buffer.from(actionDefinition.cacheBase64, 'base64'));
            if (Object.hasOwn(actionDefinition, 'metaBase64')) await runtime.fileSystem.writeFile(cache.metadata, Buffer.from(actionDefinition.metaBase64, 'base64'));
            break;
          }
          case 'delete-meta': case 'delete-cache': {
            const cache = paths(definition); try { await runtime.fileSystem.unlink(actionDefinition.op === 'delete-meta' ? cache.metadata : cache.filename); }
            catch (error) { if (!['ENOENT', 'not-found'].includes(error.code)) throw error; } break;
          }
          case 'empty-cache': { const cache = paths(definition); await runtime.fileSystem.mkdir(cache.directory, { recursive: true }); await runtime.fileSystem.writeFile(cache.filename, Buffer.alloc(0)); break; }
          case 'raw': case 'format': {
            if (actionDefinition.cancelAt || actionDefinition.cancelAfterBytes || actionDefinition.clientDisconnectAfterRead) {
              gate = { caseName: definition.name, stage: actionDefinition.clientDisconnectAfterRead ? 'controller-disconnect' : actionDefinition.cancelAt ?? 'raw-response',
                publicId: definition.mediaSourceId.replaceAll('-', '').toLowerCase(), cancelAfterBytes: actionDefinition.cancelAfterBytes,
                entered: Promise.withResolvers(), release: Promise.withResolvers(), publicClosed: Promise.withResolvers(), ffmpegSpawned: false, bridgeRead: false };
              source.setGate(gate); cancellation = new AbortController();
              if (actionDefinition.cancelAt) {
                const [mediaSource] = await runtime.library.getMediaSources(definition.mediaSourceId), stream = mediaSource.MediaStreams.find(value => value.Type === 'Subtitle' && value.Index === definition.streamIndex);
                pending = runtime.extraction.subtitle(mediaSource, stream, runtime.playback.accessPath({ Id: mediaSource.Id }, stream.Path, false), { signal: AbortSignal.any([t.signal, cancellation.signal]) });
              } else pending = request(definition, actionDefinition, AbortSignal.any([t.signal, cancellation.signal]));
              void pending.catch(() => {});
              await Promise.race([gate.entered.promise, pending.then(() => { throw new Error('The real HTTP cancellation input was not reached.'); }),
                delay(10000, undefined, { ref: false, signal: t.signal }).then(() => { throw new Error('The real HTTP cancellation input did not arrive.'); })]);
              if (actionDefinition.cancelAfterBytes) { action.wire = await pending; compareWire(action.wire, expected.wire, actionDefinition, definition.name + '/' + actionDefinition.name, definition); }
              else if (actionDefinition.clientDisconnectAfterRead) {
                assert.equal(gate.ffmpegSpawned, true); assert.equal(gate.bridgeRead, true);
                cancellation.abort(); await assert.rejects(pending, error => { action.clientError = errorValue(error); return error.name === 'AbortError'; });
                action.publicDisconnect = await Promise.race([gate.publicClosed.promise,
                  delay(10000, undefined, { ref: false, signal: t.signal }).then(() => { throw new Error('The actual subtitle consumer did not close.'); })]);
                assert.equal(action.publicDisconnect.writableFinished, false);
                gate.release.resolve(); await runtime.playback.drainSubtitlePreparations();
                action.actualBridgeRequest = gate.actualBridgeRequest;
              }
              else {
                if (actionDefinition.cancelAt === 'ffmpeg') {
                  assert.equal(gate.ffmpegSpawned, true); assert.equal(gate.bridgeRead, true, 'A real text conversion child requested the owned bridge input.');
                  action.actualBridgeRequest = gate.actualBridgeRequest;
                }
                cancellation.abort(); await assert.rejects(pending, error => { action.componentError = errorValue(error); return error.code === 'cancelled'; });
                await close(); source.setGate(undefined); gate = undefined; await source.drain(requestStart); await create();
              }
              action.cancellation = { stage: actionDefinition.clientDisconnectAfterRead ? 'controller-disconnect' : actionDefinition.cancelAt ?? 'raw-response', triggered: true,
                boundary: actionDefinition.cancelAt ? 'Actual extraction caller token compared with Native ISubtitleEncoder caller token.'
                  : actionDefinition.clientDisconnectAfterRead ? 'Actual controller client disconnected after the real FFmpeg bridge read; producer input then released and actual preparation drained.' : 'Actual HTTP body prefix then client disconnect.' };
              assert.equal(expected.cancellation.triggered, true); source.setGate(undefined); gate = undefined; pending = undefined; cancellation = undefined;
            } else { action.wire = await request(definition, actionDefinition); compareWire(action.wire, expected.wire, actionDefinition, definition.name + '/' + actionDefinition.name, definition); }
            await releasedLeases(); break;
          }
          default: throw new Error('Undeclared HTTP subtitle action: ' + actionDefinition.op);
        }
        await source.drain(requestStart); action.sourceRequests = source.receipts.slice(requestStart); action.after = await snapshot(definition);
        assert.deepEqual(stateValue(action.after), stateValue(expected.after), definition.name + '/' + actionDefinition.name + ': complete durable source/cache/meta after');
        for (const receipt of action.sourceRequests) { assert.equal(receipt.finished, true); assert.equal(receipt.responseClosed, true); assert.equal(receipt.socketClosed, true);
          assert.equal(receipt.headers.authorization, undefined); assert.equal(receipt.headers.cookie, undefined); }
      }
    }
    const nativeCache = captured.native.cases.find(value => value.name === 'http-sami-cache-lifecycle').actions.find(value => value.name === 'warm-srt');
    const importedPaths = paths(imported); await runtime.fileSystem.mkdir(importedPaths.directory, { recursive: true });
    await runtime.fileSystem.writeFile(importedPaths.filename, Buffer.from(nativeCache.after.cache.base64, 'base64'));
    if (nativeCache.after.meta.exists) await runtime.fileSystem.writeFile(importedPaths.metadata, Buffer.from(nativeCache.after.meta.base64, 'base64'));
    await source.stop(); await close(); await create();
    const importedWire = await request(imported, { op: 'format', format: 'srt' });
    compareWire(importedWire, nativeCache.wire, { op: 'format', format: 'srt' }, 'Native persistent HTTP cache imported into cold offline Node');
    report.imports.push({ direction: 'Native-to-cold-Node', source: nativeCache.after.cache, wire: importedWire, state: await snapshot(imported) });
    const writable = runtime.storage.configuration(), readonly = structuredClone(writable);
    readonly.instances.find(value => value.id === 'subtitle-cache').config.writable = false;
    readonly.mounts.find(value => value.instanceId === 'subtitle-cache').capabilities = {}; await runtime.storage.configure(readonly);
    const hit = await request(imported, { op: 'format', format: 'srt' }), miss = await request(readonlyMiss, { op: 'format', format: 'srt' });
    compareWire(hit, nativeCache.wire, { op: 'format', format: 'srt' }, 'Read-only HTTP cache hit'); assert.equal(miss.status, 500);
    report.readonly = { hit, miss, retainedCache: await snapshot(imported), missingCache: await snapshot(readonlyMiss) };
    assert.equal(report.readonly.missingCache.cache.exists, false); await runtime.storage.configure(writable);
    assert.deepEqual(await database.rows('MediaStreamInfos'), report.databaseRows, 'All original subtitle URL/query rows remain persistent.');
    const handoffDefinition = captured.input.cases.find(value => value.name === 'http-sami-cache-lifecycle');
    const handoffState = await snapshot(handoffDefinition), handoffSrt = await request(handoffDefinition, { op: 'format', format: 'srt' }),
      handoffVtt = await request(handoffDefinition, { op: 'format', format: 'vtt' });
    assert.equal(handoffState.cache.exists, true);
    const handoffInput = { schemaVersion: 1, profiles: [], sources: captured.input.sources,
      cases: [{ ...handoffDefinition, name: 'node-generated-http-cache-native-reopen', actions: [
        { name: 'seed-node-assets', op: 'seed-cache', cacheBase64: handoffState.cache.base64,
          ...(handoffState.meta.exists ? { metaBase64: handoffState.meta.base64 } : {}) },
        { name: 'real-source-offline', op: 'source-mode', mode: 'offline' },
        { name: 'cold-native-srt', op: 'format', format: 'srt', cold: true },
        { name: 'cold-native-vtt', op: 'format', format: 'vtt', cold: true },
      ] }] };
    const handoffFile = path.join(output, 'node-to-native-input.json'); await fs.writeFile(handoffFile, json(handoffInput), { flag: 'wx' });
    await source.start();
    gate = { caseName: readonlyMiss.name, stage: 'ffmpeg', entered: Promise.withResolvers(), ffmpegSpawned: false, bridgeRead: false };
    source.setGate(gate); cancellation = new AbortController();
    const shutdownRequests = source.receipts.length;
    pending = request(readonlyMiss, { op: 'format', format: 'srt' }, AbortSignal.any([t.signal, cancellation.signal])); void pending.catch(() => {});
    await Promise.race([gate.entered.promise, pending.then(() => { throw new Error('The actual shutdown preparation was not held.'); }),
      delay(10000, undefined, { ref: false, signal: t.signal }).then(() => { throw new Error('The actual shutdown preparation did not reach its source.'); })]);
    assert.equal(gate.ffmpegSpawned, true); assert.equal(gate.bridgeRead, true);
    report.shutdown = { boundary: 'Node runtime shutdown of an admitted real public subtitle preparation; not a Native server-shutdown claim.', actualBridgeRequest: gate.actualBridgeRequest };
    await close();
    await assert.rejects(pending, error => { report.shutdown.clientError = errorValue(error); return error instanceof Error; });
    await source.drain(shutdownRequests); report.shutdown.sourceRequests = source.receipts.slice(shutdownRequests);
    assert.ok(report.shutdown.sourceRequests.every(value => value.finished && value.responseClosed && value.socketClosed));
    source.setGate(undefined); gate = undefined; pending = undefined; cancellation = undefined; await source.stop();
    const returned = await captureCurrentHttpSubtitles({ output: path.join(output, 'node-to-native'), inputFile: handoffFile, signal: t.signal });
    const returnedCase = returned.native.cases[0], returnedSrt = returnedCase.actions.find(value => value.name === 'cold-native-srt'), returnedVtt = returnedCase.actions.find(value => value.name === 'cold-native-vtt');
    compareWire(handoffSrt, returnedSrt.wire, { op: 'format', format: 'srt' }, 'Node-produced HTTP SRT asset consumed by cold offline Native');
    compareWire(handoffVtt, returnedVtt.wire, { op: 'format', format: 'vtt' }, 'Node-produced HTTP SRT asset converted by cold offline Native');
    assert.deepEqual(fileValue(returnedSrt.after.cache), fileValue(handoffState.cache)); assert.deepEqual(fileValue(returnedSrt.after.meta), fileValue(handoffState.meta));
    assert.equal(returnedSrt.after.sourceOnline, false); assert.equal(returnedVtt.after.sourceOnline, false);
    report.imports.push({ direction: 'Node-to-cold-Native', report: returned.report, input: await describeFile(handoffFile),
      node: { state: handoffState, srt: handoffSrt, vtt: handoffVtt }, native: returnedCase });
    for (const command of report.mediaCommands.filter(value => value.arguments.includes('-c:s'))) {
      assert.equal(command.arguments[command.arguments.indexOf('-c:s') + 1], 'srt');
      assert.ok(command.arguments.includes('-an') && command.arguments.includes('-vn') && command.arguments.includes('-dn'));
      assert.equal(command.arguments.some(value => /^-(?:c:[av]|vf|af|filter|hwaccel)/u.test(value)), false);
      const input = command.arguments[command.arguments.indexOf('-i') + 1]; assert.ok(report.bridgeLeases.some(lease => lease.url === input), 'The actual text tool receives its own recorded VFS bridge lease.');
      await assert.rejects(fs.stat(command.arguments.at(-1)), { code: 'ENOENT' });
    }
    report.componentAcceptance = true;
  } catch (error) { fail(error); }
  finally {
    cancellation?.abort(); gate?.release?.resolve();
    try { await close(); } catch (error) { fail(error); }
    if (pending) await pending.catch(() => {});
    try { await source?.stop(); report.cleanup.push({ sourceClosed: true }); } catch (error) { fail(error); }
    unsubscribe(processChannel, observe);
    unsubscribe(bridgeChannel, observeBridge);
    if (database ?? lastDatabase) try { await dropPostgresTestDatabase(database ?? lastDatabase); report.cleanup.push({ postgresSchemasRemoved: true }); } catch (error) { fail(error); }
    if (resource) try { await resource.release(); report.cleanup.push({ resourceReleased: true }); } catch (error) { fail(error); }
    if (failures.length) report.componentAcceptance = false;
    try { await fs.writeFile(path.join(output, 'node-report.json'), filterEvidenceJson(report, new Set([token, postgresTestConnectionString].filter(Boolean))), { flag: 'wx' }); }
    catch (error) { throw new AggregateError([...failures, error], 'HTTP subtitle execution or report persistence failed.', { cause: failures[0] ?? error }); }
  }
  if (failures.length) throw new AggregateError(failures, 'Current HTTP subtitle consumer or resource closure failed.', { cause: failures[0] });
});
