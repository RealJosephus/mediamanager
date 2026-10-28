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
import { mediaEncoderInput } from './fixtures/media-encoder-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const encoderInput = mediaEncoderInput();
export const encoderHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const encoderFailure = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(encoderFailure)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'code', 'status', 'statusCode', 'stack', 'cause', 'errors'] : [])])]
    .map(name => [name, encoderFailure(value[name])]));
export const encoderFailurePayload = value => {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(encoderFailurePayload);
  const error = value instanceof Error;
  const names = [...new Set([...Object.getOwnPropertyNames(value), ...(error ? ['message', 'code', 'status', 'statusCode', 'cause', 'errors'] : [])])];
  return Object.fromEntries(names.filter(name => !error || !['name', 'stack'].includes(name)).map(name => [name, encoderFailurePayload(value[name])]));
};
export const encoderJson = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n';
const fixture = new URL('./fixtures/media-encoder-current/', import.meta.url);
let pending;
export const currentMediaEncoder = () => pending ??= capture();

async function capture() {
  const output = path.join(validationOutputRoot(), 'media-encoder-current-' + randomUUID()); assertValidationOutputChild(output); await mkdir(output);
  const input = path.join(output, 'input.json'), inputBytes = Buffer.from(encoderJson(encoderInput)); await writeFile(input, inputBytes, { flag: 'wx' });
  const profile = JSON.parse(await readFile(new URL('profile.json', fixture), 'utf8'));
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [], nativeExecutionRecorded: false,
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const name of ['Oracle.csproj', 'Program.cs', 'input.js', 'profile.json']) report.inputs.push(await describeFile(fileURLToPath(new URL(name, fixture))));
    for (const relative of ['tests/playback/fixtures/extraction-reference.json', 'tests/playback/fixtures/hls-reference.json',
      'tests/playback/media-encoder-current.js', 'tests/playback/media-encoder-current-native.test.js', 'src/playback/media-encoder.js',
      'src/storage/ffprobe.js', 'src/playback/extraction.js', 'src/playback/remux.js', 'src/playback/hls.js']) report.inputs.push(await describeFile(path.resolve(relative)));
    const build = await verifyNativeBuild(); report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(file => file.path === relative); assert.ok(expected, relative);
      const actual = await describeFile(path.join(build.root, 'source', relative)); assert.equal(actual.available, true, relative); assert.equal(actual.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, actual });
    }
    const executables = { ffmpeg: validationExecutable('ffmpeg'), ffprobe: validationExecutable('ffprobe') };
    report.ffmpeg = await describeFile(executables.ffmpeg); report.ffprobe = await describeFile(executables.ffprobe);
    const observations = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label), record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', fixture)), output: directory,
        args: [input, '{output}/native.json', executables.ffmpeg, executables.ffprobe] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(native.inputSha256, encoderHash(inputBytes));
      assert.equal(native.ffmpeg.sha256, report.ffmpeg.sha256); assert.equal(native.ffprobe.sha256, report.ffprobe.sha256);
      assert.equal((await describeFile(native.launcher.filename)).sha256, native.launcher.sha256);
      assert.equal(record.outputs.find(file => file.filename === filename)?.sha256, encoderHash(bytes));
      for (const flag of ['actualSetFFmpegPath', 'actualValidator', 'actualManager', 'actualSerializer', 'actualGetMediaInfo', 'actualStreamingQueryBinding', 'bindingActionShortCircuited',
        'actualSubtitlePublicMethod', 'actualHlsCommandBuilder', 'capabilityProcessesBlocked', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true, flag);
      assert.equal(native.productionControllersExecuted, false);
      assert.deepEqual(native.results.map(row => row.name), encoderInput.cases.map(row => row.name));
      for (const assembly of native.assemblies) {
        assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
        assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
      }
      observations.push(native);
    }
    for (const item of report.inputs) { assert.equal(item.available, true); assert.equal((await describeFile(item.filename)).sha256, item.sha256); }
    assert.equal(encoderHash(await readFile(input)), encoderHash(inputBytes)); report.nativeExecutionRecorded = true;
    return { native: observations[0], repeat: observations[1], output, report };
  } catch (error) { report.failure = encoderFailure(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), encoderJson(report), { flag: 'wx' }); }
}
