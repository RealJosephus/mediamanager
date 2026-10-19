import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { seedPersistence } from '../../tests/metadata/fixtures/tmdb-missing/persistence-input.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [assemblyDirectoryArgument, dotnetArgument, sqliteArgument, outputArgument, manifestArgument] = process.argv.slice(2);
if (!manifestArgument) throw new Error('Usage: node tools/compat/record-tmdb-missing.mjs <assembly-directory> <dotnet-executable> <sqlite-native-library> <fresh-output-directory> <baseline-manifest>');
const assemblyDirectory = path.resolve(assemblyDirectoryArgument), dotnet = path.resolve(dotnetArgument);
const directory = path.resolve(outputArgument), build = path.join(directory, 'oracle');
await mkdir(directory); // An existing output must never be mistaken for a fresh recording.
const hash = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
const run = (executable, args, name) => {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet) } });
  return writeFile(path.join(directory, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? '')).then(() => {
    if (result.status !== 0 || result.signal) throw new Error(`${name} failed: exit ${result.status}, signal ${result.signal}`);
    return { exitCode: result.status, signal: result.signal };
  });
};
const fixtureRoot = path.join(root, 'tests/metadata/fixtures/tmdb-missing');
const model = path.join(root, 'src/database/native-model.json');
const files = Object.fromEntries(await Promise.all(['Oracle.cs', 'Oracle.csproj', 'input.json', 'persistence-input.mjs']
  .map(async filename => [filename, await hash(path.join(fixtureRoot, filename))])));
const processes = {};
processes.build = await run(dotnet, ['build', path.join(fixtureRoot, 'Oracle.csproj'), '-c', 'Release',
  `-p:JellyfinAssemblyDirectory=${assemblyDirectory}`, `-p:BaseIntermediateOutputPath=${path.join(directory, 'obj')}${path.sep}`,
  `-p:MSBuildProjectExtensionsPath=${path.join(directory, 'obj')}${path.sep}`, '-o', build], 'build');
await copyFile(path.resolve(sqliteArgument), path.join(build, path.basename(sqliteArgument)));
processes.entities = await run(dotnet, [path.join(build, 'Oracle.dll'), path.join(fixtureRoot, 'input.json'),
  path.join(directory, 'native.json')], 'entities');
const sqlInput = path.join(directory, 'persistence.db');
const db = new SqliteDatabase(sqlInput, { create: true });
try { await seedPersistence(db); } finally { await db.close(); }
const databaseSha256Before = await hash(sqlInput);
processes.persistence = await run(dotnet, [path.join(build, 'Oracle.dll'), 'delete-sql', sqlInput,
  path.join(directory, 'persistence-native.json')], 'persistence');
const native = JSON.parse(await readFile(path.join(directory, 'native.json')));
for (const assembly of native.assemblies.filter(assembly => !assembly.name.startsWith('System.'))) {
  if (await hash(path.join(assemblyDirectory, `${assembly.name}.dll`)) !== assembly.sha256) {
    throw new Error(`Recorded assembly differs from the isolated reference: ${assembly.name}`);
  }
}
const persistenceNative = JSON.parse(await readFile(path.join(directory, 'persistence-native.json')));
if (await hash(path.join(assemblyDirectory, 'Jellyfin.Server.Implementations.dll')) !== persistenceNative.assemblySha256) {
  throw new Error('The SQL persistence recording used a different reference assembly.');
}
const manifest = JSON.parse(await readFile(path.resolve(manifestArgument)));
await writeFile(path.join(directory, 'provenance.json'), JSON.stringify({ processes, oracleFiles: files,
  recorderSha256: await hash(fileURLToPath(import.meta.url)),
  nativeModelSha256: await hash(model), reference: { manifestSha256: await hash(path.resolve(manifestArgument)),
    head: manifest.head, aggregateSha256: manifest.contentDigest },
  sqliteNativeSha256: await hash(path.resolve(sqliteArgument)), databaseSha256Before,
  databaseSha256After: await hash(sqlInput), nativeSha256: await hash(path.join(directory, 'native.json')),
  persistenceNativeSha256: await hash(path.join(directory, 'persistence-native.json')),
  phaseAcceptance: false }, null, 2) + '\n');
process.stdout.write(`Recorded TMDB entity and SQLite persistence cases: ${directory}\n`);
