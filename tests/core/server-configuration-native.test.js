import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import model from '../../src/core/resources/configuration-model.json' with { type: 'json' };
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { parseConfigurationXml, readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { serializeConfiguration } from '../../src/core/configuration-file.js';
import { configurationJson, configurationValue } from './fixtures/configuration/observations.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const fixture = new URL('./fixtures/server-configuration-current/', import.meta.url);
const inputFile = new URL('input.json', fixture), inputBytes = await fs.readFile(inputFile);
const input = parseLosslessJson(inputBytes.toString('utf8'));
const project = fileURLToPath(new URL('Oracle.csproj', fixture));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const serverFields = [...new Set([...Object.keys(model.definitions.ServerConfiguration.defaults), 'PreviousVersion'])];
const errorValue = error => error == null ? null : { name: error.name, message: error.message, code: error.code,
  status: error.status, statusCode: error.statusCode, cause: error.cause === undefined ? undefined : errorValue(error.cause),
  errors: error.errors === undefined ? undefined : Array.from(error.errors, errorValue) };
const clone = (value, transform) => typeof value === 'string' ? transform(value) : Array.isArray(value)
  ? value.map(entry => clone(entry, transform)) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, clone(entry, transform)])) : value;
const normalise = (value, root) => clone(value, text => text.replaceAll(root, '@'));
const relocate = (value, from, to) => clone(value, text => text.replaceAll(from, to));
const expand = (value, root) => clone(value, text => text.startsWith('@/') ? path.join(root, ...text.slice(2).split('/')) : text);
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function disk(filename, root, processors) {
  let bytes = null, directory = false, value = null, error = null, elements = null;
  try { directory = fsSync.statSync(filename).isDirectory(); if (!directory) bytes = fsSync.readFileSync(filename); }
  catch (failure) { if (!missing(failure)) throw failure; }
  if (bytes !== null) {
    try { value = parseConfigurationXml(bytes, root, { processors }); } catch (failure) { error = errorValue(failure); }
    try {
      elements = readConfigurationDocument(bytes, root, { processors }).node.children.filter(node =>
        (node.namespaces[node.name.includes(':') ? node.name.split(':')[0] : ''] ?? '') === '').map(node => node.name.split(':').at(-1));
    } catch { }
  }
  return { bytes: bytes?.toString('base64') ?? null, directory, accepted: bytes === null ? null : error === null, value, error, elements };
}

function tree(root) {
  const rows = [];
  function visit(directory) {
    for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).split(path.sep).join('/');
      const isDirectory = entry.isDirectory();
      rows.push({ path: relative, directory: isDirectory, bytes: isDirectory || ['config/system.xml', 'config/network.xml'].includes(relative)
        ? null : fsSync.readFileSync(filename).toString('base64') });
      if (isDirectory) visit(filename);
    }
  }
  visit(root); return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

const publicConfiguration = configuration => configuration == null ? null : Object.fromEntries(serverFields.map(name => [name, configuration[name]]));
function state(root, { store, namedConfiguration }, paths, processors, ready = true) {
  return structuredClone({ configuration: ready ? publicConfiguration(store.configuration) : null,
    network: ready ? namedConfiguration.getCurrentConfiguration('network') : null,
    metadataPath: paths.metadataPath, cachePath: paths.cachePath,
    disk: disk(path.join(root, 'config/system.xml'), 'server', processors),
    networkDisk: disk(path.join(root, 'config/network.xml'), 'network', processors), tree: tree(root) });
}

function actions(sample, property, root, configuration) {
  const file = (...segments) => path.join(root, ...segments);
  const filename = file('config/system.xml');
  for (const action of sample[property] ?? []) switch (action) {
    case 'metadata-file': fsSync.writeFileSync(file('metadata-file'), 'metadata path is a file'); break;
    case 'initial-cache-other-marker': fsSync.writeFileSync(file('cache-initial/.jellyfin-data'), 'foreign marker'); break;
    case 'cache-other-marker': fsSync.writeFileSync(file('cache-next/.jellyfin-data'), 'foreign marker'); break;
    case 'cache-marker-and-tag': fsSync.writeFileSync(file('cache-next/.jellyfin-cache'), 'existing marker'); fsSync.writeFileSync(file('cache-next/CACHEDIR.TAG'), 'existing cache tag'); break;
    case 'cache-own-marker-case': fsSync.writeFileSync(file('cache-next/.jellyfin-CACHE'), 'existing differently cased marker'); break;
    case 'cache-marker-directory': fsSync.mkdirSync(file('cache-next/.jellyfin-directory')); break;
    case 'metadata-next-file': fsSync.rmSync(file('metadata-next'), { recursive: true }); fsSync.writeFileSync(file('metadata-next'), 'metadata path became a file'); break;
    case 'cache-next-file': fsSync.rmSync(file('cache-next'), { recursive: true }); fsSync.writeFileSync(file('cache-next'), 'cache path became a file'); break;
    case 'remove-config-directory': fsSync.rmSync(file('config'), { recursive: true }); break;
    case 'configuration-target-directory': fsSync.unlinkSync(filename); fsSync.mkdirSync(filename); break;
    case 'remove-configuration-target-directory': fsSync.rmdirSync(filename); break;
    case 'readonly-system': fsSync.chmodSync(filename, 0o444); break;
    case 'live-metadata-file': fsSync.writeFileSync(file('metadata-file'), 'metadata path is a file'); configuration.MetadataPath = file('metadata-file'); break;
    case 'add-unmodeled': {
      const xml = fsSync.readFileSync(filename, 'utf8').replace('<ServerConfiguration ', '<ServerConfiguration xmlns:u="urn:future" u:flag="retained input" ')
        .replace('</ServerConfiguration>', 'before<u:extra a="v">x<u:child/>y</u:extra>after</ServerConfiguration>');
      fsSync.writeFileSync(filename, xml); break;
    }
    default: throw new Error('Unknown physical configuration action: ' + action);
  }
}

async function candidateCase(sample, expected, root, processors) {
  await fs.mkdir(root);
  for (const relative of input.directories) await fs.mkdir(path.join(root, relative));
  await fs.mkdir(path.join(root, 'data')); await fs.mkdir(path.join(root, 'config'));
  const configuration = configurationValue(relocate(expected.initialState.configuration ?? expected.initialState.disk.value, expected.root, root), 'server');
  const network = configurationValue(relocate(expected.initialState.network ?? expected.initialState.networkDisk.value, expected.root, root), 'network');
  await fs.writeFile(path.join(root, 'config/system.xml'), serializeConfiguration('server', configuration));
  await fs.writeFile(path.join(root, 'config/network.xml'), serializeConfiguration('network', network));
  const paths = { programDataPath: root, defaultMetadataPath: path.join(root, 'metadata'), metadataPath: path.join(root, 'metadata'),
    cachePath: Object.hasOwn(sample, 'preselectedCache') ? sample.preselectedCache : path.join(root, 'preselected-cache') };
  actions(sample, 'seed', root, configuration);
  const storage = await localStateStorage(root), reportedErrors = [];
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: path.join(root, 'config'),
    applicationPaths: paths, metadataFileSystem: storage.fileSystem, onError: error => reportedErrors.push(errorValue(error)) });
  const namedConfiguration = new NamedConfigurationStore({ configurationDirectoryPath: path.join(root, 'config'), loadedConfigurations: [['network', network]] });
  let releaseUpdated;
  try {
    let initializationError = null;
    try { await store.initialize(); } catch (failure) { initializationError = errorValue(failure); }
    const initialState = state(root, { store, namedConfiguration }, paths, processors, initializationError === null);
    if (initializationError || sample.operation === 'initialize') return { name: sample.name, root, operation: sample.operation,
      initialized: initializationError === null, initializationError, initialState, before: initialState, requested: null,
      accepted: initializationError === null, error: initializationError, updating: [], namedUpdating: [], namedUpdated: [],
      afterCall: initialState, continuation: [], updated: [], laterUpdated: false, afterDrain: initialState, reportedErrors };
    actions(sample, 'before', root, store.configuration);
    const before = state(root, { store, namedConfiguration }, paths, processors), updating = [], namedUpdating = [], namedUpdated = [], updated = [];
    const released = new Promise(resolve => { releaseUpdated = resolve; }); let laterUpdated = false;
    store.on('updating', next => {
      updating.push(structuredClone({ state: state(root, { store, namedConfiguration }, paths, processors), next }));
      Object.assign(next, expand(sample.updating ?? {}, root)); actions(sample, 'duringUpdating', root, store.configuration);
      if (sample.updatingFailure) throw new Error('Controlled updating failure.');
    });
    namedConfiguration.on('updating', ({ key: name, configuration: next }) => {
      namedUpdating.push(structuredClone({ name, state: state(root, { store, namedConfiguration }, paths, processors), next }));
      Object.assign(next, expand(sample.namedUpdating ?? {}, root));
      if (sample.namedUpdatingFailure) throw new Error('Controlled named updating failure.');
    });
    namedConfiguration.on('updated', ({ key: name, configuration: next }) => { namedUpdated.push(structuredClone({ name, state: state(root, { store, namedConfiguration }, paths, processors), next })); });
    store.on('updated', async () => {
      await released; updated.push(state(root, { store, namedConfiguration }, paths, processors));
      if (sample.updatedFailure) throw new Error('Controlled updated failure.');
    });
    store.on('updated', () => { laterUpdated = true; });
    let requested = null, error = null;
    const previous = store.configuration;
    let incoming = null, originalIncomingContentTypes = null;
    try {
      if (sample.operation === 'replace') {
        const next = configurationValue(relocate(expected.requested, expected.root, root), 'server');
        incoming = next; originalIncomingContentTypes = next.ContentTypes;
        requested = structuredClone(next); await store.replaceConfiguration(next);
      } else if (sample.operation === 'network') {
        requested = { ...structuredClone(network), ...expand(sample.changes, root) };
        Object.assign(network, expand(sample.changes, root)); await namedConfiguration.saveConfiguration('network', network);
      } else if (sample.operation === 'startup') {
        requested = { ...publicConfiguration(store.configuration), ...expand(sample.changes, root) };
        await store.updateServerValues(expand(sample.changes, root));
      } else if (sample.operation === 'contentTypes') {
        const values = expand(sample.changes.ContentTypes, root);
        requested = { ...publicConfiguration(store.configuration), ContentTypes: values };
        await store.updateContentTypes(() => values);
      } else {
        Object.assign(store.configuration, expand(sample.changes, root));
        requested = publicConfiguration(store.configuration);
        await store.saveConfiguration();
      }
    } catch (failure) { error = errorValue(failure); }
    const afterCall = state(root, { store, namedConfiguration }, paths, processors), continuation = [];
    for (const step of sample.continuation ?? []) {
      let continuationError = null;
      try {
        if (step.target === 'incoming') Object.assign(incoming, expand(step.changes, root));
        else if (step.target === 'current') Object.assign(store.configuration, expand(step.changes, root));
        else if (step.target === 'previous') Object.assign(previous, expand(step.changes, root));
        else if (step.target === 'originalIncomingContentTypes') originalIncomingContentTypes[0].Value = step.value;
        else if (step.target === 'filesystem') actions({ steps: [step.action] }, 'steps', root, store.configuration);
        else if (step.target === 'save') await store.saveConfiguration();
        else throw new Error('Unknown retained configuration operation: ' + step.target);
      } catch (failure) { continuationError = errorValue(failure); }
      continuation.push(structuredClone({ name: step.name, target: step.target, error: continuationError,
        state: state(root, { store, namedConfiguration }, paths, processors), incoming: publicConfiguration(incoming),
        previous: publicConfiguration(previous), originalIncomingContentTypes }));
    }
    releaseUpdated(); await store.close();
    const afterDrain = state(root, { store, namedConfiguration }, paths, processors);
    return { name: sample.name, root, operation: sample.operation, initialized: true, initializationError, initialState,
      before, requested, accepted: error === null, error, updating, namedUpdating, namedUpdated, afterCall, continuation, updated, laterUpdated, afterDrain, reportedErrors };
  } finally {
    releaseUpdated?.();
    await namedConfiguration.close(); await store.close(); await storage.close();
    try { const info = await fs.stat(path.join(root, 'config/system.xml')); if (info.isFile()) await fs.chmod(path.join(root, 'config/system.xml'), 0o666); }
    catch (failure) { if (!missing(failure)) throw failure; }
  }
}

function projectedDisk(value, root) {
  return { directory: value.directory, accepted: value.accepted, value: configurationValue(value.value, root) };
}
function projectedState(value) {
  return { configuration: configurationValue(value.configuration, 'server'), network: configurationValue(value.network, 'network'),
    metadataPath: value.metadataPath, cachePath: value.cachePath, disk: projectedDisk(value.disk, 'server'), networkDisk: projectedDisk(value.networkDisk, 'network'), tree: value.tree };
}
function projectRow(row) {
  return normalise({ name: row.name, operation: row.operation, initialized: row.initialized, accepted: row.accepted,
    initialState: projectedState(row.initialState), before: projectedState(row.before),
    requested: configurationValue(row.requested, row.operation === 'network' ? 'network' : 'server'),
    updating: row.updating.map(event => ({ state: projectedState(event.state), next: configurationValue(event.next, 'server') })),
    namedUpdating: row.namedUpdating.map(event => ({ name: event.name, state: projectedState(event.state), next: configurationValue(event.next, 'network') })),
    namedUpdated: row.namedUpdated.map(event => ({ name: event.name, state: projectedState(event.state), next: configurationValue(event.next, 'network') })),
    continuation: row.continuation.map(step => ({ name: step.name, target: step.target, accepted: step.error === null,
      state: projectedState(step.state), incoming: configurationValue(step.incoming, 'server'), previous: configurationValue(step.previous, 'server'),
      originalIncomingContentTypes: step.originalIncomingContentTypes })),
    afterCall: projectedState(row.afterCall), updated: row.updated.map(projectedState), laterUpdated: row.laterUpdated, afterDrain: projectedState(row.afterDrain),
    systemBytesUnchanged: row.before.disk.bytes === row.afterCall.disk.bytes,
    networkBytesUnchanged: row.before.networkDisk.bytes === row.afterCall.networkDisk.bytes }, row.root);
}

let pending;
const current = () => pending ??= capture();
async function capture() {
  const profile = JSON.parse(await fs.readFile(new URL('profile.json', fixture), 'utf8'));
  const output = path.join(validationOutputRoot(), 'server-configuration-current-' + randomUUID());
  assertValidationOutputChild(output); await fs.mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    nativeExecutionRecorded: false, actualNativeCandidateReads: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const filename of ['input.json', 'profile.json', 'Program.cs', 'Oracle.csproj']) report.inputs.push(await describeFile(fileURLToPath(new URL(filename, fixture))));
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await fs.readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const actual = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(actual.sha256, expected.sha256, relative); report.sourceBindings.push({ relative, source: actual });
    }
    const oracle = await compileOracle({ project, output: path.join(output, 'build') });
    report.oracleBuild = oracle.buildRecord;
    const captures = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label);
      const record = await oracle.record({ output: directory, args: [fileURLToPath(inputFile), '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await fs.readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      assert.equal(record.passed, true); assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(inputBytes));
      for (const name of ['actualServerConfigurationManager', 'actualXmlSerializer', 'actualPathEffects', 'actualQueuedEvents']) assert.equal(native[name], true, name);
      for (const assembly of native.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
      for (const name of ['Emby.Server.Implementations', 'MediaBrowser.Model', 'MediaBrowser.Common']) assert.equal(native.assemblies.find(assembly => assembly.name === name)?.sha256,
        (await describeFile(path.join(build.runtime, name + '.dll'))).sha256, name);
      assert.deepEqual(native.results.map(row => row.name), input.cases.map(sample => sample.name));
      captures.push(native); report.captures.push({ label, record, observation: await describeFile(filename) });
    }
    report.nativeExecutionRecorded = true;
    const candidateRoot = path.join(output, 'node'); await fs.mkdir(candidateRoot);
    const rows = [];
    for (const [index, sample] of input.cases.entries()) rows.push(await candidateCase(sample, captures[0].results[index], path.join(candidateRoot, String(index)), captures[0].host.processorCount));
    const candidateFile = path.join(output, 'node-observations.json'); await fs.writeFile(candidateFile, configurationJson({ inputSha256: sha(inputBytes), results: rows }), { flag: 'wx' });
    report.candidate = await describeFile(candidateFile);
    const reads = [];
    for (const row of rows) for (const [kind, filename, observed] of [
      ['server', 'system.xml', row.afterDrain.disk], ['network', 'network.xml', row.afterDrain.networkDisk],
    ]) if (observed.bytes !== null) reads.push({ name: row.name + ':' + kind, root: kind, filename: path.join(row.root, 'config', filename) });
    const consumeFile = path.join(output, 'candidate-read-input.json'), consumeBytes = Buffer.from(configurationJson(reads));
    await fs.writeFile(consumeFile, consumeBytes, { flag: 'wx' });
    const consumedRoot = path.join(output, 'native-candidate-read');
    const consumedRecord = await oracle.record({ output: consumedRoot, args: ['consume', consumeFile, '{output}/native.json'] });
    const consumedFile = path.join(consumedRoot, 'native.json'), consumedBytes = await fs.readFile(consumedFile), consumed = parseLosslessJson(consumedBytes.toString('utf8'));
    assert.equal(consumedRecord.outputs.find(entry => entry.filename === consumedFile)?.sha256, sha(consumedBytes));
    assert.equal(consumed.inputSha256, sha(consumeBytes)); assert.equal(consumed.actualContinuedRead, true); assert.equal(consumed.actualXmlSerializer, true);
    assert.deepEqual(consumed.results.map(row => row.name), reads.map(row => row.name));
    for (const assembly of consumed.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
    for (const name of ['Emby.Server.Implementations', 'MediaBrowser.Model', 'MediaBrowser.Common']) assert.equal(consumed.assemblies.find(assembly => assembly.name === name)?.sha256,
      captures[0].assemblies.find(assembly => assembly.name === name)?.sha256, name);
    report.nativeConsumer = { record: consumedRecord, input: await describeFile(consumeFile), observation: await describeFile(consumedFile) };
    report.actualNativeCandidateReads = true;
    for (const before of report.inputs) assert.equal((await describeFile(before.filename)).sha256, before.sha256, before.filename);
    return { native: captures[0], repeat: captures[1], rows, consumed, report, output };
  } catch (error) { report.error = errorValue(error); throw error; }
  finally { await fs.writeFile(path.join(output, 'capture-report.json'), configurationJson(report), { flag: 'wx' }); }
}

test('server configuration evidence uses the actual manager and serializer with independent repeat and cold Native reads', async () => {
  const result = await current();
  assert.equal(result.report.nativeExecutionRecorded, true); assert.equal(result.report.actualNativeCandidateReads, true);
  assert.deepEqual(result.native.results.map(projectRow), result.repeat.results.map(projectRow));
  for (const consumed of result.consumed.results) {
    const name = consumed.name.slice(0, consumed.name.lastIndexOf(':')), row = result.rows.find(row => row.name === name);
    const expected = consumed.root === 'server' ? row.afterDrain.disk : row.afterDrain.networkDisk;
    assert.deepEqual(projectedDisk(consumed.disk, consumed.root), projectedDisk(expected, consumed.root), consumed.name);
    assert.equal(consumed.disk.bytes, expected.bytes, consumed.name + ' original Node-written bytes');
  }
});

for (const sample of input.cases) test('server configuration manager: ' + sample.name, async () => {
  const result = await current(), actual = result.rows.find(row => row.name === sample.name), expected = result.native.results.find(row => row.name === sample.name);
  assert.deepEqual(projectRow(actual), projectRow(expected));
  if (['metadata-missing-before-updating', 'metadata-file-before-updating', 'updating-mutates-cache-before-validation', 'cache-missing-after-updating'].includes(sample.name)) {
    assert.equal(actual.error.status, 404); assert.equal(actual.error.code, 'ENOENT');
    assert.equal(normalise(actual.error.message, actual.root), normalise(expected.error.message, expected.root));
  }
  if (sample.name === 'replace-clears-old-known-keeps-unmodeled-input') {
    const original = readConfigurationDocument(Buffer.from(actual.before.disk.bytes, 'base64'), 'server').node;
    const updated = readConfigurationDocument(Buffer.from(actual.afterDrain.disk.bytes, 'base64'), 'server').node;
    const unknown = node => ({ name: node.name, attributes: node.attributes, content: node.content.map(part => typeof part === 'string' ? part : unknown(part)) });
    assert.equal(updated.attributes['u:flag'], original.attributes['u:flag']);
    assert.deepEqual(updated.children.filter(node => node.name === 'u:extra').map(unknown), original.children.filter(node => node.name === 'u:extra').map(unknown));
    assert.match(updated.text, /before.*after/u); assert.equal(actual.afterDrain.disk.value.ServerName, '');
    assert.equal(actual.afterDrain.configuration.ServerName, null);
  }
  if (sample.continuation) {
    assert.deepEqual(actual.continuation.map(step => step.name), sample.continuation.map(step => step.name));
    assert.ok(actual.continuation.every(step => step.error === null), configurationJson(actual.continuation));
    const [late, reverse, detached, oldTypes] = actual.continuation;
    assert.equal(late.state.configuration.ServerName, sample.continuation[0].changes.ServerName);
    assert.equal(late.state.configuration.PreviousVersion, '4.5.6');
    assert.equal(reverse.incoming.ServerName, sample.continuation[1].changes.ServerName);
    assert.equal(reverse.incoming.PreviousVersionStr, '6.7.8');
    assert.equal(detached.previous.ServerName, 'Detached previous');
    for (const step of [detached, oldTypes]) {
      assert.equal(step.state.configuration.ServerName, reverse.incoming.ServerName);
      assert.equal(step.state.configuration.PreviousVersionStr, '6.7.8');
      assert.deepEqual(step.state.configuration.ContentTypes, reverse.incoming.ContentTypes);
    }
    assert.equal(oldTypes.originalIncomingContentTypes[0].Value, 'Detached original incoming types');
    assert.equal(actual.afterDrain.disk.accepted, true);
    assert.equal(actual.afterDrain.disk.value.ServerName, reverse.incoming.ServerName);
    assert.equal(actual.afterDrain.disk.value.PreviousVersionStr, '6.7.8');
    assert.deepEqual(actual.afterDrain.disk.value.ContentTypes, reverse.incoming.ContentTypes);
    if (sample.name === 'replace-save-io-failure-retains-incoming-and-recovers') {
      assert.equal(actual.accepted, false); assert.equal(actual.afterCall.disk.directory, true);
      assert.equal(actual.afterCall.configuration.ServerName, 'Replacement server');
      assert.equal(actual.afterCall.configuration.PreviousVersion, '2.3.4');
    }
  }
});
