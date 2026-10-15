import path from 'node:path';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { recordOracle } from '../validation/oracle.js';
import { projectResetObservation } from '../../tests/http/fixtures/password-reset/observations.js';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Usage: node tools/compat/record-password-reset.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY');
const fixture = path.resolve('tests/http/fixtures/password-reset');
const buildSource = path.join(process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT, 'source');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = await readFile(path.join(fixture, 'provenance.json'), 'utf8').then(JSON.parse)
  .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const sources = ['Jellyfin.Server.Implementations/Users/DefaultPasswordResetProvider.cs', 'Jellyfin.Server.Implementations/Users/UserManager.cs',
  'Jellyfin.Server.Implementations/Users/DefaultAuthenticationProvider.cs', 'Jellyfin.Server.Implementations/Users/InvalidAuthProvider.cs',
  'Emby.Server.Implementations/Cryptography/CryptographyProvider.cs', 'Jellyfin.Api/Controllers/UserController.cs', 'Jellyfin.Api/Controllers/SessionController.cs',
  'Jellyfin.Api/Models/UserDtos/ForgotPasswordDto.cs', 'Jellyfin.Api/Models/UserDtos/ForgotPasswordPinDto.cs',
  'MediaBrowser.Controller/Authentication/IPasswordResetProvider.cs', 'MediaBrowser.Common/Extensions/HttpContextExtensions.cs',
  'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs', 'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinDbContext.cs'];
async function captureSources() {
  return Promise.all(sources.map(async filename => {
    const designated = await readFile(path.join('D:/jellyfin', filename)), copied = await readFile(path.join(buildSource, filename));
    assert.ok(designated.equals(copied), filename);
    return { filename, sha256: hash(designated), designatedSourceMatchesOracleBuildCopy: true };
  }));
}
const before = await captureSources(), inputBytes = await readFile(path.join(fixture, 'input.json'));
const sqliteRuntime = path.join(path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL), 'runtimes/win-x64/native/e_sqlite3.dll');
const sqliteRuntimeSha256 = hash(await readFile(sqliteRuntime));
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output,
  args: [path.join(fixture, 'input.json'), '{output}/native.json'] });
assert.deepEqual(await captureSources(), before); assert.ok(inputBytes.equals(await readFile(path.join(fixture, 'input.json'))));
const bytes = await readFile(path.join(output, 'native.json')), native = JSON.parse(bytes);
for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
assert.equal(hash(await readFile(sqliteRuntime)), sqliteRuntimeSha256);
assert.equal(native.nativeLibraries.length, 1);
for (const library of native.nativeLibraries) { assert.equal(hash(await readFile(library.filename)), library.sha256); assert.equal(library.sha256, sqliteRuntimeSha256); }
const proof = { inputSha256: hash(inputBytes), nativeSha256: hash(bytes), sources: before,
  rawRecording: path.join(output, 'native.json'), record: path.join(output, 'record.json'),
  oracleSources: record.sourceFiles.map(row => ({ filename: path.basename(row.filename), sha256: row.sha256 })),
  build: record.build, process: record.process, assemblies: native.assemblies, nativeLibraries: native.nativeLibraries,
  sqliteRuntime: { filename: sqliteRuntime, sha256: sqliteRuntimeSha256 },
  jellyfin: { dll: process.env.MEDIAMANAGER_JELLYFIN_DLL, buildSource },
  sourcesStable: true, candidateVerified: false, completeBuildInputClosure: false, phaseAcceptance: false };
if (previous?.inputSha256 === proof.inputSha256 && JSON.stringify(previous.oracleSources) === JSON.stringify(proof.oracleSources)) {
  const oldBytes = await readFile(previous.rawRecording); assert.equal(hash(oldBytes), previous.nativeSha256);
  const previousNative = JSON.parse(oldBytes);
  assert.deepEqual(await Promise.all(native.results.map(projectResetObservation)), await Promise.all(previousNative.results.map(projectResetObservation)));
  proof.repeat = { filename: previous.rawRecording, sha256: previous.nativeSha256, sameInputAndOracleSources: true,
    comparisonSha256: hash(await readFile(path.join(fixture, 'observations.js'))) };
}
await copyFile(path.join(output, 'native.json'), path.join(fixture, 'native.json'));
await writeFile(path.join(fixture, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: record.passed, cases: native.results.length }));
