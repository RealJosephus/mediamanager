import assert from 'node:assert/strict';
import { createHash, pbkdf2, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPasswordHash, parsePasswordHash, serializePasswordHash } from '../../src/core/password.js';
import { parseLosslessJson, stringifyNativeJson, withNativeFloats } from '../../src/core/json.js';
import { parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { ScheduledTaskFileStore } from '../../src/tasks/scheduled-task-store.js';
import { serializePlaylistFile } from '../../src/library/playlist-file.js';
import { convertSubtitle } from '../../src/playback/subtitles.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const profileUrl = new URL('./fixtures/readers/current-profile.json', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const derive = promisify(pbkdf2);
const errorObservation = error => ({ name: error.name, message: error.message, status: error.status ?? null });
export const taskId = '97230000000000000000000000000001';

export function publicJsonBoundary() {
  return withNativeFloats({ Value: 1.00000006, NegativeZero: -0, NegativeDoubleZero: -0,
    MinTicks: -(2n ** 63n), MaxTicks: 2n ** 63n - 1n, Date: '2026-10-11T01:02:03.1234567Z', Missing: null,
    Dictionary: new Map([['Null', null], ['Tmdb', '123']]), Values: [null, '\uD800'],
    InvalidKey: new Map([['\uD800', '\uD800']]) }, ['Value', 'NegativeZero']);
}

export function subtitleObservation(text, format) {
  try {
    return { json: convertSubtitle(text, format, 'json', { copyTimestamps: true }),
      rewritten: convertSubtitle(text, format, format, { copyTimestamps: true }), error: null };
  } catch (error) { return { json: null, rewritten: null, error: errorObservation(error) }; }
}

export function functionalSubtitle(observation) {
  return { failed: Boolean(observation.error), cues: observation.json == null ? null
    : parseLosslessJson(observation.json).TrackEvents.map(cue => ({ ...cue, Text: cue.Text.replace(/\r\n|\r/gu, '\n') })) };
}

export function configurationValues(value) {
  return Object.fromEntries(['ServerName', 'UICulture', 'MetadataCountryCode', 'ContentTypes'].map(name => [name, value[name]]));
}

async function prepareCandidate(input, writerInput, output) {
  const root = path.join(output, 'candidate');
  await mkdir(root);
  const candidate = { passwords: [], tasks: [], configurations: [], playlists: [], subtitles: [],
    jsonBoundary: stringifyNativeJson(publicJsonBoundary()) };
  for (const sample of input.passwords) {
    let hash;
    if (sample.name === 'node-csprng') hash = await createPasswordHash(sample.password);
    else {
      const { id, salt, parameters } = parsePasswordHash(sample.hash);
      hash = serializePasswordHash({ id, salt, parameters,
        hash: await derive(sample.password, salt, Number(parameters.get('iterations')), 64, 'sha512') });
    }
    candidate.passwords.push({ name: sample.name, password: sample.password, hash });
  }
  const taskStore = new ScheduledTaskFileStore({ taskId, programDataPath: path.join(root, 'tasks/data'),
    configurationDirectoryPath: path.join(root, 'tasks/config') });
  try {
    for (const sample of input.tasks) {
      const value = parseLosslessJson(sample.text), triggers = sample.kind === 'triggers';
      await taskStore[triggers ? 'saveTriggers' : 'saveHistory'](value);
      const filename = triggers ? taskStore.configurationPath : taskStore.historyPath;
      candidate.tasks.push({ name: sample.name, kind: sample.kind, filename, text: await readFile(filename, 'utf8') });
    }
  } finally { await taskStore.close(); }
  const configurationDirectory = path.join(root, 'configuration');
  await mkdir(configurationDirectory);
  const filename = path.join(configurationDirectory, 'system.xml');
  await writeFile(filename, input.configurations[0].xml, { flag: 'wx' });
  const configuration = parseConfigurationXml(Buffer.from(input.configurations[0].xml), 'server');
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: configurationDirectory });
  try { await store.updateContentTypes(() => input.contentTypes); }
  finally { await store.close(); }
  candidate.configurations.push(input.configurations[0], { name: input.configurations[1].name, filename,
    xml: await readFile(filename, 'utf8') });
  for (const sample of input.playlists) {
    const extension = path.extname(sample.path);
    const playlistPath = writerInput.playlistRoot + '\\lists\\node' + extension;
    const children = writerInput.children.map(item => ({ ...item, Path: writerInput.playlistRoot + '\\' + item.Path,
      RunTimeTicks: BigInt(item.RunTimeTicks) }));
    let text = serializePlaylistFile(playlistPath, writerInput.links.map(index => children[index]), { windows: true }).toString('utf8');
    if (sample.name.includes('reordered')) text = text.replace(/<media ([^>]+) \/>/gu, (_, attributes) =>
      '<media ' + attributes.match(/[A-Za-z]+="[^"]*"/gu).reverse().join(' ') + ' />');
    if (sample.name.endsWith('bom-lf')) text = '\uFEFF' + text.replaceAll('\r\n', '\n');
    candidate.playlists.push({ name: sample.name, path: sample.path, bytes: Buffer.from(text).toString('base64') });
  }
  for (const sample of input.subtitles) candidate.subtitles.push({ name: sample.name, format: sample.format,
    originalName: sample.originalName, ...subtitleObservation(sample.text, sample.format) });
  return candidate;
}

let pending;
export const currentReaders = () => pending ??= captureCurrentReaders();

async function captureCurrentReaders() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  assert.equal(profile.schemaVersion, 1);
  const output = path.join(validationOutputRoot(), 'consumer-readers-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [],
    nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
      assert.equal(actual.available, true, expected.filename);
      assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename);
      report.inputs.push({ role: expected.role, ...actual });
    }
    const readInput = async role => JSON.parse(await readFile(new URL(profile.inputs.find(entry => entry.role === role).filename, profileUrl), 'utf8'));
    const input = await readInput('scenarios'), writerInput = await readInput('writerScenarios');
    for (const [kind, count] of Object.entries(profile.cases)) {
      assert.equal(input[kind].length, count, kind);
      assert.equal(new Set(input[kind].map(sample => sample.name)).size, count, kind + ' distinct names');
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relative);
      assert.ok(pinned, 'The designated source offer must include ' + relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const candidate = await prepareCandidate(input, writerInput, output);
    const observations = { input, candidate };
    const inputFile = path.join(output, 'consumer-input.json'), bytes = Buffer.from(JSON.stringify(observations, null, 2) + '\n');
    await writeFile(inputFile, bytes, { flag: 'wx' });
    report.consumerInput = await describeFile(inputFile);
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
    const directory = path.join(output, 'native');
    const record = await recordOracle({ project, output: directory, args: [inputFile, '{output}/native.json'] });
    const nativeFile = path.join(directory, 'native.json'), nativeBytes = await readFile(nativeFile), native = JSON.parse(nativeBytes);
    report.capture = { record, observation: await describeFile(nativeFile) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === nativeFile)?.sha256, sha256(nativeBytes));
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha256(bytes));
    for (const assembly of native.assemblies) {
      const bound = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(bound.available, true, assembly.name); assert.equal(bound.sha256, assembly.sha256, assembly.name);
    }
    for (const kind of ['passwords', 'tasks', 'configurations', 'playlists', 'subtitles']) {
      assert.deepEqual(native[kind].map(result => result.name), candidate[kind].map(sample => sample.name), kind);
    }
    report.nativeExecutionRecorded = true;
    const recordCandidate = async (label, values) => {
      assert.match(label, /^[a-zA-Z0-9_.-]+$/u);
      await writeFile(path.join(output, 'candidate-' + label + '.json'), JSON.stringify(values,
        (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
    };
    return { input, writerInput, candidate, native, output, report, recordCandidate };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}
