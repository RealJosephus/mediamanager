import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { normalizeDeletionRecording } from '../http/fixtures/warm-item-deletion/normalize.js';

export async function readWarmFixture(root) {
  const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
    .map(async filename => parseLosslessJson(await readFile(new URL(filename, root), 'utf8'))));
  return { input, native, provenance, root };
}

export async function assertWarmFixtureSeal(fixture, { flag, count, http = false }) {
  const { native, provenance, root } = fixture, directory = fileURLToPath(root);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const file of Object.values(provenance.files))
    assert.equal(sha(await readFile(path.resolve(directory, file.filename))), file.sha256, file.filename);
  const first = await readFile(provenance.files.rawRecording.filename), repeat = await readFile(provenance.repeat.filename);
  assert.equal(sha(repeat), provenance.repeat.sha256);
  if (http) {
    assert.deepEqual(normalizeDeletionRecording(parseLosslessJson(first.toString())), native);
    assert.deepEqual(normalizeDeletionRecording(parseLosslessJson(repeat.toString())), native);
  } else {
    assert.deepEqual(first, repeat); assert.deepEqual(parseLosslessJson(first.toString()), native);
  }
  for (const file of [provenance.jellyfin.sourceCapture, provenance.jellyfin.boundBuildAudit,
    ...Object.values(provenance.runtime), ...Object.values(provenance.repeat.runtime)])
    assert.equal(sha(await readFile(file.filename)), file.sha256, file.filename);
  for (const assembly of provenance.assemblies)
    assert.equal(sha(await readFile(provenance.jellyfin.assemblyDirectory + '/' + assembly.name + '.dll')), assembly.sha256);
  assert.equal(native[flag], true); assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false); assert.equal(provenance.completeBuildInputClosure, false);
  assert.equal(provenance.releaseAcceptance, false); assert.equal(native.results.length, count);
  assert.equal(native.inputSha256, provenance.files['input.json'].sha256);
  assert.deepEqual(native.assemblies, provenance.assemblies); assert.equal(native.scope, provenance.scope);
  assert.equal(provenance.repeat.projectionEqual, true);
}
