import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { namedError, namedHash } from '../core/named-configuration-current.js';
import { networkListenerInput } from './fixtures/network-listener-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const listenerInput = networkListenerInput();
const fixture = new URL('./fixtures/network-listener-current/', import.meta.url);
const project = fileURLToPath(new URL('Oracle.csproj', fixture));
let pending;
export const currentNetworkListeners = ({ signal } = {}) => pending ??= capture(signal);

async function capture(signal) {
  const output = path.join(validationOutputRoot(), 'network-listener-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const input = listenerInput, bytes = Buffer.from(configurationJson(input)), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, bytes, { flag: 'wx' });
  const profile = JSON.parse(await readFile(new URL('profile.json', fixture), 'utf8'));
  const report = { schemaVersion: 1, identity: input.identity, scope: profile.scope, partialLimitations: profile.partialLimitations,
    input: await describeFile(inputFile), inputSha256: namedHash(bytes), inputs: [], sourceBindings: [], captures: [],
    phaseAcceptance: false, releaseAcceptance: false, nodeProductionConformance: false };
  try {
    for (const name of ['Oracle.csproj', 'Program.cs', 'HostCases.cs', 'Certificates.cs', 'input.js', 'profile.json']) report.inputs.push(await describeFile(fileURLToPath(new URL(name, fixture))));
    for (const name of ['tests/network/network-listener-current.js', 'tests/network/network-listener-native.test.js',
      'tests/playback/fixtures/localhost-tls.crt', 'tests/playback/fixtures/localhost-tls.key']) report.inputs.push(await describeFile(path.resolve(name)));
    for (const source of report.inputs) assert.equal(source.available, true, source.filename);
    // Seal declared input/source identities before any producer creates new certs.
    await writeFile(path.join(output, 'input-source-seal.json'), configurationJson(report), { flag: 'wx' });
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const entry = manifest.files.find(row => row.path === relative); assert.ok(entry, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.available, true, relative); assert.equal(source.sha256, entry.sha256, relative);
      report.sourceBindings.push({ relative, source });
    }
    await writeFile(path.join(output, 'native-source-seal.json'), configurationJson({ build: report.build, sourceBindings: report.sourceBindings }), { flag: 'wx' });
    const verify = async (payload, raw, record, filename, prepare) => {
      assert.equal(payload.result.inputSha256, namedHash(bytes));
      assert.equal(record.outputs.find(row => row.filename === filename)?.sha256, namedHash(raw));
      for (const assembly of payload.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
      if (!prepare) for (const name of ['Emby.Server.Implementations', 'MediaBrowser.Model', 'MediaBrowser.Common', 'Jellyfin.Networking', 'Jellyfin.Api', 'jellyfin']) {
        const assembly = payload.assemblies.find(row => row.name === name); assert.ok(assembly, name);
        assert.equal(assembly.sha256, (await describeFile(path.join(build.runtime, name + '.dll'))).sha256, name);
      }
    };
    const directory = path.join(output, 'prepare');
    signal?.throwIfAborted();
    const record = await recordOracle({ project, output: directory, args: ['prepare', inputFile, '{output}/prepared.json',
      path.resolve('tests/playback/fixtures/localhost-tls.crt'), path.resolve('tests/playback/fixtures/localhost-tls.key')] });
    const preparedFile = path.join(directory, 'prepared.json'), preparedRaw = await readFile(preparedFile), payload = parseLosslessJson(preparedRaw.toString());
    await verify(payload, preparedRaw, record, preparedFile, true);
    const preparedCertificates = payload.result;
    const material = [preparedCertificates.originalPem.certificate, preparedCertificates.originalPem.key, preparedCertificates.bad,
      ...['a', 'b', 'certificateOnly'].flatMap(name => [preparedCertificates[name].file, preparedCertificates[name].certificate])];
    for (const file of material) {
      const actual = await describeFile(file.filename); assert.equal(actual.available, true); assert.equal(actual.sha256, file.sha256, file.filename); assert.equal(actual.bytes, file.size, file.filename);
    }
    report.prepare = { record, observation: await describeFile(preparedFile), material };
    await writeFile(path.join(output, 'prepared-material-seal.json'), configurationJson(report.prepare), { flag: 'wx' });
    const captures = [];
    for (const label of ['initial', 'repeat']) {
      signal?.throwIfAborted();
      const directory = path.join(output, label), record = await recordOracle({ project, output: directory, args: [inputFile, preparedFile, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), raw = await readFile(filename), payload = parseLosslessJson(raw.toString());
      await verify(payload, raw, record, filename, false);
      assert.equal(payload.result.preparedSha256, namedHash(preparedRaw));
      assert.deepEqual(payload.result.cases.map(row => row.name), [...input.listeners, ...input.effects].map(row => row.name));
      for (const file of payload.result.preparedFiles) assert.equal((await describeFile(file.filename)).sha256, file.sha256, file.filename);
      captures.push(payload.result); report.captures.push({ label, record, observation: await describeFile(filename) });
    }
    for (const file of material) assert.equal((await describeFile(file.filename)).sha256, file.sha256, file.filename);
    for (const source of report.inputs) assert.equal((await describeFile(source.filename)).sha256, source.sha256, source.filename);
    assert.equal(namedHash(await readFile(inputFile)), namedHash(bytes));
    assert.equal(namedHash(await readFile(preparedFile)), namedHash(preparedRaw));
    return { input, preparedCertificates, native: captures[0], repeat: captures[1], report, output };
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), configurationJson(report), { flag: 'wx' }); }
}
