import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { nativeSourcePaths } from './input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const subtitleSourceBytes = source => typeof source.base64 === 'string' ? Buffer.from(source.base64, 'base64') : Buffer.from(source.text);
export const json = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
export const errorValue = error => error == null || typeof error !== 'object' ? error : Array.isArray(error) ? error.map(errorValue)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), ...(error instanceof Error ? ['name', 'message', 'code', 'status', 'cause', 'errors', 'stack'] : [])])]
    .map(key => [key, errorValue(error[key])]));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

export async function captureSubtitleText(output, scenarios, candidate, { signal, fixtureFiles = [] } = {}) {
  const report = { schemaVersion: 1, scope: 'Current designated ISubtitleEncoder.GetSubtitles, actual SubtitleEdit readers and writers, independent repeat and actual Node HTTP body reads.',
    inputs: [], sourceBindings: [], captures: [], actualNativeExecuted: false, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  let primary;
  try {
    signal?.throwIfAborted();
    for (const name of ['Program.cs', 'Oracle.csproj', 'input.js', 'capture.js', '.gitattributes', 'README.md']) {
      report.inputs.push({ role: 'current-fixture-source', actual: await describeFile(fileURLToPath(new URL(name, import.meta.url))) });
    }
    for (const filename of fixtureFiles) report.inputs.push({ role: 'current-consumer-scenario-source',
      actual: await describeFile(filename instanceof URL ? fileURLToPath(filename) : filename) });
    report.inputs.push({ role: 'unchanged-legacy-input-and-observation', actual: await describeFile(fileURLToPath(new URL('../subtitle-ass-reference.json', import.meta.url))) });
    const build = await verifyNativeBuild();
    report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await fs.readFile(path.join(build.sourceOfferRoot, 'jellyfin-source-manifest.json')));
    for (const relative of nativeSourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const actual = await describeFile(path.join(build.sourceRoot, relative));
      assert.equal(actual.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, expected, actual });
    }
    const input = path.join(output, 'native-input.json'), bytes = Buffer.from(json({ ...scenarios, candidate }));
    await fs.writeFile(input, bytes, { flag: 'wx' }); report.input = await describeFile(input);
    const executions = [];
    for (const label of ['initial', 'repeat']) {
      signal?.throwIfAborted();
      const directory = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', import.meta.url)), output: directory,
        args: [input, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), native = JSON.parse(await fs.readFile(filename));
      report.captures.push({ label, record, observation: await describeFile(filename), pid: native.pid, processAliveAfter: alive(native.pid) });
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, hash(bytes));
      assert.equal(native.inputHostClosed, true, 'The actual Native text-input HTTP host stopped.');
      assert.equal(native.inputClientsClosed, true, 'The actual Native input HTTP client closed.');
      assert.equal(native.errorEnvironment, 'Production');
      const completed = new Set(native.completedRequests);
      for (const request of native.sourceRequests) {
        const source = scenarios.sources.find(source => '/' + source.name + '.' + source.format === request.path);
        assert.ok(source, request.path); const original = subtitleSourceBytes(source);
        assert.equal(request.sha256, hash(original));
        assert.equal(request.bytes, original.length); assert.ok(completed.has(request.requestId), 'The actual Native text input response drained.');
      }
      assert.equal(report.captures.at(-1).processAliveAfter, false, 'The actual Native text consumer process exited.');
      for (const assembly of native.assemblies) assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
      assert.deepEqual(native.conversions.map(row => row.name), scenarios.conversions.map(row => row.name));
      for (const source of scenarios.sources) {
        const original = subtitleSourceBytes(source), before = native.sources.find(row => row.name === source.name), after = native.sourceAfter.find(row => row.name === source.name);
        assert.equal(before.bytes, original.length); assert.equal(before.sha256, hash(original)); assert.equal(after.sha256, hash(original));
      }
      executions.push(native);
    }
    const records = rows => rows.map(row => ({ name: row.name, generation: row.generation, format: row.format,
      bytes: row.bytes, sha256: row.sha256, text: row.text, contentType: row.contentType, wire: row.wire, readerJson: row.readerJson,
      textConsumerApplicable: row.textConsumerApplicable, status: row.status,
      failed: Boolean(row.error), readerFailed: Boolean(row.readerError) }));
    assert.deepEqual(records(executions[0].conversions), records(executions[1].conversions), 'Independent Native conversion, text, timing, markup and reader observations.');
    assert.deepEqual(records(executions[0].originals), records(executions[1].originals), 'Independent Native original subtitle delivery.');
    assert.deepEqual(records(executions[0].candidateReaders), records(executions[1].candidateReaders), 'Independent actual Native reads of all current Node HTTP bodies.');
    report.actualNativeExecuted = true;
    return { first: executions[0], repeat: executions[1], report };
  } catch (error) { primary = error; report.failure = errorValue(error); throw error; }
  finally {
    try { await fs.writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
    catch (error) { if (primary) throw new AggregateError([primary, error], 'Subtitle capture and observation persistence failed.', { cause: primary }); throw error; }
  }
}
