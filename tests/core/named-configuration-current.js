import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { configurationJson, configurationValue } from './fixtures/configuration/observations.js';
import { namedConfigurationInput } from './fixtures/named-configuration-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const namedInput = namedConfigurationInput();
const fixture = new URL('./fixtures/named-configuration-current/', import.meta.url);
const project = fileURLToPath(new URL('Oracle.csproj', fixture));
export const namedHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const namedError = error => error == null || typeof error !== 'object' ? error
  : Array.isArray(error) ? error.map(namedError)
    : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), ...(error instanceof Error ? ['name'] : [])])]
      .map(name => [name, namedError(error[name])]));
// Inputs are an actual Error or its namedError record. Only its known error
// chain has diagnostic name/stack fields; ordinary details/context stay whole.
export function namedFailurePayload(error) {
  const visit = (value, errorNode) => value == null || typeof value !== 'object' ? value
    : Array.isArray(value) ? value.map(entry => visit(entry, errorNode))
      : Object.fromEntries(Object.entries(value).filter(([key]) => !errorNode || key !== 'name' && key !== 'stack')
        .map(([key, entry]) => [key, visit(entry, errorNode && (key === 'cause' || key === 'errors'))]));
  return visit(namedError(error), true);
}
export const namedClone = (value, transform = value => value) => typeof value === 'string' ? transform(value)
  : Array.isArray(value) ? value.map(entry => namedClone(entry, transform))
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, namedClone(entry, transform)])) : value;
export const namedNormalise = (value, root) => namedClone(value, text => text.replaceAll(root, '@').replaceAll(root.replaceAll('\\', '/'), '@'));
export const namedExpand = (value, root) => namedClone(value, text => text.startsWith('@/') ? path.join(root, ...text.slice(2).split('/')) : text);
export const namedValue = (value, key) => configurationValue(value, key.toLowerCase());
export const namedDiskProjection = (value, key) => value === null ? null : {
  directory: value.directory, accepted: value.accepted, value: namedValue(value.value, key),
};
function stateProjection(value, key) {
  return { current: Object.fromEntries(Object.entries(value.current).map(([name, current]) => [name, namedValue(current, key)])),
    retained: Object.fromEntries(Object.entries(value.retained).map(([name, retained]) => [name, namedValue(retained, key)])),
    disk: namedDiskProjection(value.disk, key), linkedDisk: namedDiskProjection(value.linkedDisk, key), files: value.files };
}
export function namedCoreProjection(row) {
  return namedNormalise({ name: row.name, key: row.key,
    before: stateProjection(row.before, row.key),
    steps: row.steps.map(step => ({ step: step.step, accepted: step.accepted,
      result: namedValue(step.result, row.key), state: stateProjection(step.state, row.key) })),
    events: row.events.map(event => ({ phase: event.phase, key: event.key,
      configuration: namedValue(event.configuration, row.key), state: stateProjection(event.state, row.key) })),
    after: stateProjection(row.after, row.key) }, row.root);
}
export function namedWire(value, root) {
  const json = value.json === null ? null : namedClone(value.json);
  if (json && !Array.isArray(json) && Object.hasOwn(json, 'traceId')) {
    assert.equal(typeof json.traceId, 'string'); assert.ok(json.traceId.length > 0);
    json.traceId = '$opaque-request-identity';
  }
  const location = Object.entries(value.headers ?? {}).find(([name]) => name.toLowerCase() === 'location')?.[1];
  return namedNormalise({ status: value.status, transportFailure: value.error != null, contentType: value.contentType?.split(';')[0].toLowerCase() ?? null,
    location: Array.isArray(location) ? location[0] : location ?? null,
    ...(json !== null ? { json } : { text: value.text }) }, root);
}
export function namedHttpProjection(row, key) {
  return namedNormalise({ name: row.name, response: namedWire(row.response, row.root), afterRead: namedWire(row.afterRead, row.root),
    live: row.live === null ? null : namedValue(row.live, key),
    events: row.events.map(event => ({ phase: event.phase, key: event.key, configuration: namedValue(event.configuration, key) })),
    disk: namedDiskProjection(row.disk, key) }, row.root);
}
export function namedPathsProjection(row) {
  const projectState = state => ({ encoding: namedValue(state.encoding, 'encoding'), metadata: namedValue(state.metadata, 'metadata'),
    cachePath: state.cachePath, tree: state.tree });
  return namedNormalise({ name: row.name, before: projectState(row.before),
    steps: row.steps.map(step => ({ step: step.step, accepted: step.accepted, result: step.result,
      error: step.error === null ? null : step.error.Message ?? step.error.message, state: projectState(step.state) })), after: projectState(row.after) }, row.root);
}

let pending;
export const currentNamedConfiguration = () => pending ??= capture();

async function verifyCapture(native, bytes, record, inputBytes, build, consume = false) {
  assert.equal(native.inputSha256, namedHash(inputBytes));
  assert.equal(record.outputs.find(entry => path.basename(entry.filename) === 'native.json')?.sha256, namedHash(bytes));
  assert.equal(native.actualSerializer, true);
  assert.equal(native.actualColdRead, consume);
  if (!consume) {
    for (const flag of ['actualManager', 'actualFactories', 'actualMvc', 'actualController', 'actualAuthorization',
      'actualExceptionMiddleware', 'actualGetTranscodePath', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true, flag);
    assert.deepEqual(native.core.map(row => row.name), namedInput.core.map(row => row.name));
    assert.deepEqual(native.http.map(row => row.name), namedInput.http.map(row => row.name));
    assert.deepEqual(native.paths.map(row => row.name), namedInput.paths.map(row => row.name));
  }
  for (const assembly of native.assemblies) {
    assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
  }
  for (const name of consume ? ['Emby.Server.Implementations', 'MediaBrowser.Model']
    : ['Emby.Server.Implementations', 'MediaBrowser.Common', 'MediaBrowser.Controller', 'MediaBrowser.Model', 'MediaBrowser.MediaEncoding', 'Jellyfin.Api', 'Jellyfin.Extensions']) {
    const assembly = native.assemblies.find(entry => entry.name === name); assert.ok(assembly, name);
    assert.equal(assembly.sha256, (await describeFile(path.join(build.runtime, name + '.dll'))).sha256, name);
  }
}

async function capture() {
  const output = path.join(validationOutputRoot(), 'named-configuration-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const inputBytes = Buffer.from(configurationJson(namedInput)), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const profile = JSON.parse(await readFile(new URL('profile.json', fixture), 'utf8'));
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: namedHash(inputBytes),
    inputs: [], sourceBindings: [], captures: [], nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const relative of ['Oracle.csproj', 'Program.cs', 'profile.json', 'input.js', 'node-host.js']) {
      const description = await describeFile(fileURLToPath(new URL(relative, fixture)));
      assert.equal(description.available, true, relative); report.inputs.push(description);
    }
    for (const relative of ['src/core/resources/configuration-model.json', 'src/core/named-configuration-store.js', 'src/core/encoding-paths.js',
      'src/http/named-configuration-binding.js', 'tests/core/named-configuration-current.js',
      'tests/core/named-configuration-native.test.js', 'tests/http/named-configuration-native.test.js']) {
      const description = await describeFile(path.resolve(relative)); assert.equal(description.available, true, relative); report.inputs.push(description);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.available, true, relative); assert.equal(source.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, source });
    }
    const observations = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label), record = await recordOracle({ project, output: directory,
        args: [inputFile, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      report.captures.push({ label, record, observation: await describeFile(filename) });
      await verifyCapture(native, bytes, record, inputBytes, build); observations.push(native);
    }
    for (const description of report.inputs) assert.equal((await describeFile(description.filename)).sha256, description.sha256);
    assert.equal(namedHash(await readFile(inputFile)), namedHash(inputBytes));
    report.nativeExecutionRecorded = true;
    return { native: observations[0], repeat: observations[1], output, report, build, async consume(rows, label) {
      const consumeInput = path.join(output, label + '-input.json'), consumeBytes = Buffer.from(configurationJson(rows));
      await writeFile(consumeInput, consumeBytes, { flag: 'wx' });
      const directory = path.join(output, label), record = await recordOracle({ project, output: directory,
        args: ['consume', consumeInput, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      await verifyCapture(native, bytes, record, consumeBytes, build, true);
      return { input: await describeFile(consumeInput), record, observation: await describeFile(filename), native };
    } };
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), configurationJson(report), { flag: 'wx' }); }
}
