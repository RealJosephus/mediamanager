import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDataBindingCases } from '../../tests/sessions/user-data-binding-cases.js';
import { verifyBaseline } from './verify-baseline.js';
import { assertIsolatedOutput } from '../validation/paths.js';
import { parseLosslessJson } from '../../src/core/json.js';

const [dotnetArgument, assemblyArgument, manifestArgument, outputArgument, mode = 'user-data'] = process.argv.slice(2);
if (!outputArgument || !['user-data', 'syncplay'].includes(mode)) throw new Error('Usage: record-user-data-date-environment DOTNET ASSEMBLY_DIRECTORY BASELINE_MANIFEST NEW_OUTPUT_DIRECTORY [user-data|syncplay]');
const prefix = mode === 'syncplay' ? 'syncplay-date-taipei' : 'runtime-date-taipei';
const dotnet = path.resolve(dotnetArgument), assemblies = path.resolve(assemblyArgument), manifest = path.resolve(manifestArgument);
const output = path.resolve(outputArgument), project = fileURLToPath(new URL('./user-data-date-oracle/', import.meta.url));
const verifiedBefore = await verifyBaseline(manifest);
assertIsolatedOutput(output, { ...process.env, MEDIAMANAGER_JELLYFIN_SOURCE: verifiedBefore.source,
  MEDIAMANAGER_TEST_NATIVE_INSTANCE: assemblies });
const hash = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
const identityBefore = { manifestSha256: await hash(manifest),
  extensionsSha256: await hash(path.join(assemblies, 'Jellyfin.Extensions.dll')),
  modelSha256: await hash(path.join(assemblies, 'MediaBrowser.Model.dll')),
  ...(mode === 'syncplay' ? { apiSha256: await hash(path.join(assemblies, 'Jellyfin.Api.dll')) } : {}) };
await mkdir(output);
const environment = { ...process.env, DOTNET_ROOT: path.dirname(dotnet) };
const execute = async (args, name, input) => {
  const result = spawnSync(dotnet, args, { windowsHide: true, encoding: 'utf8', env: environment,
    ...(input ? { input } : {}), maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  await writeFile(path.join(output, `${name}.stdout.log`), result.stdout ?? '');
  await writeFile(path.join(output, `${name}.stderr.log`), result.stderr ?? '');
  assert.equal(result.status, 0, `${name}: ${result.stderr ?? result.error?.message}`);
  return result.stdout;
};
await execute(['build', path.join(project, 'UserDataDateOracle.csproj'), '-c', 'Release',
  `-p:BaseIntermediateOutputPath=${path.join(output, 'obj')}${path.sep}`,
  `-p:MSBuildProjectExtensionsPath=${path.join(output, 'obj')}${path.sep}`, '-o', path.join(output, 'oracle')], 'build');
const syncplayInput = fileURLToPath(new URL('../../tests/sessions/fixtures/syncplay/binding-reference.json', import.meta.url));
const cases = mode === 'syncplay' ? parseLosslessJson(await readFile(syncplayInput, 'utf8')).map(entry => entry.input)
  : userDataBindingCases().filter(entry => ['date-295', 'date-296'].includes(entry.name));
assert.equal(cases.length, mode === 'syncplay' ? 114 : 2);
const stdout = await execute([path.join(output, 'oracle/UserDataDateOracle.dll'), assemblies, mode], 'native',
  cases.map(entry => mode === 'syncplay' ? JSON.stringify(entry) : entry.source).join('\n') + '\n');
const [nativeEnvironment, ...native] = stdout.trim().split(/\r?\n/).map(line => parseLosslessJson(line.replace(/^\uFEFF/, '')));
assert.equal(nativeEnvironment.type, 'environment');
assert.equal(native.length, cases.length);
assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Taipei', 'This recorder currently covers the Taipei local environment.');
assert.ok(['Taipei Standard Time', 'Asia/Taipei'].includes(nativeEnvironment.timezoneId), 'Native local timezone must also be Taipei.');
for (const assembly of nativeEnvironment.assemblies) assert.equal(assembly.sha256,
  await hash(path.join(assemblies, `${assembly.name}.dll`)), assembly.name);
for (let index = 0; index < cases.length; index++) {
  if (mode === 'syncplay') assert.deepEqual(native[index].input, cases[index]);
  else assert.equal(native[index].source, cases[index].source);
}
const fixture = { schemaVersion: 1, environment: { nodeTimezone: 'Asia/Taipei', native: nativeEnvironment },
  cases: cases.map((entry, index) => mode === 'syncplay' ? { input: entry, result: native[index].result }
    : { ...entry, expected: native[index].value }) };
const serialize = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
await writeFile(path.join(output, `${prefix}.json`), serialize(fixture));
const verifiedAfter = await verifyBaseline(manifest);
const identityAfter = { manifestSha256: await hash(manifest),
  extensionsSha256: await hash(path.join(assemblies, 'Jellyfin.Extensions.dll')),
  modelSha256: await hash(path.join(assemblies, 'MediaBrowser.Model.dll')),
  ...(mode === 'syncplay' ? { apiSha256: await hash(path.join(assemblies, 'Jellyfin.Api.dll')) } : {}) };
assert.deepEqual(identityAfter, identityBefore);
assert.deepEqual(verifiedAfter, verifiedBefore);
await writeFile(path.join(output, `${prefix}-provenance.json`), serialize({ schemaVersion: 1,
  recordedAt: new Date().toISOString(), sourceBoundary: mode === 'syncplay'
    ? 'Actual reference JsonDefaults DateTime and SyncPlay DTO binding: 53 date inputs and 61 DTO shapes. Native HTTP, scheduling and other native timezone environments are not recorded here.'
    : 'Actual reference JsonDefaults and UpdateUserItemDataDto date-295/date-296 binding, DateTime.ToUniversalTime and stored text. Native HTTP, migration, other dates and other native timezone environments are not recorded here.',
  timezone: fixture.environment, reference: verifiedBefore, identity: identityBefore,
  node: process.version, dotnetExecutable: dotnet, dotnetVersion: (await execute(['--version'], 'dotnet-version')).trim(),
  recorderSha256: await hash(fileURLToPath(import.meta.url)),
  oracleSourceSha256: await hash(path.join(project, 'Program.cs')),
  oracleProjectSha256: await hash(path.join(project, 'UserDataDateOracle.csproj')),
  oracleDllSha256: await hash(path.join(output, 'oracle/UserDataDateOracle.dll')),
  bindingCasesSha256: await hash(fileURLToPath(new URL('../../tests/sessions/user-data-binding-cases.js', import.meta.url))),
  ...(mode === 'syncplay' ? { syncplayInputSha256: await hash(syncplayInput) } : {}),
  fixtureSha256: await hash(path.join(output, `${prefix}.json`)),
  nativeStdoutSha256: await hash(path.join(output, 'native.stdout.log')),
  sourceUnchanged: true, inputAssembliesUnchanged: true, phaseAcceptance: false }));
console.log(JSON.stringify({ output, cases: cases.length, nodeTimezone: 'Asia/Taipei', nativeTimezone: nativeEnvironment.timezoneId }));
