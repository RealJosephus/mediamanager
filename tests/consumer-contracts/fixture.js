import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifests = {
  readers: new URL('./fixtures/readers/provenance.json', import.meta.url),
  'playlist-layouts': new URL('./fixtures/playlist-layouts/provenance.json', import.meta.url),
  'date-roundtrip': new URL('./fixtures/date-roundtrip/provenance.json', import.meta.url),
};
async function recordedSource(descriptor) {
  try {
    return await readFile(descriptor.filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const archive = process.env.MEDIAMANAGER_RECORDED_SOURCE_ARCHIVE;
    assert.ok(archive, descriptor.filename + ' requires the recorded source archive');
    assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
    return readFile(path.join(archive, descriptor.sha256));
  }
}
export async function consumerFixture(kind) {
  assert.ok(manifests[kind], kind);
  const root = new URL('.', manifests[kind]);
  const provenance = JSON.parse(await readFile(manifests[kind]));
  assert.equal(provenance.originalFixturesUnchanged, true);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.phaseAcceptance, false);
  const result = { provenance };
  for (const file of provenance.files) {
    const bytes = await readFile(new URL(file.filename, root));
    assert.equal(digest(bytes), file.sha256, file.filename);
    assert.equal(digest(await readFile(file.source)), file.sha256, file.source);
    result[file.filename.replace(/\.json$/u, '')] = JSON.parse(bytes, (_, value) => value?.$integer ? BigInt(value.$integer) : value);
  }
  for (const reference of provenance.references) {
    const bytes = await readFile(reference.filename);
    assert.equal(digest(bytes), reference.sha256, reference.filename);
    const record = JSON.parse(bytes);
    if (!reference.filename.endsWith('/record.json')) continue;
    assert.equal(record.passed, true);
    for (const descriptor of record.sourceFiles)
      assert.equal(digest(await recordedSource(descriptor)), descriptor.sha256, descriptor.filename);
    for (const descriptor of [record.dotnet, record.jellyfinDll, record.oracleAssembly])
      assert.equal(digest(await readFile(descriptor.filename)), descriptor.sha256, descriptor.filename);
  }
  if (result.native) {
    assert.equal(result.native.inputSha256, provenance.files.find(file => file.filename === 'input.json').sha256);
    for (const assembly of result.native.assemblies ?? []) if (assembly.filename)
      assert.equal(digest(await readFile(assembly.filename)), assembly.sha256, assembly.filename);
  }
  return result;
}
