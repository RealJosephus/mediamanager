import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { readSourceMembers } from './fixtures/archive-codec-current/source-reader.js';

const root = new URL('./fixtures/archive-codec-current/', import.meta.url);
const profile = JSON.parse(await readFile(new URL('current-profile.json', root)));
const offer = JSON.parse(await readFile(new URL('source-offer.json', root)));
const vectors = JSON.parse(await readFile(new URL('functional-cases.json', root)));
const hash = data => createHash('sha256').update(data).digest('hex');
const sourceMap = new Map(), sourceBytes = new Map();
let output, licenses, rar4, rar5, builder;
const report = { schemaVersion: 1, scope: profile.scope, sourceIntegrityVerified: false,
  licenseSlicesVerified: false, bridgeAndPatchesVerified: false, functionalConsumersVerified: false, newCodecBuildExecuted: false,
  historicalLinkMapReplayed: false, phaseAcceptance: false, releaseAcceptance: false,
  packageInputs: [], originalSources: [], functionalCases: [] };

async function checkedFile(entry) {
  const data = await readFile(new URL(entry.filename, root));
  assert.equal(data.length, entry.bytes, entry.filename);
  assert.equal(hash(data), entry.sha256, entry.filename);
  return data;
}

before(async () => {
  output = path.join(validationOutputRoot(), 'archive-codec-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output, { recursive: true });
  try {
    for (const entry of profile.inputs) {
      await checkedFile(entry);
      report.packageInputs.push(entry);
    }
    const history = new Map();
    for (const entry of offer.historicalManifests) history.set(entry.name, JSON.parse(await checkedFile(entry)));
    licenses = history.get('licenses'); rar4 = history.get('rar4'); rar5 = history.get('rar5'); builder = history.get('builder');
    for (const source of offer.sources) {
      assert.ok(!sourceMap.has(source.originalFilename), source.originalFilename);
      sourceMap.set(source.originalFilename, source);
    }
    assert.equal(offer.sourceRecoveryComplete, true);
    assert.deepEqual(offer.unresolvedSources, []);
    for (const archive of offer.archives) {
      const wanted = offer.sources.filter(entry => entry.kind === 'archive-member' && entry.archive === archive.id);
      const members = await readSourceMembers(fileURLToPath(new URL(archive.filename, root)), wanted);
      for (const source of wanted) sourceBytes.set(source.originalFilename, members.get(source.member));
    }
    for (const source of offer.sources) {
      assert.equal(source.recovered, true, source.originalFilename);
      const data = source.kind === 'file' ? await checkedFile(source) : sourceBytes.get(source.originalFilename);
      assert.ok(data, source.originalFilename);
      assert.equal(data.length, source.bytes, source.originalFilename);
      assert.equal(hash(data), source.sha256, source.originalFilename);
      sourceBytes.set(source.originalFilename, data);
      report.originalSources.push({ originalFilename: source.originalFilename, kind: source.kind,
        archive: source.archive, member: source.member, filename: source.filename, bytes: data.length, sha256: hash(data) });
    }
    report.sourceFilesVerified = true;
  } catch (error) {
    report.sourceError = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  }
}, { timeout: 720000 });

after(async () => {
  if (output) await writeFile(path.join(output, 'package-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
});

test('current codec package retains exact payloads, complete upstream archives and every original source identity', () => {
  assert.equal(report.sourceFilesVerified, true);
  assert.equal(offer.newCodecBuildExecuted, false);
  assert.equal(offer.historicalLinkMapReplayed, false);
  for (const original of builder.sourceArchives) {
    const restored = offer.archives.find(entry => entry.id === original.name);
    assert.ok(restored, original.name);
    assert.equal(restored.sha256, original.sha256, original.name);
    assert.equal(restored.bytes, original.bytes, original.name);
    assert.equal(restored.url, original.url, original.name);
  }
  const emscripten = offer.archives.find(entry => entry.id === 'emscripten');
  assert.equal(emscripten.commit, 'ce6d2aad8bbf1e508e5a6d112f986617198bdc0d');
  assert.equal(emscripten.originalToolchainCommitKnown, false);
  const prefix = 'D:/mediamanager-validation/20261016-book-stage/';
  const required = licenses.sourceFiles.filter(entry => entry.filename.startsWith(prefix + 'archive-build-1/')
    && builder.sourceArchives.some(archive => entry.filename.includes('/' + archive.directory + '/'))
    || entry.filename.startsWith(prefix + 'archive-toolchain-2/emscripten/') && !entry.filename.endsWith('.a'));
  required.push(...licenses.sharpCompressSourceReferences.map(entry => ({ ...entry, filename: entry.path })),
    ...licenses.finalCodecBuild.runtimeObjects.map(entry => entry.source), ...licenses.finalCodecBuild.linkedXzSources.map(entry => entry.source),
    ...licenses.finalCodecBuild.modifiedLibarchiveSources,
    ...rar4.requiredInputs.filter(entry => (entry.path ?? entry.filename).startsWith(prefix + 'inputs/comic-rar-paths-2/')
      && (entry.path ?? entry.filename).endsWith('.cs')).map(entry => ({ ...entry, filename: entry.path ?? entry.filename })));
  for (const entry of required) {
    const restored = sourceMap.get(entry.filename);
    assert.ok(restored, entry.filename);
    assert.equal(restored.sha256, entry.sha256, entry.filename);
    assert.equal(restored.bytes, entry.bytes, entry.filename);
  }
  for (const artifact of [...licenses.outputs, ...licenses.finalCodecBuild.artifacts]) {
    assert.ok(profile.inputs.some(entry => entry.sha256 === artifact.sha256 && entry.bytes === artifact.bytes), artifact.filename);
  }
  report.sourceIntegrityVerified = true;
});

test('all original license texts and every distributed notice slice consume independently recovered complete source bytes', async () => {
  const bundle = await readFile(new URL('../../../../src/storage/resources/archive-codec-licenses.txt', root));
  assert.equal(licenses.sections.length, offer.sectionCount);
  assert.deepEqual([...new Set(licenses.sections.flatMap(section => section.origins.map(origin => origin.filename)))].sort(), offer.sectionOriginals);
  for (const section of licenses.sections) {
    const copied = bundle.subarray(section.bundle.offset, section.bundle.offset + section.bundle.bytes);
    assert.equal(copied.length, section.bundle.bytes, section.id);
    assert.equal(hash(copied), section.bundle.sha256, section.id);
    assert.ok(section.origins.length > 0, section.id);
    for (const origin of section.origins) {
      const source = sourceBytes.get(origin.filename);
      assert.ok(source, origin.filename);
      const original = source.subarray(origin.offset, origin.offset + origin.bytes);
      assert.equal(original.length, origin.bytes, origin.filename);
      assert.equal(hash(original), origin.sha256, origin.filename);
      assert.deepEqual(copied, original, section.id);
    }
  }
  const sharp = licenses.sections.find(section => section.component === 'sharpcompress');
  assert.deepEqual(await readFile(new URL('../../../../src/storage/resources/SharpCompress.LICENSE.txt', root)),
    sourceBytes.get(sharp.origins[0].filename));
  report.licenseSlicesVerified = true;
  report.licenseSections = licenses.sections.length;
});

test('current bridge and patches bind both complete modified RAR sources and the retained runtime source attribution', async () => {
  const patched = licenses.finalCodecBuild.modifiedLibarchiveSources;
  const rar4Published = patched.find(entry => entry.sha256 === rar4.sourceAfter.sha256 && entry.bytes === rar4.sourceAfter.bytes);
  assert.ok(rar4Published, 'The complete published RAR4 source retains the recorded patched bytes');
  assert.equal(sourceMap.get(rar4Published.filename).sha256, rar4.sourceAfter.sha256);
  for (const source of patched) {
    const restored = sourceMap.get(source.filename);
    assert.ok(restored?.derivedFrom, source.filename);
    assert.equal(restored.sha256, source.sha256, source.filename);
    assert.equal(restored.derivedFrom.archive, 'libarchive');
    await checkedFile(restored.derivedFrom.patch);
    assert.ok(builder.patches.some(entry => entry.patchedSha256 === source.sha256
      && entry.originalSha256 === restored.derivedFrom.sha256));
  }
  const rar5Source = await readFile(new URL('../../../../src/storage/resources/' + rar5.files.find(entry => entry.filename.endsWith('.c')).filename, root));
  assert.equal(hash(rar5Source), patched.find(entry => entry.filename.endsWith('rar5.c')).sha256);
  assert.deepEqual([...new Set(licenses.finalCodecBuild.runtimeObjects.map(entry => entry.source.filename))].sort(), offer.runtimeSourceOriginals);
  for (const source of licenses.finalCodecBuild.runtimeObjects.map(entry => entry.source))
    assert.equal(hash(sourceBytes.get(source.filename)), source.sha256, source.filename);
  assert.equal(hash(await readFile(new URL('../../../../src/storage/resources/archive-codec.c', root))), builder.bridge.sha256);
  report.bridgeAndPatchesVerified = true;
});

test('the published codec decodes original RAR4, RAR5 and LZMA2 selected images through the actual Book archive consumer', async t => {
  const directory = assertValidationOutputChild(await mkdtemp(path.join(output, 'consumer-')));
  const spoolPath = path.join(directory, 'spool'), identityMap = new IdentityAccessMap();
  const locations = new Map(); let opened = 0, closed = 0;
  const service = new BookArchiveService({ identityMap, spoolPath, vfs: { async openRead(access, { signal } = {}) {
    opened++;
    const stream = createReadStream(locations.get(access), { signal, highWaterMark: 32768 }); let released = false;
    return { stream, async close() { if (!released) { released = true; closed++; stream.destroy(); } } };
  } } });
  try {
    const originalVectors = JSON.parse(await checkedFile(vectors.vectorSource));
    for (const sample of vectors.cases) await t.test(sample.name, async () => {
      const bytes = await checkedFile(sample);
      assert.equal(createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex'), sample.gitBlobSha1);
      const vector = originalVectors.covers.find(entry => entry.name === sample.vectorName);
      assert.ok(vector?.hasImage, sample.name);
      assert.equal(sample.selectedEntry.sha256, vector.sha256);
      assert.equal(sample.selectedEntry.bytes, vector.bytes);
      const access = '/' + sample.name;
      identityMap.bind(sample.name, access); locations.set(access, fileURLToPath(new URL(sample.filename, root)));
      let archive;
      const observation = { name: sample.name, inputSha256: hash(bytes), selected: null, spoolEmptyAfterClose: false };
      report.functionalCases.push(observation);
      try {
        archive = await service.openArchive({ Id: sample.name, Path: 'Z:\\CodecSources\\' + sample.name + '.cbr' });
        const entry = archive.findEntry(sample.selectedEntry.key);
        assert.ok(entry, sample.selectedEntry.key);
        const result = await archive.read(entry);
        observation.selected = { key: entry.key, bytes: result.length, sha256: hash(result) };
        assert.deepEqual(observation.selected, sample.selectedEntry);
      } catch (error) {
        observation.error = { name: error.name, message: error.message };
        throw error;
      } finally {
        await archive?.close();
        assert.deepEqual(await readdir(spoolPath), []);
        observation.spoolEmptyAfterClose = true;
      }
    });
    assert.ok(report.functionalCases.length === vectors.cases.length && report.functionalCases.every(entry => entry.selected && !entry.error));
    report.functionalConsumersVerified = true;
  } finally {
    try {
      await service.close();
      assert.equal(opened, closed, 'All original-media leases are released');
      report.mediaReads = { opened, closed };
      report.spoolEmptyAfterServiceClose = (await readdir(spoolPath)).length === 0;
      assert.equal(report.spoolEmptyAfterServiceClose, true);
    } finally {
      assertValidationOutputChild(directory); await rm(directory, { recursive: true });
    }
  }
});
