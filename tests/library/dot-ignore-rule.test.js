import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import tables from '../../src/core/resources/native-ignore-regex.json' with { type: 'json' };
import { NativeIgnoreRules } from '../../src/library/ignore-rules.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { input, native, provenance, prepareFileSample } from './dot-ignore-fixture.js';

test('ignore recording seals actual rules, file cache, CLR tables and controlled sequential cache scope', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL('../../' + file.path, import.meta.url))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenDotIgnoreIgnoreRule, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.rules.map(sample => sample.id), input.rules.map(sample => sample.id));
  assert.deepEqual(native.files.map(sample => sample.id), input.files.map(sample => sample.id));
  assert.deepEqual(native.caches.map(sample => sample.id), input.caches.map(sample => sample.id));
  assert.equal(native.rules.reduce((sum, group) => sum + group.checks.length, 0), 263);
  assert.equal(native.caches.reduce((sum, group) => sum + group.operations.length, 0), 2298);
  assert.equal(tables.culture, native.culture); assert.deepEqual(tables.assemblies, native.assemblies);
  assert.equal(tables.sourceFilesSha256, provenance.capture.sourceFilesSha256);
  for (const key of ['caseEquivalences', 'categories', 'unicodeBlocks']) assert.deepEqual(tables[key], native[key], key);
});

for (const sample of input.rules) test('native ignore matching: ' + sample.id, () => {
  const rules = new NativeIgnoreRules(sample.patterns);
  for (const expected of native.rules.find(group => group.id === sample.id).checks) assert.equal(
    rules.isIgnored(expected.path, expected), expected.ignored, JSON.stringify(expected));
});

for (const sample of input.files) test('native ignore files: ' + sample.id, async t => {
  const fixture = await prepareFileSample(t, sample);
  const rule = new DotIgnoreRule({ ...fixture, processorCount: native.processorCount, normalizePath: native.windowsPathNormalization });
  const checks = [];
  for (const action of sample.actions) {
    const value = await fixture.execute(rule, action);
    if (value) { assert.equal(value.result.complete, true); checks.push(value.record); }
  }
  assert.deepEqual(checks, native.files.find(group => group.id === sample.id).checks);
});

test('unmapped ancestors do not establish a native cached absence', async t => {
  const fixture = await prepareFileSample(t, { id: 'unmapped', actions: [] });
  const identityMap = new (fixture.identityMap.constructor)();
  identityMap.addPrefix({ identityRoot: 'Z:\\cases', accessRoot: '/all/cases', style: 'windows', returnAccess: 'Mapped media directory only.' });
  const rule = new DotIgnoreRule({ vfs: fixture.vfs, identityMap });
  assert.deepEqual(await rule.check('Z:\\cases\\primary.mkv'), { ignored: false, complete: false });
  assert.equal(rule.directoryCache.size, 0);
});

test('a cloned default ignore reader uses its own explicit mapping', async t => {
  const fixture = await prepareFileSample(t, { id: 'clone-reader', actions: [] });
  const rule = new DotIgnoreRule(fixture), preview = rule.clone();
  preview.identityMap = new IdentityAccessMap();
  assert.equal((await preview.fileAccess.info('Z:\\cases\\.ignore')).mapped, false);
  assert.equal((await rule.fileAccess.info('Z:\\cases\\.ignore')).mapped, true);
});

for (const separator of ['/', '\\']) for (const knownAncestors of [true, false]) {
  test(`Windows UNC ignore search uses ${JSON.stringify(separator)} with known ancestors ${knownAncestors}`, async t => {
    const fixture = await prepareFileSample(t, { id: 'unc', actions: [] });
    const share = `${separator}${separator}Server${separator}Share${separator}`;
    const library = share + 'Library', file = library + separator + 'Film.mkv';
    const identityMap = new IdentityAccessMap();
    identityMap.addPrefix({ identityRoot: knownAncestors ? share : library,
      accessRoot: knownAncestors ? '/all' : '/all/Library', style: 'windows', returnAccess: 'Isolated UNC rule namespace.' });
    await fixture.adapter.mkdir('/Library');
    const rule = new DotIgnoreRule({ vfs: fixture.vfs, identityMap });
    assert.deepEqual(await rule.check(file), { ignored: false, complete: knownAncestors });
    if (!knownAncestors) {
      assert.equal(rule.directoryCache.size, 0);
      await assert.rejects(rule.shouldIgnore(file), { code: 'ignore-search-unmapped', status: 501 });
      return;
    }
    await fixture.adapter.write('/Library/.ignore', Buffer.from('*.mkv'));
    assert.equal(await rule.shouldIgnore(file), false, 'native cached absence survives until the directory clear');
    rule.clearDirectoryCache();
    assert.equal(await rule.shouldIgnore(file), true);
    assert.equal(rule.rulesCache.size, 1);
  });
}
