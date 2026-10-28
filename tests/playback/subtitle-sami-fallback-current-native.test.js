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
import { VirtualFileSystem } from '../../src/storage/index.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { subtitleSourceFingerprint } from '../../src/playback/subtitle-cache.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { subtitleLayoutProjection } from './layout-projection.js';
import { captureCurrentSamiFallback, hash, json, errorValue } from './fixtures/subtitle-sami-fallback-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL && postgresTestConnectionString);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const fileValue = value => value.exists ? { exists: true, bytes: value.bytes, base64: value.base64, sha256: value.sha256 } : { exists: false };
const stateValue = value => ({ source: { ...fileValue(value.source), ...(value.source.exists ? { modifiedTicks: value.source.modifiedTicks } : {}) },
  cache: fileValue(value.cache), meta: fileValue(value.meta) });
const cueValue = text => {
  const value = parseLosslessJson(text);
  return { ...value, TrackEvents: value.TrackEvents.map(cue => ({ ...cue, Text: cue.Text.split(/\r\n|\r|\n/u) })) };
};
test('current Native File SAMI fallback consumes real FFmpeg SRT, independent metadata cache and public warm/cold PostgreSQL HTTP', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'subtitle-sami-fallback-current-' + randomUUID()); await fs.mkdir(output);
  const report = { schemaVersion: 1, scope: 'Actual Native .sami fallback compared with File-identity Node PostgreSQL/VFS/HTTP, persistent SRT/meta and extraction caller-token cancellation. Native HTTP identity observations remain independent. Controlled source descriptors do not establish normal discovery.',
    actions: [], imports: [], readers: [], leases: [], leaseRequestsAfterRelease: [], mediaCommands: [], diagnostics: [], cleanup: [], failures: [],
    componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  const failures = [], failure = error => { failures.push(error); report.failures.push(errorValue(error)); };
  const processChannel = 'tracing:child_process.spawn:start';
  let resource, captured, database, lastDatabase, runtime, origin, token, generation = 0, schema, gate, cancellation, pending, storageDefinition;
  const toolPaths = { ffmpeg: validationExecutable('ffmpeg'), ffprobe: validationExecutable('ffprobe') };
  const observe = ({ process: child }) => {
    const tool = Object.keys(toolPaths).find(name => toolPaths[name] === child.spawnfile); if (!tool) return;
    const observation = { generation, tool, executable: child.spawnfile, arguments: child.spawnargs.slice(1), spawned: false, closed: false, errors: [] };
    report.mediaCommands.push(observation);
    child.once('spawn', () => Object.assign(observation, { pid: child.pid, spawned: true }));
    child.once('error', error => observation.errors.push(errorValue(error)));
    child.once('close', (exitCode, signal) => Object.assign(observation, { closed: true, exitCode, signal }));
  };
  const node = path.join(output, 'node'), sourceRoot = path.join(node, 'media'), cacheRoot = path.join(node, 'metadata');
  const dataPath = path.join(node, 'data', 'data'), configurationFile = path.join(node, 'storage.json');
  const sources = new Map();
  const openRead = VirtualFileSystem.prototype.openRead;
  const conversions = () => report.mediaCommands.filter(row => row.arguments.includes('-c:s'));
  const close = async () => {
    gate?.release.resolve(); gate = undefined;
    if (!runtime) return;
    const current = runtime; runtime = undefined;
    try {
      await current.close();
      const listenersClosed = current.networkHost.listeners.every(listener => !listener.server.listening);
      report.cleanup.push({ generation, runtimeClosed: true, listenersClosed, databaseClosed: database.closed });
      assert.ok(listenersClosed); assert.equal(database.closed, true);
      assert.ok(report.readers.filter(row => row.generation === generation).every(row => row.closed), 'Every actual media reader drained before storage close.');
      assert.ok(report.mediaCommands.filter(row => row.generation === generation).every(row => row.closed && (!row.pid || !alive(row.pid))), 'Every actual media tool exited before runtime close returned.');
    } finally { lastDatabase = database; database = undefined; }
  };
  const instrumentMedia = () => {
    // Observe the public VFS operation; plugin and configuration proxies retain
    // their borrowed methods when unrelated properties are assigned to them.
    VirtualFileSystem.prototype.openRead = async function (location, options = {}) {
      const handle = await openRead.call(this, location, options);
      if (!location.startsWith('/media/')) return handle;
      const selected = Object.hasOwn(options, 'ifRange') ? gate : undefined;
      const observation = { generation, location, bridgeRead: Object.hasOwn(options, 'ifRange'), closed: false, yieldedBytes: 0 };
      report.readers.push(observation);
      return { ...handle, stream: (async function* () {
        if (selected) {
          const stopped = Promise.withResolvers(), stop = () => stopped.reject(options.signal.reason);
          options.signal?.addEventListener('abort', stop, { once: true });
          try {
            options.signal?.throwIfAborted(); selected.entered.resolve();
            await Promise.race([selected.release.promise, stopped.promise]); options.signal?.throwIfAborted();
          } finally { options.signal?.removeEventListener('abort', stop); }
        }
        for await (const chunk of handle.stream) { observation.yieldedBytes += chunk.length; yield chunk; }
      })(), async close() {
        try { await handle.close(); observation.closed = true; }
        catch (error) { observation.closeError = errorValue(error); throw error; }
        finally { selected?.closed.resolve(); }
      } };
    };
  };
  const create = async () => {
    generation++;
    database ??= await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema });
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(node), storageConfiguration: configurationFile,
      mediaEncoderOptions: { startupFFmpegPath: toolPaths.ffmpeg }, autoDiscoveryOptions: { enabled: false },
      onError: (error, context) => report.diagnostics.push({ generation, route: context?.request?.url, phase: context?.phase, error: errorValue(error) }) });
    instrumentMedia();
    const bridge = runtime.extraction.bridge, lease = bridge.lease.bind(bridge);
    bridge.lease = async (...arguments_) => {
      const result = await lease(...arguments_); report.leases.push({ generation, path: arguments_[0], url: result.url }); return result;
    };
    await runtime.start(); origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(row => row.scheme === 'http').port;
    if (report.databaseRows) assert.deepEqual(await database.rows('MediaStreamInfos'), report.databaseRows, 'Cold PostgreSQL reopens retain the actual source descriptors.');
  };
  const file = async (filename, metadata = false) => {
    let info, bytes;
    try {
      info = metadata ? await runtime.fileSystem.stat(filename, { bigint: true }) : await fs.stat(filename, { bigint: true });
      bytes = metadata ? await runtime.fileSystem.readFile(filename) : await fs.readFile(filename);
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { exists: false }; throw error; }
    return { exists: true, filename, bytes: bytes.length, base64: bytes.toString('base64'), sha256: hash(bytes),
      text: bytes.toString('utf8'), modifiedTicks: String(info.mtimeNs / 100n + 621355968000000000n) };
  };
  const paths = sample => runtime.extraction.subtitleCache.paths(sample.mediaSourceId, sample.streamIndex);
  const snapshot = async sample => {
    const cache = paths(sample);
    return { source: await file(sources.get(sample.name).filename), cache: await file(cache.filename, true), meta: await file(cache.metadata, true) };
  };
  const request = async (sample, format, signal = t.signal) => {
    const id = sample.mediaSourceId.replaceAll('-', '').toLowerCase();
    const route = `/Videos/${id}/${id}/Subtitles/${sample.streamIndex}/Stream.${format}?startPositionTicks=0&endPositionTicks=0&copyTimestamps=true`;
    const response = await fetch(origin + route, { signal, headers: { Authorization: `MediaBrowser Token="${token}"` } }), bytes = Buffer.from(await response.arrayBuffer());
    const contentLength = response.headers.get('content-length'); if (contentLength !== null) assert.equal(Number(contentLength), bytes.length);
    return { route, status: response.status, contentType: response.headers.get('content-type'), base64: bytes.toString('base64'), bytes: bytes.length, sha256: hash(bytes), text: bytes.toString('utf8') };
  };
  const releasedLeases = async () => {
    for (const lease of report.leases.filter(row => row.generation === generation)) {
      const response = await fetch(lease.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) }); await response.arrayBuffer();
      report.leaseRequestsAfterRelease.push({ generation, url: lease.url, status: response.status }); assert.equal(response.status, 404);
    }
  };
  const compareWire = (actual, expected, format, label) => {
    assert.equal(actual.status, expected.status, label + ': actual public status');
    assert.equal(actual.contentType, expected.contentType, label + ': actual public MIME');
    if (actual.status !== 200 || format === 'srt') assert.equal(actual.base64, expected.base64, label + ': actual delivered bytes');
    else if (format === 'json') assert.deepEqual(cueValue(actual.text), cueValue(expected.text), label + ': every cue, timing and text');
    else assert.deepEqual(subtitleLayoutProjection(actual.text, format), subtitleLayoutProjection(expected.text, format), label + ': complete subtitle body');
  };
  subscribe(processChannel, observe);
  try {
    resource = await acquireTestResource('native-media-5244', { signal: t.signal });
    report.testInput = await describeFile(fileURLToPath(import.meta.url));
    captured = await captureCurrentSamiFallback({ output: path.join(output, 'native'), signal: t.signal }); report.native = captured.report;
    const input = captured.input, samples = input.cases.filter(sample => sample.protocol === 'File');
    await fs.mkdir(sourceRoot, { recursive: true }); await fs.mkdir(cacheRoot); const config = path.join(node, 'config'); await fs.mkdir(config);
    await writeConfigurationFile(path.join(config, 'system.xml'), 'server', { ...defaultConfiguration('server'), IsStartupWizardCompleted: true });
    await writeConfigurationFile(path.join(config, 'network.xml'), 'network', { ...defaultConfiguration('network'), InternalHttpPort: 0,
      LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true });
    const style = process.platform === 'win32' ? 'windows' : 'posix';
    storageDefinition = { instances: [{ id: 'media', type: 'local', config: { root: sourceRoot, writable: false } },
      { id: 'subtitle-cache', type: 'local', config: { root: cacheRoot, writable: true } }], mounts: [
      { path: '/media', instanceId: 'media', capabilities: {} },
      { path: '/subtitle-cache', instanceId: 'subtitle-cache', capabilities: { create: true, replace: true, mkdir: true, delete: true } }],
    prefixes: [{ identityRoot: sourceRoot, accessRoot: '/media', style, purpose: 'library', returnAccess: 'Exact declared File-identity subtitle source.' },
      { identityRoot: dataPath, accessRoot: '/subtitle-cache', style, purpose: 'metadata', returnAccess: 'Independent persistent metadata owner.' }] };
    await fs.writeFile(configurationFile, json(storageDefinition), { flag: 'wx' });
    const imported = { name: 'native-cache-import', source: 'utf8-bom', extension: '.sami', streamIndex: 0,
      mediaSourceId: 'f8900000-0000-0000-0000-000000000100', protocol: 'File' };
    const preflight = { ...imported, name: 'readonly-cache-miss', mediaSourceId: 'f8900000-0000-0000-0000-000000000101' };
    for (const sample of [...samples, imported, preflight]) {
      const source = input.sources.find(row => row.name === sample.source), filename = path.join(sourceRoot, sample.name + sample.extension);
      await fs.writeFile(filename, Buffer.from(source.base64, 'base64'), { flag: 'wx' }); await fs.utimes(filename, new Date(input.modifiedUtc), new Date(input.modifiedUtc));
      sources.set(sample.name, { filename, source });
    }
    database = await createPostgresTestDatabase(null, 'sami_fallback'); schema = database.schemaName; lastDatabase = database;
    report.postgresSchemas = [schema, database.controlSchema]; await create(); token = (await runtime.apiKeys.create('Current SAMI fallback')).AccessToken;
    for (const sample of [...samples, imported, preflight]) {
      const Id = sample.mediaSourceId.toUpperCase(), source = sources.get(sample.name);
      await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video',
        Name: sample.name, SortName: sample.name, Path: source.filename, IsFolder: false, RunTimeTicks: 120000000n }));
      await database.insert('MediaStreamInfos', probeStreamRow(Id, { Type: 'Subtitle', Index: sample.streamIndex, Codec: 'sami', Language: 'eng',
        IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: source.filename }));
    }
    report.databaseRows = await database.rows('MediaStreamInfos');
    const first = samples[0], cache = paths(first), sourceAccess = runtime.extraction.vfs.resolve('/media/' + path.basename(sources.get(first.name).filename));
    assert.equal(sourceAccess.capabilities.create, false); assert.equal(runtime.fileSystem.resolve(cache.filename).capabilities.create, true);
    for (const sample of samples) {
      const native = captured.native.cases.find(row => row.name === sample.name), source = sources.get(sample.name);
      for (const definition of sample.actions) {
        if (definition.cold) { await close(); await create(); }
        const expected = native.actions.find(row => row.name === definition.name), action = { generation, caseName: sample.name, ...definition,
          before: await snapshot(sample) }; report.actions.push(action);
        assert.deepEqual(stateValue(action.before), stateValue(expected.before), sample.name + '/' + definition.name + ': actual source/cache/meta before');
        const beforeProcesses = conversions().length;
        switch (definition.op) {
          case 'write-source': await fs.writeFile(source.filename, Buffer.from(source.source.changedBase64, 'base64'));
            await fs.utimes(source.filename, new Date(input.changedModifiedUtc), new Date(input.changedModifiedUtc)); break;
          case 'delete-source': await fs.unlink(source.filename); break;
          case 'delete-meta': await runtime.fileSystem.unlink(paths(sample).metadata); break;
          case 'empty-cache': await runtime.fileSystem.writeFile(paths(sample).filename, Buffer.alloc(0)); break;
          case 'delete-cache': await runtime.fileSystem.unlink(paths(sample).filename); break;
          case 'request':
            if (definition.cancelAfterRead) {
              gate = { entered: Promise.withResolvers(), release: Promise.withResolvers(), closed: Promise.withResolvers() };
              const item = await runtime.library.getItemRecord(sample.mediaSourceId);
              const selected = (await runtime.library.getMediaSources(item.Id)).find(row => row.Id.replaceAll('-', '').toLowerCase() === sample.mediaSourceId.replaceAll('-', '').toLowerCase());
              assert.ok(selected, 'The caller selects the actual PostgreSQL media source.');
              const track = selected.MediaStreams.find(row => row.Type === 'Subtitle' && row.Index === sample.streamIndex);
              assert.ok(track, 'The caller selects the actual persisted subtitle stream.');
              const accessPath = runtime.playback.accessPath(item, track.Path, false);
              cancellation = new AbortController();
              pending = runtime.extraction.subtitle(selected, track, accessPath, { signal: AbortSignal.any([t.signal, cancellation.signal]) }); pending.catch(() => {});
              await Promise.race([gate.entered.promise, delay(10000, undefined, { ref: false }).then(() => { throw new Error('The actual FFmpeg VFS read was not reached.'); })]);
              assert.ok(conversions().slice(beforeProcesses).some(row => row.spawned), 'Cancellation follows an actual FFmpeg spawn and source read.');
              const reason = Object.assign(new Error('The subtitle caller cancelled after its actual source read.'), { code: 'subtitle-caller-cancelled' });
              action.callerReason = errorValue(reason); cancellation.abort(reason);
              await assert.rejects(pending, error => {
                action.callerCancellation = errorValue(error);
                return error.code === 'cancelled' && error.cause?.code === reason.code && error.cause?.message === reason.message;
              });
              await runtime.extraction.close(); await gate.closed.promise; gate = undefined;
              action.cancelledAfterActualRead = true; action.transport = 'Actual extraction caller token, matching the Native encoder component token; public controller disconnect is a separate consumer.';
              assert.equal(expected.cancellation.triggered, true);
            } else {
              const diagnosticsBefore = report.diagnostics.length;
              action.wire = await request(sample, definition.format); compareWire(action.wire, expected.wire, definition.format, sample.name + '/' + definition.name);
              action.errors = report.diagnostics.slice(diagnosticsBefore).filter(row => row.generation === generation && row.route === action.wire.route);
              if (action.wire.status >= 400) assert.ok(action.errors.some(row => (row.error?.status ?? row.error?.statusCode) === action.wire.status), 'A public failure is associated with its actual subtitle operation.');
            }
            await releasedLeases();
            const nativeProduced = expected.traceFiles.some(filename => captured.native.traces.find(trace => trace.filename === filename)?.value.arguments?.includes('-c:s'));
            action.actualConversionProcesses = conversions().length - beforeProcesses;
            assert.equal(action.actualConversionProcesses > 0, nativeProduced, sample.name + '/' + definition.name + ': actual conversion or persistent cache reuse');
            break;
          default: throw new Error('Undeclared SAMI fallback action: ' + definition.op);
        }
        action.after = await snapshot(sample);
        assert.deepEqual(stateValue(action.after), stateValue(expected.after), sample.name + '/' + definition.name + ': actual durable source/cache/meta after');
        if (action.wire && action.after.source.exists && action.after.meta.exists && action.after.cache.bytes > 0)
          assert.equal(action.after.meta.text, `${action.after.source.bytes}:${action.after.source.modifiedTicks}`, 'Persistent size:100ns-mtime is the exchange contract.');
      }
    }
    const nativeCache = captured.native.cases.find(row => row.name === first.name).actions.find(row => row.name === 'warm-srt');
    const importedPaths = paths(imported); await runtime.fileSystem.mkdir(importedPaths.directory, { recursive: true });
    await runtime.fileSystem.writeFile(importedPaths.filename, Buffer.from(nativeCache.after.cache.base64, 'base64'));
    await runtime.fileSystem.writeFile(importedPaths.metadata, Buffer.from(nativeCache.after.meta.base64, 'base64'));
    await close(); await create(); const count = conversions().length;
    const nativeImport = await request(imported, 'srt'); report.imports.push({ kind: 'Native-to-cold-Node-cache', wire: nativeImport, state: await snapshot(imported) });
    compareWire(nativeImport, nativeCache.wire, 'srt', 'Native persistent cache import'); assert.equal(conversions().length, count);
    const writable = runtime.storage.configuration(), readonly = structuredClone(writable); readonly.instances.find(row => row.id === 'subtitle-cache').config.writable = false;
    readonly.mounts.find(row => row.instanceId === 'subtitle-cache').capabilities = {}; await runtime.storage.configure(readonly); instrumentMedia();
    const readonlyHit = await request(imported, 'srt'); compareWire(readonlyHit, nativeCache.wire, 'srt', 'Read-only persisted cache');
    const beforeReaders = report.readers.length, readonlyMiss = await request(preflight, 'srt');
    report.readonly = { hit: readonlyHit, miss: readonlyMiss, mediaReadsBefore: beforeReaders, mediaReadsAfter: report.readers.length };
    assert.equal(readonlyMiss.status, 500); assert.equal(report.readers.length, beforeReaders); assert.equal(conversions().length, count);
    const sourceInfo = await runtime.extraction.vfs.stat('/media/' + path.basename(sources.get(imported.name).filename));
    assert.equal(subtitleSourceFingerprint(sourceInfo), nativeCache.after.meta.text, 'Actual source stat recreates the Native persistent stamp.');
    await runtime.storage.configure(writable); instrumentMedia(); await releasedLeases();
    for (const command of conversions()) {
      const args = command.arguments;
      assert.equal(args[args.indexOf('-c:s') + 1], 'srt'); assert.ok(args.includes('-an') && args.includes('-vn') && args.includes('-dn'));
      assert.equal(args.some(value => /^-(?:c:[av]|vf|af|filter|hwaccel)/u.test(value)), false, 'Only the retained subtitle-text conversion reaches FFmpeg.');
      await assert.rejects(fs.stat(args.at(-1)), { code: 'ENOENT' });
      report.cleanup.push({ generation: command.generation, removedTextOutput: args.at(-1) });
    }
    report.sourceAfter = await Promise.all([...sources].map(async ([name, source]) => ({ name, file: await file(source.filename) })));
    for (const sample of samples) assert.deepEqual(fileValue(report.sourceAfter.find(row => row.name === sample.name).file),
      fileValue(captured.native.cases.find(row => row.name === sample.name).actions.at(-1).after.source), sample.name + ': source input bytes remain unchanged except declared writes/deletes');
    report.componentAcceptance = true;
  } catch (error) { failure(error); }
  finally {
    cancellation?.abort(); gate?.release.resolve();
    if (pending) await pending.catch(() => {});
    try { await close(); } catch (error) { failure(error); }
    VirtualFileSystem.prototype.openRead = openRead;
    unsubscribe(processChannel, observe);
    if (database ?? lastDatabase) try { await dropPostgresTestDatabase(database ?? lastDatabase); report.cleanup.push({ postgresSchemasRemoved: true }); } catch (error) { failure(error); }
    if (resource) try { await resource.release(); report.cleanup.push({ resourceReleased: true }); } catch (error) { failure(error); }
    if (failures.length) report.componentAcceptance = false;
    try { await fs.writeFile(path.join(output, 'node-report.json'), filterEvidenceJson(report, new Set([token, postgresTestConnectionString].filter(Boolean))), { flag: 'wx' }); }
    catch (error) { throw new AggregateError([...failures, error], 'SAMI fallback execution or report persistence failed.', { cause: failures[0] ?? error }); }
  }
  if (failures.length) throw new AggregateError(failures, 'Current SAMI fallback or resource closure failed.', { cause: failures[0] });
});
