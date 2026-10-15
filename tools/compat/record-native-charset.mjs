import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { recordOracle } from '../validation/oracle.js';
import { describeFile } from '../validation/inventory.js';

const output = process.argv[2], source = process.env.MEDIAMANAGER_JELLYFIN_SOURCE;
const upstream = process.env.MEDIAMANAGER_CHARSET_SOURCE;
if (!output || !source || !upstream) throw new Error('Supply a fresh output directory and the isolated pinned Jellyfin and charset source roots.');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
for (const [root, pin] of [[source, '208c278b75abd897aefa1e1175126eac5e4dbfaa'], [upstream, 'fd4c6fab634ef3783f8b5cb88e9ae9b2cc295ad5']]) {
  if (git(root, ['rev-parse', 'HEAD']) !== pin || git(root, ['status', '--short'])) throw new Error('Native sources must be clean exact pins.');
}
const root = 'tests/core/fixtures/native-charset';
const record = await recordOracle({ project: `${root}/Oracle.csproj`, output,
  args: [`${root}/input.json`, '{output}/native.raw.json', '{output}/tables.raw.json'] });
const native = JSON.parse(await readFile(path.join(output, 'native.raw.json'), 'utf8'));
let repeat = null;
if (process.argv[3]) {
  const repeatOutput = process.argv[3];
  await recordOracle({ project: `${root}/Oracle.csproj`, output: repeatOutput,
    args: [`${root}/input.json`, '{output}/native.raw.json', '{output}/tables.raw.json'] });
  const repeated = JSON.parse(await readFile(path.join(repeatOutput, 'native.raw.json'), 'utf8'));
  const tables = await readFile(path.join(output, 'tables.raw.json'));
  if (JSON.stringify(native.samples) !== JSON.stringify(repeated.samples)
    || !tables.equals(await readFile(path.join(repeatOutput, 'tables.raw.json')))) {
    throw new Error('Repeated native corpus or model constant extraction differs; retain both records.');
  }
  repeat = { sampleProjectionEqual: true, tablesByteEqual: true,
    record: await describeFile(path.join(repeatOutput, 'record.json')),
    raw: await describeFile(path.join(repeatOutput, 'native.raw.json')),
    models: await describeFile(path.join(repeatOutput, 'tables.raw.json')) };
}
const files = await Promise.all(['input.json', 'Program.cs', 'Oracle.csproj', 'README.md'].map(name => describeFile(path.join(root, name))));
async function tree(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await tree(filename));
    else if (entry.name.endsWith('.cs') || entry.name.endsWith('.csproj') || directory.endsWith('license')) result.push(await describeFile(filename));
  }
  return result;
}
const sources = [...await tree(path.join(upstream, 'src')), ...await tree(path.join(upstream, 'license'))];
const tablesPath = 'src/core/resources/native-charset-models.json';
await writeFile(`${root}/native.json`, await readFile(path.join(output, 'native.raw.json')));
await writeFile(tablesPath, await readFile(path.join(output, 'tables.raw.json')));
const bin = path.dirname(record.oracleAssembly.filename);
const resolution = await Promise.all(['Oracle.deps.json', 'Oracle.runtimeconfig.json'].map(name => describeFile(path.join(bin, name))));
const provenance = { candidateVerified: false, recordedAt: record.recordedAt,
  jellyfin: { source, commit: git(source, ['rev-parse', 'HEAD']), packages: await describeFile(path.join(source, 'Directory.Packages.props')) },
  upstream: { source: upstream, commit: git(upstream, ['rev-parse', 'HEAD']), sources }, files, resolution, repeat,
  record: await describeFile(path.join(output, 'record.json')), raw: await describeFile(path.join(output, 'native.raw.json')),
  native: await describeFile(`${root}/native.json`), tables: await describeFile(tablesPath),
  modelRaw: await describeFile(path.join(output, 'tables.raw.json')), dotnet: record.dotnet, loadedAssemblies: native.loadedAssemblies,
  runtimeScope: 'Actual UTF.Unknown process, runtime-loaded assemblies and all pinned upstream detector/model source files; not the complete native build-input closure.' };
await writeFile(`${root}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ passed: record.passed, output, samples: native.samples.length, nativeSha256: provenance.native.sha256, tablesSha256: provenance.tables.sha256 }));
