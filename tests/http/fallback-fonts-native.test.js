import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { request } from 'node:http';
import { MIMEType } from 'node:util';
import { setImmediate as immediate } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { FallbackFonts } from '../../src/playback/fallback-fonts.js';
import { createTestApplication } from '../helpers/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { Localization } from '../../src/core/i18n.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { cloneNativeValue, parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, StorageError } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { fallbackFontFiles, fallbackFontInput } from './fixtures/fallback-fonts/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const nativeEnabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const hash = value => createHash('sha256').update(value).digest('hex');
const userId = 'f81b0000000000000000000000000001';
const cultures = ['en-US', 'sv-SE', 'tr-TR'];
const physicalHeaders = ['content-type', 'content-length', 'last-modified', 'etag', 'cache-control', 'pragma',
  'accept-ranges', 'content-range', 'content-disposition', 'vary', 'allow'];
const errorJson = (_key, value) => value instanceof Error
  ? { name: value.name, message: value.message, stack: value.stack, code: value.code, status: value.status, statusCode: value.statusCode,
    ...Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]])) }
  : typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value;
const errorValue = error => JSON.parse(JSON.stringify(error, errorJson));
const resolveRoot = (directory, value) => value === null || value === '' ? value : path.join(directory, value);
const options = root => ({ ...defaultConfiguration('encoding'), FallbackFontPath: root,
  EnableFallbackFont: true, SubtitleExtractionTimeoutMinutes: 31 });

async function seedFiles(directory, files = fallbackFontFiles) {
  await mkdir(directory, { recursive: true });
  for (const entry of files) {
    const filename = path.join(directory, entry.path); await mkdir(path.dirname(filename), { recursive: true });
    const file = await open(filename, 'wx');
    try { if (entry.length !== undefined) await file.truncate(entry.length); else await file.writeFile(Buffer.from(entry.bytes, 'base64')); }
    finally { await file.close(); }
    await utimes(filename, new Date('2024-06-02T12:34:56Z'), new Date('2024-06-02T12:34:56Z'));
  }
}

async function localFiles(directory) {
  const registry = new StorageRegistry(); registry.registerType('font-fixture', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('fonts', 'font-fixture', { root: directory, writable: false });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/fonts', instanceId: 'fonts', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: directory, accessRoot: '/fonts',
    style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
    returnAccess: 'These isolated fallback-font bytes remain available in the CI artifact.' });
  return { registry, fileSystem: new StorageFileSystem({ vfs, identityMap }) };
}

async function host(fallbackFonts, localization, diagnostics = []) {
  const user = { Id: userId, Policy: { IsAdministrator: false, EnableRemoteAccess: true }, AccessSchedules: [] };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'fallback-fonts', isLocalNetwork: () => true });
  authentication.authenticate = async request => {
    const identity = request.headers['x-identity'] ?? 'admin';
    return { IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey',
      IsAdministrator: !['anonymous', 'regular'].includes(identity), UserId: userId, User: user };
  };
  const application = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
    authentication, localization, fallbackFonts, onError: error => diagnostics.push(error) });
  await new Promise((resolve, reject) => {
    application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => {
      application.server.off('error', reject); resolve();
    });
  });
  return { ...application, origin: 'http://127.0.0.1:' + application.server.address().port };
}
async function closeHost(application) {
  application?.beginClose(); await application?.drainRequests();
  if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
}

async function observe(origin, sample) {
  const response = await fetch(origin + sample.path, { method: sample.method,
    headers: { Accept: sample.accept ?? 'application/json', 'X-Identity': sample.identity ?? 'admin', ...sample.headers } });
  const bytes = Buffer.from(await response.arrayBuffer()), headers = Object.fromEntries(response.headers);
  let json = null;
  if (headers['content-type']?.startsWith('application/json')) json = parseLosslessJson(bytes.toString());
  if (headers['content-length'] !== undefined && sample.method !== 'HEAD' && response.status !== 304) {
    assert.equal(BigInt(bytes.length), BigInt(headers['content-length']), 'Declared response length matches the complete body.');
  }
  return { name: sample.name, status: response.status, headers, bodyBase64: bytes.toString('base64'), json };
}
async function observeCancellation(application, sample) {
  const value = await new Promise((resolve, reject) => {
    let received = false;
    const client = request(application.origin + sample.path, { method: sample.method,
      headers: { Accept: sample.accept ?? 'application/json', 'X-Identity': sample.identity ?? 'admin', ...sample.headers } }, response => {
      const chunks = []; let length = 0;
      response.on('error', error => { if (!received) reject(error); });
      response.on('data', chunk => {
        chunks.push(chunk); length += chunk.length;
        if (length < 1024 || received) return;
        received = true;
        const value = { name: sample.name, status: response.statusCode, headers: response.headers, partial: true,
          bodyBase64: Buffer.concat(chunks).subarray(0, 1024).toString('base64'), json: null };
        response.destroy(); client.destroy(); resolve(value);
      });
      response.once('end', () => { if (!received) reject(new Error('The physical font ended before its cancellation prefix.')); });
    });
    client.on('error', error => { if (!received) reject(error); }); client.end();
  });
  await application.drainRequests(); return value;
}
function wire(value) {
  const headers = Object.fromEntries(physicalHeaders.map(name => [name, value.headers[name] ?? null]));
  if (headers['content-type']) {
    const type = new MIMEType(headers['content-type']);
    headers['content-type'] = { essence: type.essence, params: Object.fromEntries(type.params) };
  }
  // JSON escape and optional-length representation may differ; every DTO field
  // and each candidate's actual Content-Length are checked independently.
  if (value.json !== null) delete headers['content-length'];
  return { status: value.status, headers, ...(value.json === null ? { bodyBase64: value.bodyBase64 } : { json: value.json }) };
}

test('fallback fonts match the actual SubtitleController, file executor, configuration aliases and storage bytes', {
  skip: !nativeEnabled, timeout: 300000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'fallback-fonts-' + randomUUID()), directory = path.join(output, 'files');
  await mkdir(output, { recursive: true }); await seedFiles(directory);
  const input = fallbackFontInput(), inputBytes = Buffer.from(JSON.stringify(input)), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { scope: 'Actual authorized MVC controller, encoding store, ManagedFileSystem and PhysicalFile result versus mapped plugin files.',
    inputSha256: hash(inputBytes), fileInputs: [], comparisons: [], differences: [], cleanup: {},
    componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    excluded: ['font parsing and rendering', 'media generation', 'unmapped or relative host-path access', 'server Date and transport connection headers'] };
  let registry, fallbackFonts, application, failure;
  const diagnostics = [];
  try {
    for (const entry of fallbackFontFiles) report.fileInputs.push(await describeFile(path.join(directory, entry.path)));
    const build = await verifyNativeBuild();
    report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    report.sourceBindings = [];
    for (const relative of ['Jellyfin.Api/Controllers/SubtitleController.cs', 'MediaBrowser.Model/Subtitles/FontFile.cs',
      'MediaBrowser.Model/Configuration/EncodingOptions.cs', 'MediaBrowser.Model/Net/MimeTypes.cs',
      'MediaBrowser.MediaEncoding/Configuration/EncodingConfigurationFactory.cs', 'MediaBrowser.MediaEncoding/Configuration/EncodingConfigurationStore.cs',
      'MediaBrowser.Common/Configuration/EncodingConfigurationExtensions.cs', 'Emby.Server.Implementations/AppBase/BaseConfigurationManager.cs',
      'Emby.Server.Implementations/Configuration/ServerConfigurationManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
      'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs',
      'src/Jellyfin.Extensions/Json/Converters/JsonDateTimeConverter.cs', 'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
      'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']) {
      const expected = manifest.files.find(value => value.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.available, true, relative); assert.equal(source.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, source });
    }
    report.oracle = await recordOracle({ project: 'tests/http/fixtures/fallback-fonts/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, output, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(report.oracle.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const name of ['actualMvc', 'actualSubtitleController', 'actualServerConfigurationManager', 'actualEncodingFactory',
      'actualManagedFileSystem', 'actualPhysicalFileExecutor', 'actualDefaultAuthorization', 'actualExceptionMiddleware', 'hostStopped', 'hostDisposed']) {
      assert.equal(native[name], true, name);
    }
    for (const assembly of native.assemblies) {
      assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
      assert.equal(hash(await readFile(path.join(build.runtime, path.basename(assembly.filename)))), assembly.sha256);
    }
    report.frameworkAssemblies = native.frameworkAssemblies;
    for (const assembly of native.frameworkAssemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    report.nativeDiagnostics = native.diagnostics;
    assert.deepEqual(native.diagnostics, [], 'Native success, cancellation, background and close errors remain unclassified failures.');
    report.nativeFileInputs = native.fileInputs;
    assert.equal(native.fileInputs.length, report.fileInputs.length, 'The native host records the complete prepared file input.');
    for (const input of report.fileInputs) {
      const actual = native.fileInputs.find(value => path.resolve(value.filename) === path.resolve(input.filename));
      assert.ok(actual, input.filename); assert.equal(actual.sha256, input.sha256, input.filename); assert.equal(actual.size, input.bytes, input.filename);
    }
    const storage = await localFiles(directory); registry = storage.registry;
    const localization = new Localization({ supportedCultures: cultures });
    let current;
    fallbackFonts = new FallbackFonts({ fileSystem: storage.fileSystem, getEncodingOptions: () => current, localization });
    application = await host(fallbackFonts, localization, diagnostics);
    const compare = (name, actual, expected) => {
      try { assert.deepEqual(actual, expected, name); }
      catch (error) { report.differences.push({ name, actual, expected, error: errorValue(error) }); }
    };
    assert.equal(native.observations.length, input.length);
    for (const [caseIndex, sample] of input.entries()) {
      current = options(resolveRoot(directory, sample.root)); const held = current;
      const configFile = path.join(output, 'node-configuration', sample.name, 'encoding.xml');
      await mkdir(path.dirname(configFile), { recursive: true }); await writeConfigurationFile(configFile, 'encoding', current);
      const expectedCase = native.observations[caseIndex]; assert.equal(expectedCase.name, sample.name);
      compare(sample.name + ': complete initial encoding', cloneNativeValue(current), expectedCase.initial);
      for (const [index, step] of sample.steps.entries()) {
        if (Object.hasOwn(step, 'replaceRoot')) { current = options(resolveRoot(directory, step.replaceRoot)); await writeConfigurationFile(configFile, 'encoding', current); }
        if (Object.hasOwn(step, 'mutateHeldRoot')) held.FallbackFontPath = resolveRoot(directory, step.mutateHeldRoot);
        if (Object.hasOwn(step, 'mutateCurrentRoot')) current.FallbackFontPath = resolveRoot(directory, step.mutateCurrentRoot);
        const before = await readFile(configFile);
        const actual = { ...await (step.cancelAfterFirstRead ? observeCancellation(application, step) : observe(application.origin, step)),
          current: cloneNativeValue(current), held: cloneNativeValue(held),
          disk: parseConfigurationXml(await readFile(configFile), 'encoding'), diskBeforeBase64: before.toString('base64'),
          diskAfterBase64: (await readFile(configFile)).toString('base64'), diagnostics: diagnostics.map(errorValue) };
        const expected = expectedCase.steps[index]; assert.equal(expected.name, step.name);
        const name = sample.name + '/' + step.name;
        compare(name + ': complete wire values and physical headers', wire(actual), wire(expected));
        for (const key of ['current', 'held', 'disk']) compare(name + ': complete ' + key, actual[key], expected[key]);
        assert.equal(actual.diskAfterBase64, actual.diskBeforeBase64, name + ': the font request did not save encoding.xml.');
        assert.equal(expected.diskAfterBase64, expected.diskBeforeBase64, name + ': the actual native request did not save encoding.xml.');
        assert.deepEqual(actual.diagnostics, [], name);
        assert.deepEqual(expected.diagnostics, [], name);
        report.comparisons.push({ sample: sample.name, step, actual, expected });
      }
    }
    for (const [index, entry] of fallbackFontFiles.entries()) {
      const filename = path.join(directory, entry.path), bytes = await readFile(filename);
      if (entry.length !== undefined) assert.equal(bytes.length, entry.length);
      else assert.deepEqual(bytes, Buffer.from(entry.bytes, 'base64'));
      assert.equal(hash(bytes), report.fileInputs[index].sha256, entry.path + ': original file bytes remain intact.');
    }
    assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences.slice(0, 6)));
    report.componentAcceptance = true;
  } catch (error) { failure = error; report.failure = errorValue(error); }
  finally {
    const errors = [];
    application?.beginClose();
    for (const close of [() => fallbackFonts?.close(), () => closeHost(application), () => registry?.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    report.nodeDiagnostics = diagnostics.map(errorValue);
    if (diagnostics.length) errors.push(new AggregateError(diagnostics, 'Font success, background and close errors remain unclassified failures.'));
    report.cleanup.errors = errors.map(errorValue); report.cleanup.nodeHostClosed = !application?.server.listening;
    if (errors.length) report.componentAcceptance = false;
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, errorJson, 2) + '\n', { flag: 'wx' });
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? errors[0].message, { cause: failure ?? errors[0] });
  }
  if (failure) throw failure;
});

test('fallback font lookup keeps the first OIC storage entry, including its empty-body result', async t => {
  const registry = new StorageRegistry(); registry.registerType('fixture', () => new MemoryStorageAdapter({ pageSize: 1 }));
  await registry.createInstance('fonts', 'fixture', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/fonts', instanceId: 'fonts', capabilities: { create: true, replace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: '/configured-fonts', accessRoot: '/fonts', style: 'posix', returnAccess: 'Isolated font entry order.' });
  await vfs.write('/fonts/FIRST.TTF', new Uint8Array(), { size: 0n });
  await vfs.write('/fonts/first.ttf', Buffer.from('second nonempty'), { size: 15n });
  let current = options('/configured-fonts');
  const fonts = new FallbackFonts({ fileSystem: new StorageFileSystem({ vfs, identityMap }), getEncodingOptions: () => current });
  const application = await host(fonts);
  t.after(async () => { try { await fonts.close(); } finally { try { await closeHost(application); } finally { await registry.close(); } } });
  const result = await observe(application.origin, { name: 'first-empty', method: 'GET', path: '/FallbackFont/Fonts/first.ttf' });
  assert.equal(result.status, 200); assert.equal(result.bodyBase64, '');
  current = options(''); await fonts.list(); assert.equal(current.EnableFallbackFont, false);
  current = options(' '); await assert.rejects(fonts.list(), { code: 'invalid-path' }); assert.equal(current.EnableFallbackFont, true);
  current = options('/unmapped'); await assert.rejects(fonts.list(), { code: 'not-found' }); assert.equal(current.EnableFallbackFont, true);
});

async function controlledStream(t, { closeFailure } = {}) {
  const output = path.join(validationOutputRoot(), 'fallback-font-close-' + randomUUID()), directory = path.join(output, 'files');
  await mkdir(output, { recursive: true }); await seedFiles(directory, [
    { path: 'fonts-A/Body.TTF', bytes: 'AAECAwQFBgcICQoLDA0ODw==' },
    { path: 'fonts-A/stream.woff', length: 256 * 1024 },
  ]);
  const storage = await localFiles(directory), original = storage.fileSystem.openRead.bind(storage.fileSystem);
  const opened = Promise.withResolvers(), closing = Promise.withResolvers(), release = Promise.withResolvers(), released = Promise.withResolvers();
  let active = true, abortReason;
  storage.fileSystem.openRead = async (filename, { signal, ...rest } = {}) => {
    const file = await original(filename, { signal, ...rest });
    if (!active) return file;
    const stopped = Promise.withResolvers(), abort = () => { abortReason = signal.reason; stopped.reject(abortReason); };
    signal.addEventListener('abort', abort, { once: true });
    // Observe the abort promise immediately, including cancellation while the
    // real storage iterator is yielding its first chunk.
    stopped.promise.catch(() => {});
    return { ...file, stream: (async function* () {
      try {
        for await (const chunk of file.stream) {
          yield chunk; opened.resolve(); if (signal.aborted) throw signal.reason; await stopped.promise;
        }
      } finally { signal.removeEventListener('abort', abort); await file.stream.return?.(); }
    })(), async close() {
      closing.resolve(); await release.promise;
      try { await file.close(); if (closeFailure) throw closeFailure; released.resolve(); }
      catch (error) { released.reject(error); throw error; }
    } };
  };
  released.promise.catch(() => {});
  const diagnostics = [], fonts = new FallbackFonts({ fileSystem: storage.fileSystem,
    getEncodingOptions: () => options(path.join(directory, 'fonts-A')) });
  const application = await host(fonts, undefined, diagnostics);
  let client;
  const read = () => new Promise((resolve, reject) => {
    client = request(application.origin + '/FallbackFont/Fonts/stream.woff', response => {
      let received = false;
      response.once('data', () => { received = true; resolve(response); });
      response.once('end', () => { if (!received) reject(new Error('The accepted font reader produced no bytes; HTTP ' + response.statusCode)); });
      response.once('error', error => { if (!received) reject(error); });
    });
    client.once('error', reject); client.end();
  });
  t.after(async () => {
    release.resolve(); active = false; client?.destroy();
    let primary;
    try { await fonts.close(); } catch (error) { primary = error; }
    try { await closeHost(application); } finally { await storage.registry.close(); }
    if (primary) { if (closeFailure) assertReleaseFailure(primary, closeFailure, abortReason); else throw primary; }
  });
  return { fonts, application, directory, storage, diagnostics, opened, closing, release, released,
    read, get abortReason() { return abortReason; }, allowOrdinaryReads() { active = false; } };
}

function assertReleaseFailure(error, expected, abortReason) {
  assert.ok(abortReason, 'The controlled physical reader captured its actual cancellation reason.');
  assert.deepEqual(error.errors.map(errorValue), [abortReason, expected].map(errorValue));
  assert.deepEqual(errorValue(error.cause), errorValue(abortReason));
  assert.equal(error.message, abortReason.message); assert.equal(error.code, abortReason.code);
  assert.equal(error.status, abortReason.status); assert.equal(error.statusCode, abortReason.statusCode);
  return true;
}

test('fallback font service close cancels an accepted HTTP reader, rejects new work and awaits real storage release', { timeout: 30000 }, async t => {
  const state = await controlledStream(t), response = await state.read(); await state.opened.promise;
  const ending = state.fonts.close(); let completed = false; ending.then(() => { completed = true; }, () => { completed = true; });
  await state.closing.promise; await immediate(); assert.equal(completed, false, 'Close is waiting for the accepted reader to release.');
  await assert.rejects(state.fonts.list(), { code: 'closed' });
  await assert.rejects(state.fonts.file('Body.TTF'), { code: 'closed' });
  state.release.resolve(); await state.released.promise; await ending;
  response.destroy(); state.allowOrdinaryReads();
  assert.deepEqual(await state.storage.fileSystem.readFile(path.join(state.directory, 'fonts-A/Body.TTF')), Buffer.from('AAECAwQFBgcICQoLDA0ODw==', 'base64'));
  assert.deepEqual(state.diagnostics, []);
});

test('an HTTP font cancellation closes its plugin reader and preserves complete cleanup failures', { timeout: 30000 }, async t => {
  const cause = Object.assign(new Error('Controlled physical reader release cause.'), { code: 'fixture-release-cause' });
  const cleanup = Object.assign(new Error('Controlled failure after the physical reader closed.', { cause }), { code: 'fixture-release' });
  const state = await controlledStream(t, { closeFailure: cleanup }), response = await state.read(); await state.opened.promise;
  response.destroy(); await state.closing.promise; state.release.resolve(); await assert.rejects(state.released.promise, { code: 'fixture-release' });
  await assert.rejects(state.fonts.close(), error => {
    t.diagnostic(JSON.stringify({ phase: 'physical-font-cancellation-and-release',
      failure: errorValue(error), cancellation: errorValue(state.abortReason), cleanup: errorValue(cleanup) }));
    return assertReleaseFailure(error, cleanup, state.abortReason);
  });
  state.allowOrdinaryReads(); assert.equal((await stat(path.join(state.directory, 'fonts-A/Body.TTF'))).size, 16);
});

test('font directory errors preserve the original storage failure instead of returning an empty success', async t => {
  const output = path.join(validationOutputRoot(), 'fallback-font-errors-' + randomUUID()); await mkdir(output, { recursive: true });
  const storage = await localFiles(output), underlying = storage.fileSystem.stat.bind(storage.fileSystem);
  const cause = Object.assign(new Error('Controlled storage permission cause.'), { code: 'permission-cause' });
  const denied = Object.assign(new StorageError('permission-denied', 'The configured font directory cannot be read.'), { cause });
  storage.fileSystem.stat = async (...args) => { if (args[0] === output) throw denied; return underlying(...args); };
  const current = options(output), fonts = new FallbackFonts({ fileSystem: storage.fileSystem, getEncodingOptions: () => current });
  t.after(async () => { try { await fonts.close(); } finally { await storage.registry.close(); } });
  for (const operation of [() => fonts.list(), () => fonts.file('Body.TTF')]) await assert.rejects(operation(), error => {
    t.diagnostic(JSON.stringify({ phase: 'font-directory-read-failure', failure: errorValue(error) }));
    assert.deepEqual(errorValue(error), errorValue(denied)); return true;
  });
  assert.equal(current.EnableFallbackFont, true);
});

test('an accepted font operation keeps its chosen root while later calls read the replacement current', async t => {
  const output = path.join(validationOutputRoot(), 'fallback-font-scope-' + randomUUID()); await mkdir(output, { recursive: true });
  await seedFiles(output, [{ path: 'A/Shared.ttf', bytes: 'b2xk' }, { path: 'B/Shared.ttf', bytes: 'bmV3LWJ5dGVz' }]);
  const storage = await localFiles(output), underlying = storage.fileSystem.stat.bind(storage.fileSystem);
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), oldRoot = path.join(output, 'A');
  let hold = true, current = options(oldRoot);
  storage.fileSystem.stat = async (filename, args) => {
    if (filename === oldRoot && hold) { hold = false; entered.resolve(); await proceed.promise; }
    return underlying(filename, args);
  };
  const fonts = new FallbackFonts({ fileSystem: storage.fileSystem, getEncodingOptions: () => current }), application = await host(fonts);
  t.after(async () => { proceed.resolve(); try { await fonts.close(); } finally { try { await closeHost(application); } finally { await storage.registry.close(); } } });
  const readingOld = fonts.list(); await entered.promise;
  current = options(path.join(output, 'B')); proceed.resolve();
  const old = await readingOld; assert.equal(old.length, 1); assert.equal(old[0].Name, 'Shared.ttf'); assert.equal(old[0].Size, 3n);
  const latest = await observe(application.origin, { name: 'current-root', method: 'GET', path: '/FallbackFont/Fonts/Shared.ttf' });
  assert.equal(latest.status, 200); assert.equal(Buffer.from(latest.bodyBase64, 'base64').toString(), 'new-bytes');
  assert.equal((await readFile(path.join(oldRoot, 'Shared.ttf'))).toString(), 'old');
});

test('a client disconnected during font selection drains without waiting for a later response close event', { timeout: 30000 }, async t => {
  const output = path.join(validationOutputRoot(), 'fallback-font-disconnect-' + randomUUID()); await mkdir(output, { recursive: true });
  await seedFiles(output, [{ path: 'A/Shared.ttf', bytes: 'b2xk' }]);
  const storage = await localFiles(output), underlying = storage.fileSystem.stat.bind(storage.fileSystem), root = path.join(output, 'A');
  const selected = Promise.withResolvers(), continueSelection = Promise.withResolvers(), disconnected = Promise.withResolvers();
  let hold = true;
  storage.fileSystem.stat = async (filename, args) => {
    if (filename === root && hold) { hold = false; selected.resolve(); await continueSelection.promise; }
    return underlying(filename, args);
  };
  const diagnostics = [], fonts = new FallbackFonts({ fileSystem: storage.fileSystem, getEncodingOptions: () => options(root) }), application = await host(fonts, undefined, diagnostics);
  let client;
  t.after(async () => {
    client?.destroy(); continueSelection.resolve();
    try { await fonts.close(); } finally { try { await closeHost(application); } finally { await storage.registry.close(); } }
  });
  application.server.once('request', (_request, response) => response.once('close', () => disconnected.resolve()));
  client = request(application.origin + '/FallbackFont/Fonts/Shared.ttf'); client.on('error', () => {}); client.end();
  await selected.promise; client.destroy(); await disconnected.promise; continueSelection.resolve();
  await application.drainRequests(); await fonts.close();
  assert.deepEqual(await storage.fileSystem.readFile(path.join(root, 'Shared.ttf')), Buffer.from('old'));
  assert.deepEqual(diagnostics, []);
});
