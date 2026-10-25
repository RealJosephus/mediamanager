import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { isNativeXmlTvEtag, nativeXmlTvEtagMatchesStored, nativeXmlTvProgramEtag, xmlTvEtagPrefix } from '../../plugins/xmltv/program-etag.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const inputFile = new URL('./fixtures/xmltv/input.json', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('XMLTV mapped fingerprints match the actual internal native Etag implementation', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async () => {
  const bytes = await readFile(inputFile), input = JSON.parse(bytes);
  const directory = path.join(validationOutputRoot(), 'xmltv-etag-' + randomUUID()); await mkdir(directory);
  const baseline = { Id: 'p', ChannelId: 'c', StartDate: '2026-10-21T01:02:03.1234567Z', EndDate: '2026-10-21T02:02:03.1234567Z' };
  for (const [index, value] of [0, -0, 0.1, 7.3, 0.0001, 0.00001, 0.0000000001, 100000000, 1000000000,
    12345678, 123456789, 1.17549435e-38, 1.40129846e-45, 3.4028234e38, -3.4028234e38].entries()) {
    input.etagCases.push({ name: 'float-' + index, program: { ...baseline, CommunityRating: Object.is(value, -0) ? JSON.rawJSON('-0') : value } });
  }
  for (const [index, Genres] of [['Drama', 'Action'], ['Action', 'Drama']].entries()) input.etagCases.push({ name: 'genre-order-' + index, program: { ...baseline, Genres } });
  const actualInput = Buffer.from(JSON.stringify(input)), filename = path.join(directory, 'input.json');
  await writeFile(filename, actualInput, { flag: 'wx' });
  const recording = await recordOracle({ project: 'tests/plugins/fixtures/xmltv/Oracle.csproj', output: path.join(directory, 'native'),
    args: [filename, '{output}/native.json'] });
  const nativeBytes = await readFile(path.join(directory, 'native/native.json')), native = JSON.parse(nativeBytes);
  assert.equal(recording.passed, true); assert.equal(native.inputSha256, sha(actualInput));
  assert.ok(native.actualXmlTvProgramEtag && native.actualXmlTvReaderAssembly);
  assert.equal(native.readerSourceCommit, '6c8c302c8520e5f41cd51dd392ac631f97179d82');
  assert.equal(recording.outputs.find(output => path.basename(output.filename) === 'native.json').sha256, sha(nativeBytes));
  const comparisons = [];
  for (const entry of native.etags) {
    let result, error;
    // JsonDefaults omits null object members. Keep explicit null collections
    // from the input so serialization cannot erase the failing native state.
    const explicitNulls = Object.fromEntries(Object.entries(input.etagCases.find(sample => sample.name === entry.name).program)
      .filter(([, value]) => value === null));
    try { result = nativeXmlTvProgramEtag({ ...entry.program, ...explicitNulls }); } catch (caught) { error = caught; }
    comparisons.push({ name: entry.name, result, nativeEtag: entry.etag, nativeReason: entry.reason, nativeError: entry.error, error: error?.message });
    if (entry.error) assert.ok(error, entry.name + ': the native fingerprint failure must not become an empty Etag.');
    else {
      assert.equal(error, undefined, error?.stack);
      assert.equal(result.etag, entry.etag ?? null, entry.name);
      assert.equal(entry.created, result.etag !== null);
    }
  }
  assert.notEqual(native.etags.find(entry => entry.name === 'genre-order-0').etag, native.etags.find(entry => entry.name === 'genre-order-1').etag);
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ passed: true, phaseAcceptance: false, releaseAcceptance: false,
    sourceSha256: sha(bytes), comparisons }, null, 2) + '\n');
});

test('XMLTV stored matching requires the exact provider prefix and ordinal-insensitive value equality', () => {
  assert.equal(isNativeXmlTvEtag(xmlTvEtagPrefix + 'ABC'), true);
  assert.equal(isNativeXmlTvEtag('XMLTV-sha256-v1:ABC'), false);
  assert.equal(isNativeXmlTvEtag('  '), false);
  assert.equal(nativeXmlTvEtagMatchesStored(xmlTvEtagPrefix + 'ABC', xmlTvEtagPrefix.toUpperCase() + 'abc'), true);
  assert.equal(nativeXmlTvEtagMatchesStored('sd-abc', 'sd-abc'), false);
  assert.equal(nativeXmlTvEtagMatchesStored(xmlTvEtagPrefix + 'ABC', xmlTvEtagPrefix + 'ABD'), false);
});
