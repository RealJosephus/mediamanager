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
import { namedHash, namedError } from '../core/named-configuration-current.js';
import { networkConfigurationInput } from './fixtures/network-configuration-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const networkInput = networkConfigurationInput();
const fixture = new URL('./fixtures/network-configuration-current/', import.meta.url);
const project = fileURLToPath(new URL('Oracle.csproj', fixture));
let pending;
export const currentNetworkConfiguration = () => pending ??= capture();

async function capture() {
  const output = path.join(validationOutputRoot(), 'network-configuration-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const input = networkInput;
  const inputBytes = Buffer.from(configurationJson(input)), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const profile = JSON.parse(await readFile(new URL('profile.json', fixture), 'utf8'));
  const report = { schemaVersion: 1, identity: input.identity, scope: profile.scope, inputSha256: namedHash(inputBytes),
    inputs: [], sourceBindings: [], captures: [], phaseAcceptance: false, releaseAcceptance: false,
    exclusions: ['whole Native application boot and production dependency graph', 'Native EF/session/token services behind controlled gateways', 'real interface enumeration/binding, multicast and DNS outside specified input', 'media executors', 'Node unknown-XML preservation is a separate instance-retention contract'] };
  try {
    for (const name of ['Oracle.csproj', 'Program.cs', 'NetworkConsumers.cs', 'input.js', 'profile.json', 'node-cases.js', 'node-host.js']) {
      const description = await describeFile(fileURLToPath(new URL(name, fixture)));
      assert.equal(description.available, true, name); report.inputs.push(description);
    }
    for (const name of ['src/core/resources/configuration-model.json', 'src/core/named-configuration-store.js',
      'src/core/network-configuration.js', 'src/configuration.js', 'src/http/named-configuration-binding.js', 'src/network/network-service.js', 'src/network/http-request.js', 'src/network/startup.js',
      'src/http/configuration-routes.js', 'src/http/startup-routes.js', 'src/users/startup-service.js',
      'src/users/authentication-service.js', 'tests/network/network-configuration-current.js', 'tests/network/network-configuration-native.test.js']) report.inputs.push(await describeFile(path.resolve(name)));
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
    const verify = async (native, bytes, record, requestedBytes, consume = false) => {
      assert.equal(native.inputSha256, namedHash(requestedBytes));
      assert.equal(record.outputs.find(row => path.basename(row.filename) === 'native.json')?.sha256, namedHash(bytes));
      for (const assembly of native.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
      for (const name of consume ? ['Emby.Server.Implementations', 'MediaBrowser.Model'] : ['Emby.Server.Implementations', 'MediaBrowser.Model', 'MediaBrowser.Common', 'Jellyfin.Networking', 'Jellyfin.Api', 'jellyfin']) {
        const assembly = native.assemblies.find(row => row.name === name); assert.ok(assembly, name);
        assert.equal(assembly.sha256, (await describeFile(path.join(build.runtime, name + '.dll'))).sha256, name);
      }
      if (!consume) for (const name of ['core', 'http', 'policies', 'urls', 'startup']) {
        assert.deepEqual(native[name].map(row => row.name), input[name].map(row => row.name), name + ': actual declared cases');
      }
    };
    const captures = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label), record = await recordOracle({ project, output: directory, args: [inputFile, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString());
      await verify(native, bytes, record, inputBytes);
      report.captures.push({ label, record, observation: await describeFile(filename) }); captures.push(native);
    }
    for (const description of report.inputs) assert.equal((await describeFile(description.filename)).sha256, description.sha256, description.filename);
    assert.equal(namedHash(await readFile(inputFile)), namedHash(inputBytes));
    return { input, native: captures[0], repeat: captures[1], output, report, async consume(rows, label) {
      const filename = path.join(output, label + '-input.json'), bytes = Buffer.from(configurationJson(rows)); await writeFile(filename, bytes, { flag: 'wx' });
      const record = await recordOracle({ project, output: path.join(output, label), args: ['consume', filename, '{output}/native.json'] });
      const resultFile = path.join(output, label, 'native.json'), resultBytes = await readFile(resultFile), native = parseLosslessJson(resultBytes.toString());
      await verify(native, resultBytes, record, bytes, true);
      return { input: await describeFile(filename), record, observation: await describeFile(resultFile), native };
    } };
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), configurationJson(report), { flag: 'wx' }); }
}
