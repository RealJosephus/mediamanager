import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const wrapperUrl = new URL('./fixtures/archive-codec/provenance.json', import.meta.url);
const licensesUrl = new URL('../../src/storage/resources/archive-codec-licenses-provenance.json', import.meta.url);
const rar4Url = new URL('../../src/storage/resources/archive-codec-rar4.provenance.json', import.meta.url);
const rar5Url = new URL('../../src/storage/resources/archive-codec-rar5-provenance.json', import.meta.url);
const builderUrl = new URL('../../tools/archive-codec-sources.json', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const resourceRoot = new URL('.', licensesUrl);
const canonical = filename => path.resolve(filename instanceof URL ? fileURLToPath(filename) : filename);
const cache = new Map();
async function bytes(filename) {
  filename = canonical(filename);
  if (!cache.has(filename)) cache.set(filename, readFile(filename));
  return cache.get(filename);
}
const json = async url => JSON.parse((await bytes(url)).toString('utf8'));
const [wrapper, licenses, rar4, rar5, builder] = await Promise.all([wrapperUrl, licensesUrl, rar4Url, rar5Url, builderUrl].map(json));
const resources = [
  { name: 'licenses', url: licensesUrl, document: licenses },
  { name: 'rar4', url: rar4Url, document: rar4 },
  { name: 'rar5', url: rar5Url, document: rar5 },
  { name: 'builder', url: builderUrl, document: builder },
];
const resolve = (filename, base) => path.isAbsolute(filename) ? canonical(filename) : canonical(new URL(filename.replaceAll('\\', '/'), base));
async function verify(entry, base) {
  const filename = resolve(entry.filename ?? entry.path, base), actual = await bytes(filename);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/iu, filename);
  assert.equal(digest(actual), entry.sha256.toLowerCase(), filename);
  if (entry.bytes != null) assert.equal(actual.length, entry.bytes, filename);
  return filename;
}
function requiredDescriptors(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (value.required === true && typeof (value.filename ?? value.path) === 'string' && Object.hasOwn(value, 'sha256')) result.push(value);
  for (const part of Object.values(value)) if (part && typeof part === 'object') requiredDescriptors(part, result);
  return result;
}

test('archive codec wrapper binds the four actual source manifests and every packaged local file read by consumers', async () => {
  assert.deepEqual(wrapper.resources.map(entry => entry.name).sort(), resources.map(entry => entry.name).sort());
  for (const resource of resources) {
    const entry = wrapper.resources.find(entry => entry.name === resource.name);
    assert.equal(entry.required, true); assert.equal(canonical(entry.filename), canonical(resource.url));
    await verify(entry, wrapperUrl);
  }
  const local = resources.flatMap(resource => (resource.document.files ?? resource.document.outputs ?? [])
    .filter(entry => entry.filename && entry.sha256).map(entry => ({ ...entry, base: resource.url })));
  for (const entry of local) {
    const filename = resolve(entry.filename, entry.base);
    assert.ok(wrapper.localFiles.some(pin => canonical(pin.filename) === filename && pin.sha256 === entry.sha256 && pin.required === true), filename);
  }
  for (const entry of wrapper.localFiles) { assert.equal(entry.required, true); await verify(entry, wrapperUrl); }
  for (const entry of wrapper.files) await verify(entry, wrapperUrl);
});

test('archive codec required external inputs and declared packaged files exist with their exact captured bytes', async () => {
  const pins = new Set();
  for (const resource of resources) {
    for (const entry of requiredDescriptors(resource.document)) pins.add(await verify(entry, resource.url));
    for (const entry of resource.document.files ?? resource.document.outputs ?? []) if (entry.filename && entry.sha256) await verify(entry, resource.url);
  }
  assert.ok(pins.size >= licenses.sourceFiles.length, 'every original license source is a required input actually read by this test');
  for (const source of licenses.sourceFiles) { assert.equal(source.required, true); await verify(source, licensesUrl); }
});

test('all original third-party license slices are preserved byte for byte in the distributed bundle', async () => {
  const bundle = await bytes(new URL('archive-codec-licenses.txt', resourceRoot));
  assert.ok(licenses.sections.length > 0);
  const pinnedSources = new Map(licenses.sourceFiles.map(entry => [canonical(entry.filename), entry]));
  for (const section of licenses.sections) {
    const copied = bundle.subarray(section.bundle.offset, section.bundle.offset + section.bundle.bytes);
    assert.equal(copied.length, section.bundle.bytes); assert.equal(digest(copied), section.bundle.sha256, section.id);
    assert.ok(section.origins.length > 0);
    for (const origin of section.origins) {
      assert.ok(pinnedSources.has(canonical(origin.filename)), origin.filename);
      const original = (await bytes(origin.filename)).subarray(origin.offset, origin.offset + origin.bytes);
      assert.equal(digest(original), origin.sha256, origin.filename); assert.deepEqual(copied, original, section.id);
    }
  }
  for (const output of licenses.outputs) await verify(output, licensesUrl);
  assert.deepEqual(await bytes(new URL('SharpCompress.LICENSE.txt', resourceRoot)),
    await bytes(licenses.sections.find(section => section.component === 'sharpcompress').origins[0].filename));
});

test('the actual final linker map, source notices and published codec payload form one closed attribution record', async () => {
  const build = licenses.finalCodecBuild;
  const mapDescriptor = build.receipts.find(entry => path.basename(entry.filename) === 'link.map');
  await verify(mapDescriptor, licensesUrl);
  const actual = new Map();
  for (const match of (await bytes(mapDescriptor.filename)).toString('utf8').matchAll(/([^\s]+\.a)\(([^)]+)\)/gu)) {
    const filename = canonical(match[1].replaceAll('\\', '/'));
    if (!actual.has(filename)) actual.set(filename, new Set());
    actual.get(filename).add(match[2]);
  }
  assert.equal(actual.size, build.libraries.length);
  for (const library of build.libraries) {
    await verify(library, licensesUrl);
    assert.deepEqual([...(actual.get(canonical(library.filename)) ?? [])].sort(), [...library.members].sort(), library.filename);
  }
  const runtime = [...actual].filter(([filename]) => filename.replaceAll('\\', '/').includes('/cache/sysroot/'));
  assert.equal(runtime.reduce((sum, [, members]) => sum + members.size, 0), build.runtimeObjects.length);
  for (const entry of build.runtimeObjects) {
    assert.ok(actual.get(canonical(entry.archive))?.has(entry.member)); await verify(entry.source, licensesUrl);
    assert.equal(path.basename(entry.source.filename).replace(/\.(?:c|S)$/u, ''), entry.member.replace(/\.o$/u, ''));
  }
  for (const [filename, members] of actual) if (path.basename(filename) === 'libarchive.a') {
    for (const member of members) assert.ok(licenses.staticLibraryMembers.some(entry => entry.member === member), member);
  }
  for (const source of build.modifiedLibarchiveSources) {
    await verify(source, licensesUrl);
    assert.ok(licenses.sections.some(section => section.origins.some(origin => origin.filename === source.filename)), source.filename);
  }
  const publishedDescriptor = build.receipts.find(entry => path.basename(entry.filename) === 'published.json');
  await verify(publishedDescriptor, licensesUrl);
  const published = JSON.parse((await bytes(publishedDescriptor.filename)).toString('utf8'));
  for (const artifact of build.artifacts) {
    await verify(artifact, licensesUrl);
    assert.ok(published.files.some(entry => canonical(entry.filename) === canonical(artifact.filename) && entry.sha256 === artifact.sha256));
  }
  assert.deepEqual(build.artifacts.map(entry => path.basename(entry.filename)).sort(), ['archive-codec.mjs', 'archive-codec.wasm']);
  assert.equal(build.linkedCppRuntimeObjects, 0);
  const latest = build.latestReviewedSourceVerification;
  await verify(latest.currentBridge, licensesUrl); await verify(latest.compiledBridge, licensesUrl);
  assert.equal(latest.currentBridge.sha256, builder.bridge.sha256);
  assert.equal(latest.currentBridge.sha256, latest.compiledBridge.sha256);
  for (const [current, executed] of [[latest.currentDriver, latest.executedDriver], [latest.currentManifest, latest.executedManifest]]) {
    await verify(current, licensesUrl); await verify(executed, licensesUrl);
    assert.deepEqual(await bytes(current.filename), await bytes(executed.filename));
  }
  assert.equal(canonical(latest.currentManifest.filename), canonical(builderUrl));
  const receipt = JSON.parse((await bytes(latest.receipts.find(entry => entry.filename.endsWith('/build/receipt.json')).filename)).toString('utf8'));
  assert.equal(receipt.mode, 'relink'); assert.equal(receipt.passed, true); assert.equal(receipt.inputsUnchanged, true);
  const record = JSON.parse((await bytes(latest.receipts.find(entry => entry.filename.endsWith('/record.json')).filename)).toString('utf8'));
  assert.equal(record.status, 0); assert.equal(record.sourcesUnchanged, true); assert.equal(record.outputsMatch, true);
  for (const output of latest.payloads) {
    await verify(output, licensesUrl);
    assert.equal(output.sha256, build.artifacts.find(entry => path.basename(entry.filename) === path.basename(output.filename))?.sha256);
  }
});

test('the portable codec builder manifest identifies the same upstream archives and reviewed local source files', async () => {
  assert.equal(builder.schemaVersion, 1);
  assert.deepEqual(builder.sourceArchives.map(entry => entry.name).sort(), ['bzip2', 'libarchive', 'xz', 'zlib']);
  for (const entry of builder.sourceArchives) {
    assert.ok(!path.isAbsolute(entry.archiveName)); assert.ok(!path.isAbsolute(entry.directory));
    const original = licenses.sourceArchives.find(source => path.basename(source.filename) === entry.archiveName);
    assert.ok(original, entry.archiveName); assert.equal(original.sha256, entry.sha256); assert.equal(original.bytes, entry.bytes);
    await verify(original, licensesUrl);
  }
  assert.ok(builder.files.length >= 4);
  for (const entry of builder.files) await verify(entry, builderUrl);
  assert.equal(builder.bridge.sha256, builder.files.find(entry => entry.filename === builder.bridge.filename)?.sha256);
});
