import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { recordedInputPath } from '../../tools/validation/paths.js';

const fixture = new URL('./fixtures/local-xml-save-prefix/', import.meta.url);
const [nativeBytes, proofBytes] = await Promise.all(['native.json', 'provenance.json'].map(name => readFile(new URL(name, fixture))));
const native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const sha = value => createHash('sha256').update(value).digest('hex');

test('local XML prefix historical seal binds actual saver, source and every loaded assembly', async () => {
  assert.equal(sha(nativeBytes), proof.nativeSha256);
  assert.equal(sha(await readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256);
  assert.equal(native.actualBaseXmlSaver, true); assert.equal(native.actualBoxSetXmlSaver, true);
  assert.equal(native.results.length, 5); assert.equal(proof.phaseAcceptance, false);
  for (const source of proof.oracleSources) assert.equal(sha(await readFile(new URL(source.name, fixture))), source.sha256);
  for (const source of proof.sources) for (const filename of [source.designated, source.isolated]) {
    assert.equal(sha(await readFile(recordedInputPath(filename, [source.sha256]))), source.sha256);
  }
  for (const assembly of proof.loadedAssemblies) {
    assert.equal(sha(await readFile(recordedInputPath(assembly.filename, [assembly.sha256]))), assembly.sha256);
  }
});
