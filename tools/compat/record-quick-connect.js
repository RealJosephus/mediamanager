import path from 'node:path';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { recordOracle } from '../validation/oracle.js';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Usage: node tools/compat/record-quick-connect.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY');
const fixture = path.resolve('tests/http/fixtures/quick-connect');
const buildSource = path.join(process.env.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT, 'source');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = await readFile(path.join(fixture, 'provenance.json'), 'utf8').then(JSON.parse)
  .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const sources = ['Emby.Server.Implementations/QuickConnect/QuickConnectManager.cs', 'Emby.Server.Implementations/Session/SessionManager.cs',
  'Jellyfin.Server.Implementations/Users/UserManager.cs',
  'Jellyfin.Api/Controllers/QuickConnectController.cs', 'Jellyfin.Api/Controllers/UserController.cs',
  'MediaBrowser.Model/QuickConnect/QuickConnectResult.cs', 'Jellyfin.Api/Models/UserDtos/QuickConnectDto.cs',
  'Jellyfin.Api/Helpers/RequestHelpers.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
  'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs'];
async function captureSources() {
  return Promise.all(sources.map(async filename => {
    const designated = await readFile(path.join('D:/jellyfin', filename)), copied = await readFile(path.join(buildSource, filename));
    assert.ok(designated.equals(copied), filename);
    return { filename, sha256: hash(designated), designatedSourceMatchesOracleBuildCopy: true };
  }));
}
const before = await captureSources();
const inputBytes = await readFile(path.join(fixture, 'input.json'));
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output,
  args: [path.join(fixture, 'input.json'), '{output}/native.json'] });
assert.deepEqual(await captureSources(), before);
assert.ok(inputBytes.equals(await readFile(path.join(fixture, 'input.json'))));
const bytes = await readFile(path.join(output, 'native.json')), native = JSON.parse(bytes);
for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
const proof = { inputSha256: hash(inputBytes), nativeSha256: hash(bytes), sources: before,
  rawRecording: path.join(output, 'native.json'), record: path.join(output, 'record.json'),
  oracleSources: record.sourceFiles.map(row => ({ filename: path.basename(row.filename), sha256: row.sha256 })),
  build: record.build, process: record.process, assemblies: native.assemblies,
  jellyfin: { dll: process.env.MEDIAMANAGER_JELLYFIN_DLL, buildSource },
  sourcesStable: true, candidateVerified: false, completeBuildInputClosure: false, phaseAcceptance: false };
if (previous?.inputSha256 === proof.inputSha256 && JSON.stringify(previous.oracleSources) === JSON.stringify(proof.oracleSources)) {
  function observations(record) {
    return { directResults: record.directResults, results: record.results.map(row => {
      function project(value) {
        if (Array.isArray(value)) return value.map(project);
        if (!value || typeof value !== 'object') return value;
        if (value.Secret && value.Code && value.DateAdded) {
          assert.match(value.Secret, /^[A-F0-9]{64}$/u); assert.match(value.Code, /^[1-9][0-9]{5}$/u);
          assert.equal(value.Secret, row.issued.Secret); assert.equal(value.Code, row.issued.Code);
          const added = Date.parse(value.DateAdded), start = Date.parse(row.started), end = Date.parse(row.finished);
          const advance = added > start + 30_000 ? 60_000 : 0;
          assert.ok(added === 0 || added >= start + advance - 1 && added <= end + advance + 1);
          return { ...value, Secret: '<secret>', Code: '<code>', DateAdded: added === 0 ? '<expired>' : advance ? '<advanced>' : '<created>' };
        }
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, value]) => [key, project(value)]));
      }
      return { name: row.name, status: row.status, contentType: row.contentType, allow: row.allow, body: row.json === null ? row.body : project(row.json),
        calls: row.calls, issued: project(row.issued), pending: project(row.pending), authorizedCount: row.authorizedCount };
    }) };
  }
  const oldBytes = await readFile(previous.rawRecording); assert.equal(hash(oldBytes), previous.nativeSha256);
  assert.deepEqual(observations(native), observations(JSON.parse(oldBytes)));
  proof.repeat = { filename: previous.rawRecording, sha256: previous.nativeSha256, sameInputAndOracleSources: true };
}
await copyFile(path.join(output, 'native.json'), path.join(fixture, 'native.json'));
await writeFile(path.join(fixture, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: record.passed, cases: native.results.length }));
