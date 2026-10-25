import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const profileUrl = new URL('./fixtures/quick-connect-current/current-profile.json', import.meta.url);
export const quickConnectInput = JSON.parse(await readFile(new URL('input.json', profileUrl), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

function publicValue(value, observation) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'Secret' in value && 'Code' in value && 'DateAdded' in value) {
    assert.match(value.Secret, /^[0-9A-F]{64}$/u);
    assert.match(value.Code, /^[1-9][0-9]{5}$/u);
    assert.equal(value.Secret, observation.issued.Secret);
    assert.equal(value.Code, observation.issued.Code);
    const started = Date.parse(observation.started), finished = Date.parse(observation.finished), date = Date.parse(value.DateAdded);
    const offset = observation.dateOffsetMs ?? (date - started > 30_000 ? 60_000 : 0);
    assert.ok(date >= started + offset - 1 && date <= finished + offset + 1,
      `DateAdded ${value.DateAdded} must bind its actual creation, authorization or prepared expiry window`);
    return { ...value, Secret: '<secret>', Code: '<code>', DateAdded: `<window:${offset}>` };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'traceId')) {
    assert.equal(typeof value.traceId, 'string'); assert.ok(value.traceId.length > 0);
    return { ...value, traceId: '<trace>' };
  }
  return value;
}

function responseValue(response, observation) {
  return { status: response.status, contentType: response.contentType,
    allow: [...new Set(response.allow.split(',').map(value => value.trim()).filter(Boolean))].sort(), hasJson: response.hasJson,
    ...(response.hasJson ? { json: publicValue(response.json, observation) } : { body: response.body }) };
}

export function quickConnectObservation(observation) {
  assert.deepEqual(observation.callsAfterRead, observation.calls, 'polling and repeated redemption do not authenticate again');
  return { name: observation.name,
    ...(observation.response && { response: responseValue(observation.response, observation) }),
    followUp: observation.followUp.map(({ operation, response }) => ({ operation, response: responseValue(response, observation) })),
    calls: observation.calls, callsAfterRead: observation.callsAfterRead };
}

export function directAuthenticationObservation({ name, status, session, deviceCount, oldTokenRetained, loginUnchanged, InvalidLoginAttemptCount }) {
  return { name, status, session, deviceCount, oldTokenRetained, loginUnchanged, InvalidLoginAttemptCount };
}

let pending;
export const currentQuickConnect = () => pending ??= capture();

async function capture() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  const output = path.join(validationOutputRoot(), 'quick-connect-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    nativeExecutionRecorded: false, independentRepeatAgrees: false, actualNativeInstance: false,
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
      assert.equal(actual.available, true, expected.filename);
      assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename);
      report.inputs.push({ role: expected.role, ...actual });
    }
    for (const [field, count] of Object.entries(profile.cases)) {
      assert.equal(quickConnectInput[field].length, count, field);
      assert.equal(new Set(quickConnectInput[field].map(value => typeof value === 'string' ? value : value.name)).size, count, field);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = manifest.files.find(entry => entry.path === relative); assert.ok(pinned, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const inputBytes = await readFile(new URL('input.json', profileUrl)), inputFilename = path.join(output, 'consumer-input.json');
    await writeFile(inputFilename, inputBytes, { flag: 'wx' }); report.consumerInput = await describeFile(inputFilename);
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
    const natives = [];
    for (let iteration = 1; iteration <= 2; iteration++) {
      const directory = path.join(output, 'native-' + iteration);
      const record = await recordOracle({ project, output: directory, args: [inputFilename, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ iteration, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(inputBytes));
      for (const field of ['actualExecution', 'actualManager', 'actualControllers', 'actualBinding', 'actualDefaultAuthorization',
        'sessionManagerControlled', 'principalControlled']) assert.equal(native[field], true, field);
      assert.equal(native.actualNativeInstance, false);
      for (const assembly of native.assemblies) {
        const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.name);
      }
      assert.deepEqual(native.results.map(value => value.name), quickConnectInput.httpCases.map(value => value.name));
      assert.deepEqual(native.expiryResults.map(value => value.name), quickConnectInput.expiryCases.map(value => value.name));
      assert.deepEqual(native.directResults.map(value => value.name), quickConnectInput.directCases);
      natives.push(native);
    }
    const values = native => ({ http: native.results.map(quickConnectObservation), expiry: native.expiryResults.map(quickConnectObservation),
      direct: native.directResults.map(directAuthenticationObservation) });
    const first = values(natives[0]), repeat = values(natives[1]);
    await writeFile(path.join(output, 'native-comparison.json'), json({ first, repeat }), { flag: 'wx' });
    assert.deepEqual(repeat, first, 'independent current Native executions agree on public results and authorization effects');
    report.nativeExecutionRecorded = true; report.independentRepeatAgrees = true;
    const comparisons = [];
    const recordComparison = async value => {
      comparisons.push(value); await writeFile(path.join(output, 'candidate-comparison.json'), json(comparisons));
    };
    return { input: quickConnectInput, native: natives[0], repeat: natives[1], output, report, recordComparison };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
