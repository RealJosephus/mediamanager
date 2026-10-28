import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { configurationJson, configurationValue } from './fixtures/configuration/observations.js';
import { namedConfigurationInput } from './fixtures/named-configuration-current/input.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const namedInput = namedConfigurationInput();
const fixture = new URL('./fixtures/named-configuration-current/', import.meta.url);
const project = fileURLToPath(new URL('Oracle.csproj', fixture));
export const namedHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const namedError = error => error == null || typeof error !== 'object' ? error
  : Array.isArray(error) ? error.map(namedError)
    : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), ...(error instanceof Error ? ['name'] : [])])]
      .map(name => [name, namedError(error[name])]));
// Project the live reason before diagnostic serialization loses its type.
// Ordinary business name/stack fields remain part of the public payload.
export function namedFailurePayload(error) {
  if (error == null || typeof error !== 'object') return error;
  if (Array.isArray(error)) return error.map(namedFailurePayload);
  const keys = new Set([...Object.getOwnPropertyNames(error),
    ...['message', 'code', 'status', 'statusCode', 'cause', 'errors', 'name', 'stack'].filter(key => key in error)]);
  return Object.fromEntries([...keys].filter(key => !(error instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, namedFailurePayload(error[key])]));
}
// These fields are actual file/directory roles, not a convention based on a
// property name or a matching string elsewhere in a configuration value.
const pathFields = {
  encoding: new Set(['TranscodingTempPath', 'FallbackFontPath', 'EncoderAppPath', 'EncoderAppPathDisplay']),
  network: new Set(['CertificatePath']),
};
export function namedPath(value, root) {
  if (typeof value !== 'string') return value;
  const prefix = root.replaceAll('\\', '/').replace(/\/$/u, ''), filename = value.replaceAll('\\', '/');
  return filename === prefix ? '@' : filename.startsWith(prefix + '/') ? '@' + filename.slice(prefix.length) : value;
}
export const namedExpandPath = (value, root) => typeof value === 'string' && value.startsWith('@/')
  ? path.join(root, ...value.slice(2).split('/')) : value;
const configurationPaths = (value, key, transform) => !value || typeof value !== 'object' || Array.isArray(value) ? value
  : Object.fromEntries(Object.entries(value).map(([name, entry]) => [name,
    pathFields[key.toLowerCase()]?.has(name) ? transform(entry) : entry]));
export const namedExpand = (value, root, key) => configurationPaths(value, key, entry => namedExpandPath(entry, root));
export function namedExpandBody(body, root, key) {
  // Preserve original JSON text, duplicate properties and binder failure input.
  // Only root property string tokens in the declared path roles are replaced.
  let value;
  try { value = parseLosslessJson(body); } catch { return body; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
  const fields = pathFields[key.toLowerCase()];
  if (!fields) return body;
  const tokens = [...body.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/gu)];
  let depth = 0, property = false;
  const changes = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index][0];
    if (token === '{' || token === '[') { depth++; if (depth === 1) property = true; continue; }
    if (token === '}' || token === ']') { depth--; continue; }
    if (depth !== 1) continue;
    if (token === ',') { property = true; continue; }
    if (!property || token[0] !== '"') continue;
    property = false;
    if (!fields.has(JSON.parse(token)) || tokens[index + 1]?.[0] !== ':' || tokens[index + 2]?.[0][0] !== '"') continue;
    const target = tokens[index + 2], original = JSON.parse(target[0]);
    // Match the Native HTTP fixture's forward-slash request path spelling.
    const expanded = original.startsWith('@/') ? root.replaceAll('\\', '/') + '/' + original.slice(2) : original;
    if (expanded !== original) changes.push({ start: target.index, end: target.index + target[0].length, value: JSON.stringify(expanded) });
  }
  for (const change of changes.reverse()) body = body.slice(0, change.start) + change.value + body.slice(change.end);
  return body;
}
export const namedValue = (value, key) => configurationValue(value, key.toLowerCase());
const projectedConfiguration = (value, key, root) => configurationPaths(namedValue(value, key), key, entry => namedPath(entry, root));
export const namedDiskProjection = (value, key, root) => value === null ? null : {
  directory: value.directory, accepted: value.accepted,
  value: root === undefined ? namedValue(value.value, key) : projectedConfiguration(value.value, key, root),
};
function stateProjection(value, key, root) {
  return { current: Object.fromEntries(Object.entries(value.current).map(([name, current]) => [name, projectedConfiguration(current, key, root)])),
    retained: Object.fromEntries(Object.entries(value.retained).map(([name, retained]) => [name, projectedConfiguration(retained, key, root)])),
    disk: namedDiskProjection(value.disk, key, root), linkedDisk: namedDiskProjection(value.linkedDisk, key, root), files: value.files };
}
export function namedCoreProjection(row) {
  return { name: row.name, key: row.key,
    before: stateProjection(row.before, row.key, row.root),
    steps: row.steps.map(step => ({ step: step.step, accepted: step.accepted,
      result: projectedConfiguration(step.result, row.key, row.root), state: stateProjection(step.state, row.key, row.root) })),
    events: row.events.map(event => ({ phase: event.phase, key: event.key,
      configuration: projectedConfiguration(event.configuration, row.key, row.root), state: stateProjection(event.state, row.key, row.root) })),
    after: stateProjection(row.after, row.key, row.root) };
}
export function namedWire(value, root, key) {
  const json = value.json === null ? null : projectProblemTrace(
    typeof value.text === 'string' ? parseLosslessJson(value.text) : value.json, value.status);
  const body = value.status === 200 && key ? configurationPaths(json, key, entry => namedPath(entry, root)) : json;
  const location = Object.entries(value.headers ?? {}).find(([name]) => name.toLowerCase() === 'location')?.[1];
  return { status: value.status, transportFailure: value.error != null, contentType: value.contentType ?? null,
    location: Array.isArray(location) ? location[0] : location ?? null,
    ...(json !== null ? { json: body } : { text: value.text }) };
}
export function namedHttpProjection(row, key) {
  return { name: row.name, response: namedWire(row.response, row.root, key), afterRead: namedWire(row.afterRead, row.root, key),
    live: row.live === null ? null : projectedConfiguration(row.live, key, row.root),
    events: row.events.map(event => ({ phase: event.phase, key: event.key, configuration: projectedConfiguration(event.configuration, key, row.root) })),
    disk: namedDiskProjection(row.disk, key, row.root) };
}
function pathFailure(step, root) {
  const message = step.error == null ? null : step.error.Message ?? step.error.message;
  // GetTranscodePath reports the actual conflicting marker. Bind that path
  // parameter only when the original physical tree proves this very file.
  const match = typeof message === 'string' ? /^Expected to find only \.jellyfin-transcode but found marker for (.+)\.$/u.exec(message) : null;
  const filename = match ? namedPath(match[1], root) : null;
  return step.step.action === 'get' && filename?.startsWith('@/')
    && step.state.tree.some(entry => !entry.directory && entry.path === filename.slice(2))
    ? `Expected to find only .jellyfin-transcode but found marker for ${filename}.` : message;
}
export function namedPathsProjection(row) {
  const projectState = state => ({ encoding: projectedConfiguration(state.encoding, 'encoding', row.root), metadata: namedValue(state.metadata, 'metadata'),
    cachePath: namedPath(state.cachePath, row.root), tree: state.tree });
  return { name: row.name, before: projectState(row.before),
    steps: row.steps.map(step => ({ step: step.step, accepted: step.accepted,
      result: step.step.action === 'get' ? namedPath(step.result, row.root) : step.result,
      error: pathFailure(step, row.root), state: projectState(step.state) })), after: projectState(row.after) };
}
// Preserve the existing finite NFO summary boundary; original XML bytes stay in
// the raw report and are consumed separately by actual typed Native readers.
export const namedNfoPhasesProjection = (rows, root) => rows.map(({ bytes: _bytes, ...row }) => ({ ...row,
  ...(row.nfo && typeof row.nfo === 'object' && Object.hasOwn(row.nfo, 'poster')
    ? { nfo: { ...row.nfo, poster: namedPath(row.nfo.poster, root) } } : {}),
}));

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
    const oracle = await compileOracle({ project, output: path.join(output, 'build') });
    report.oracleBuild = oracle.buildRecord;
    const observations = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label), record = await oracle.record({ output: directory,
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
      const directory = path.join(output, label), record = await oracle.record({ output: directory,
        args: ['consume', consumeInput, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      await verifyCapture(native, bytes, record, consumeBytes, build, true);
      return { input: await describeFile(consumeInput), record, observation: await describeFile(filename), native };
    } };
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), configurationJson(report), { flag: 'wx' }); }
}
