import { validationExecutable, validationPath } from '../../../../tools/validation/paths.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(directory, '../../../../');
const evidence = validationPath(path.join(project, '.test-input/evidence/runtime-integration-20260926/binding'));
const baseline = validationPath(path.join(project, '.test-input/baselines/jellyfin-current'));
const binaryRoot = path.join(baseline, 'source/Jellyfin.Server/bin/Release/net10.0');
const digest = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
const baselineManifest = JSON.parse(await readFile(path.join(baseline, 'manifest.json'), 'utf8'));
if (typeof baselineManifest.head !== 'string' || !/^[0-9a-f]{40}$/iu.test(baselineManifest.head)) throw new Error('The baseline manifest must declare its current Git head');
const files = [];
for (const [fixture, original] of [['input.json', 'input.json'], ['output.json', 'output.json'], ['schema.json', 'schema.json'],
  ['Oracle.cs', 'Program.cs'], ['Oracle.csproj', 'Oracle.csproj'], ['http-input.json', 'http-input.json'], ['http-output.json', 'reference-http.json']]) {
  const hash = await digest(path.join(directory, fixture));
  if (hash !== await digest(path.join(evidence, original))) throw new Error(`Recorded fixture differs from actual oracle artifact: ${fixture}`);
  files.push({ fixture, recordedArtifact: path.relative(project, path.join(evidence, original)).replaceAll('\\', '/'), sha256: hash });
}
const assemblies = [];
for (const name of ['Jellyfin.Api.dll', 'Jellyfin.Extensions.dll', 'MediaBrowser.Model.dll', 'Jellyfin.Data.dll']) assemblies.push({ name, sha256: await digest(path.join(binaryRoot, name)) });
assemblies.push({ name: 'Oracle.dll', sha256: await digest(path.join(evidence, 'bin/Debug/net10.0/Oracle.dll')) });
const sourcePaths = ['Jellyfin.Api/Models/MediaInfoDtos/PlaybackInfoDto.cs', 'MediaBrowser.Model/Dlna/DeviceProfile.cs',
  'src/Jellyfin.Extensions/Json/JsonDefaults.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonStringConverter.cs',
  'src/Jellyfin.Extensions/Json/Converters/JsonNullableStructConverter.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonNullableGuidConverter.cs'];
const source = [];
for (const filename of sourcePaths) {
  const frozen = await digest(path.join(baseline, 'source', filename));
  const current = await digest(path.join(process.env.MEDIAMANAGER_JELLYFIN_SOURCE || 'D:/jellyfin', filename));
  if (frozen !== current) throw new Error(`The current reference source differs: ${filename}`);
  source.push({ path: filename, currentAndFrozenSha256: frozen });
}
const input = JSON.parse(await readFile(path.join(directory, 'input.json'), 'utf8'));
const httpInput = JSON.parse(await readFile(path.join(directory, 'http-input.json'), 'utf8'));
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true }).trim();
const provenance = {
  fixturesFrozenAt: new Date().toISOString(), reference: 'D:/jellyfin current workspace including local modifications',
  baselineHead: baselineManifest.head,
  baselineManifestSha256: await digest(path.join(baseline, 'manifest.json')), files, assemblies, source,
  dotnetSdk: run(validationExecutable('dotnet'), ['--version']), node: process.version,
  pureDeserialization: {
    cases: input.length, call: 'JsonSerializer.Deserialize<PlaybackInfoDto>(json, new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true })',
    output: 'Serialized with JsonDefaults.Options; null object properties are omitted; Guid.Empty serializes as explicit null.',
    errorFields: ['exception type name', 'Message', 'Path', 'LineNumber', 'BytePositionInLine'],
    integerHandling: 'Original JSON fixture bytes retained; Node loads expected output losslessly.',
    excludes: ['ASP.NET MVC required-field validation', 'HTTP query binding', 'syntax-error matrix outside the recorded inputs'],
  },
  http: {
    cases: httpInput.length, origin: 'Isolated actual Jellyfin process on 127.0.0.1:18341',
    preparation: '.test-input/evidence/runtime-integration-20260926/binding/prepare-reference.mjs',
    recorder: 'tests/playback/binding-scenario.js',
    normalizations: ['traceId', 'PlaySessionId', 'exact isolated synthetic subtitle path'],
    permittedDifferences: { cases: ['nullable-empty', 'query-empty-body-bitrate', 'profile-null'], field: 'MediaSources[0].SupportsTranscoding', native: true, candidate: false },
    rawCompatibilityMustRemainFalse: true,
  },
  replay: 'node --test tests/playback/json-model-binding.test.js tests/playback/binding-http.test.js',
  postgresEnvironment: 'MEDIAMANAGER_TEST_POSTGRES',
};
await writeFile(path.join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Recorded provenance for ${input.length} pure deserialization and ${httpInput.length} HTTP cases.`);
