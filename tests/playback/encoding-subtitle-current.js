import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationExecutable, validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { encodingSubtitleInput } from './fixtures/encoding-subtitle-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const subtitleInput = encodingSubtitleInput();
export const subtitleHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const subtitleFailure = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(subtitleFailure)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'code', 'status', 'statusCode', 'stack', 'cause', 'errors'] : [])])]
    .map(name => [name, subtitleFailure(value[name])]));
export const subtitleFailurePayload = error => error == null ? null : typeof error !== 'object' ? error : { message: error.message, code: error.code ?? null,
  status: error.status ?? null, statusCode: error.statusCode ?? null, cause: subtitleFailurePayload(error.cause),
  errors: error.errors == null ? null : Array.from(error.errors, subtitleFailurePayload) };
export const subtitleJson = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n';
const fixture = new URL('./fixtures/encoding-subtitle-current/', import.meta.url);
let pending;
export const currentSubtitleConfiguration = () => pending ??= capture();

async function capture() {
  const output = path.join(validationOutputRoot(), 'encoding-subtitle-current-' + randomUUID()); assertValidationOutputChild(output); await mkdir(output);
  const input = path.join(output, 'input.json'), inputBytes = Buffer.from(subtitleJson(subtitleInput)); await writeFile(input, inputBytes, { flag: 'wx' });
  const profile = JSON.parse(await readFile(new URL('profile.json', fixture), 'utf8'));
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    phaseAcceptance: false, releaseAcceptance: false, nativeExecutionRecorded: false };
  try {
    for (const name of ['Oracle.csproj', 'Program.cs', 'input.js', 'profile.json']) report.inputs.push(await describeFile(fileURLToPath(new URL(name, fixture))));
    for (const relative of ['tests/playback/fixtures/extraction-reference.json', 'tests/playback/encoding-subtitle-current.js',
      'tests/playback/encoding-subtitle-current-native.test.js', 'src/playback/profile.js', 'src/playback/service.js',
      'src/playback/extraction.js', 'src/storage/probe-bridge.js']) report.inputs.push(await describeFile(path.resolve(relative)));
    const build = await verifyNativeBuild(); report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(file => file.path === relative); assert.ok(expected, relative);
      const actual = await describeFile(path.join(build.root, 'source', relative)); assert.equal(actual.available, true, relative); assert.equal(actual.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, actual });
    }
    const executable = validationExecutable('ffmpeg'), ffmpeg = await describeFile(executable); assert.equal(ffmpeg.available, true); report.ffmpeg = ffmpeg;
    const observations = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label), record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', fixture)),
        output: directory, args: [input, '{output}/native.json', executable] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(native.inputSha256, subtitleHash(inputBytes)); assert.equal(native.ffmpeg.sha256, ffmpeg.sha256);
      assert.equal((await describeFile(native.fixtureLauncher.filename)).sha256, native.fixtureLauncher.sha256);
      assert.equal(record.outputs.find(file => file.filename === filename)?.sha256, subtitleHash(bytes));
      for (const flag of ['actualNamedManager', 'actualMediaEncoderCapability', 'actualStreamBuilder', 'actualSubtitleEncoder',
        'actualCopyExecutor', 'actualExceptionMiddleware', 'helperAndPublicBoundariesSeparate', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true, flag);
      assert.equal(native.productionControllerExecuted, false);
      assert.deepEqual(native.profiles.map(row => row.name), subtitleInput.profiles.map(row => row.name));
      assert.deepEqual(native.extractions.map(row => [row.name, row.boundary]), subtitleInput.timeout.flatMap(row => [[row.name, 'helper'], [row.name, 'public']]));
      for (const assembly of native.assemblies) {
        assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
        assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
      }
      observations.push(native);
    }
    for (const item of report.inputs) { assert.equal(item.available, true); assert.equal((await describeFile(item.filename)).sha256, item.sha256); }
    assert.equal(subtitleHash(await readFile(input)), subtitleHash(inputBytes)); report.nativeExecutionRecorded = true;
    return { native: observations[0], repeat: observations[1], output, report };
  } catch (error) { report.failure = subtitleFailure(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), subtitleJson(report), { flag: 'wx' }); }
}
