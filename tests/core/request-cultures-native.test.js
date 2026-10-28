import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createCoreLocalization } from '../../src/core/i18n.js';
import { describeFile, sha256 } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const fixture = new URL('./fixtures/request-cultures-current/', import.meta.url);
const codes = JSON.parse(await readFile(new URL('../../src/core/resources/request-cultures.json', import.meta.url), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('../../src/core/resources/request-cultures-provenance.json', import.meta.url), 'utf8'));

async function cases() {
  const result = [];
  for (const code of codes) {
    result.push({ name: 'query ' + code, query: '?' + new URLSearchParams({ culture: code }), header: 'en-US' });
    result.push({ name: 'cookie ' + code, query: '?culture=xx-YY', cookie: '.AspNetCore.Culture=c=' + code + '|uic=' + code, header: 'en-US' });
    result.push({ name: 'header ' + code, query: '?culture=xx-YY', header: code + ';q=1,en-US;q=0.1' });
  }
  for (const code of ['sv-SE', 'tr-TR', 'fr-FR', 'de-DE', 'es-ES', 'pt-MZ', 'sr-Latn-RS', 'zh-Hans-CN']) {
    result.push({ name: 'query parent ' + code, query: '?' + new URLSearchParams({ culture: code }) });
    result.push({ name: 'cookie parent ' + code, cookie: '.AspNetCore.Culture=c=' + code + '|uic=' + code });
    result.push({ name: 'header parent ' + code, header: code });
  }
  for (const { code } of provenance.resources.filter(row => row.code.includes('_'))) {
    result.push({ name: 'original resource spelling ' + code, query: '?' + new URLSearchParams({ culture: code }), header: 'en-US' });
    result.push({ name: 'original resource cookie ' + code, cookie: '.AspNetCore.Culture=c=' + code + '|uic=' + code, header: 'en-US' });
    result.push({ name: 'original resource header ' + code, header: code });
  }
  result.push(
    { name: 'unknown query uses Swedish cookie', query: '?culture=xx-YY', cookie: '.AspNetCore.Culture=c=sv-SE|uic=sv-SE', header: 'de-DE' },
    { name: 'unknown cookie uses Swedish header', cookie: '.AspNetCore.Culture=c=xx-YY|uic=xx-YY', header: 'sv-SE' },
    { name: 'unsupported providers use startup default', query: '?culture=xx-YY', cookie: '.AspNetCore.Culture=c=zz-ZZ|uic=zz-ZZ', header: 'xx,zz' },
    { name: 'one query culture keeps startup UI fallback', query: '?culture=sv-SE&ui-culture=xx-YY', header: 'de' },
    { name: 'one query UI culture keeps startup culture fallback', query: '?culture=xx-YY&ui-culture=sv-SE', header: 'de' },
    { name: 'empty query culture keeps startup fallback', query: '?culture=&ui-culture=sv-SE', header: 'de' },
    { name: 'mixed supported cultures', query: '?culture=sv-SE&ui-culture=tr-TR' },
    { name: 'case-insensitive query', query: '?CULTURE=SV-se&UI-CULTURE=TR-tr' },
    { name: 'encoded culture cookie', cookie: '.AspNetCore.Culture=c%3Dsv-SE%7Cuic%3Dtr-TR' },
    { name: 'duplicate query chooses cookie', query: '?culture=sv-SE&culture=tr-TR', cookie: '.AspNetCore.Culture=c=de|uic=de' },
    { name: 'duplicate UI query chooses cookie', query: '?ui-culture=sv-SE&ui-culture=tr-TR', cookie: '.AspNetCore.Culture=c=de|uic=de' },
    { name: 'comma query candidate chooses cookie', query: '?culture=sv-SE,tr-TR', cookie: '.AspNetCore.Culture=c=de|uic=de' },
    { name: 'encoded comma cookie chooses header', cookie: '.AspNetCore.Culture=c%3Dsv-SE%2Ctr-TR%7Cuic%3Dsv-SE%2Ctr-TR', header: 'de-DE' },
    { name: 'invalid culture with accepted UI parent', query: '?culture=sv-SE&culture=tr-TR&ui-culture=he_IL', header: 'de' },
    { name: 'header quality chooses Swedish', header: 'de;q=0.2,sv-SE;q=0.9,tr;q=0.8' },
    { name: 'header malformed quality fallback', header: 'sv-SE;q=bad,de-DE' },
    { name: 'header excludes candidate after first three', header: 'xx,zz,qq,sv-SE' },
    { name: 'header unsupported wildcard fallback', header: '*,sv-SE;q=0.5' },
  );
  for (const filename of ['locale-oracle.json', 'locale-boundaries-oracle.json']) {
    const recorded = JSON.parse(await readFile(new URL('../fixtures/core/' + filename, import.meta.url), 'utf8'));
    recorded.forEach((row, index) => result.push({ name: filename + ':' + index, ...row.input }));
  }
  return result;
}

test('production request cultures and provider fallback match the actual designated supported set while messages remain English', {
  skip: !enabled, timeout: 300000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'request-cultures-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const input = { defaults: ['en-US', 'de-DE', 'zh-CN'], cases: await cases() };
  const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n'), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { sourceBindings: [], inputSha256: sha256(inputBytes), fullInstanceVerified: false, completeLibraryVerified: false,
    productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    const build = await verifyNativeBuild(); t.signal.throwIfAborted();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    report.sourceBindings = await Promise.all([...provenance.sources, ...provenance.resources].map(async expected => {
      const declared = manifest.files.find(entry => entry.path === expected.path); assert.ok(declared, expected.path);
      assert.equal(declared.sha256, expected.sha256, expected.path);
      const actual = await describeFile(path.join(build.root, 'source', expected.path));
      assert.equal(actual.sha256, expected.sha256, expected.path);
      return { relativePath: expected.path, ...actual };
    }));
    const record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', fixture)),
      output: path.join(output, 'oracle'), args: [inputFile, '{output}/native.json'] });
    t.signal.throwIfAborted();
    const nativeFile = path.join(output, 'oracle/native.json'), native = JSON.parse(await readFile(nativeFile, 'utf8'));
    report.oracle = record; report.native = await describeFile(nativeFile); report.resolution = native.resolution;
    report.supportedCultures = native.supportedCultures;
    assert.equal(record.passed, true); assert.equal(record.process.status, 0); assert.equal(record.build.status, 0);
    assert.equal(native.inputSha256, sha256(inputBytes));
    assert.equal(record.outputs.find(entry => entry.filename === nativeFile)?.sha256, report.native.sha256);
    assert.equal(native.actualNativeSupportedUICultures, true); assert.equal(native.actualAspNetRequestLocalization, true);
    assert.deepEqual([...native.resourceCodes].sort(), provenance.resources.map(row => row.code).sort());
    assert.deepEqual([...native.supportedCultures].sort(), native.resolution.filter(row => row.accepted).map(row => row.name).sort());
    assert.deepEqual([...codes].sort(), [...native.supportedCultures].sort());
    for (const assembly of native.assemblies) {
      assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256);
      if (assembly.name === 'Emby.Server.Implementations') {
        assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256);
      }
    }
    assert.equal(native.observations.length, input.defaults.length * input.cases.length);
    const actual = [];
    const messages = JSON.parse(await readFile(new URL('../../src/core/resources/en-US.json', import.meta.url), 'utf8'));
    for (const serverCulture of input.defaults) {
      const localization = await createCoreLocalization({ serverCulture });
      assert.deepEqual([...localization.supportedCultures].sort(), [...native.supportedCultures].sort());
      for (const sample of input.cases) {
        t.signal.throwIfAborted();
        const context = localization.negotiate({ url: '/' + (sample.query ?? ''), headers: {
          ...(sample.cookie ? { cookie: sample.cookie } : {}), ...(sample.header ? { 'accept-language': sample.header } : {}) } });
        actual.push({ serverCulture, name: sample.name, ...context });
      }
      for (const culture of native.supportedCultures) localization.run({ culture, uiCulture: culture }, () => {
        for (const [key, value] of Object.entries(messages)) assert.equal(localization.text(key), value, culture + ': ' + key);
      });
    }
    report.actual = actual;
    report.mismatches = [];
    for (const [index, expected] of native.observations.entries()) {
      const { serverCulture, name, culture, uiCulture, provider } = expected;
      const expectedContext = { serverCulture, name, culture, uiCulture };
      if (!isDeepStrictEqual(actual[index], expectedContext)) report.mismatches.push({
        input: input.cases.find(sample => sample.name === name), serverCulture, actual: actual[index], expected: expectedContext,
        nativeProvider: provider,
      });
    }
    assert.deepEqual(report.mismatches, []);
    report.passed = true;
  } catch (error) { report.passed = false; report.error = errorObservation(error); throw error; }
  finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
});
