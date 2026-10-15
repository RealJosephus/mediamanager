import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';

const fixture = new URL('./fixtures/password-reset/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('the actual native password reset reader consumes original Node-produced PIN-file bytes', async () => {
  const proof = JSON.parse(await readFile(new URL('consumer.json', fixture)));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture)));
  const rawReading = await readFile(proof.rawReading), manifestBytes = await readFile(proof.manifest);
  assert.equal(hash(rawReading), proof.readingSha256); assert.equal(hash(manifestBytes), proof.manifestSha256);
  const reader = JSON.parse(rawReading), manifest = JSON.parse(manifestBytes);
  assert.equal(reader.inputSha256, proof.manifestSha256); assert.equal(reader.actualDefaultProviderReader, true);
  assert.equal(reader.type, 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider+SerializablePasswordReset');
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.phaseAcceptance, false);
  assert.equal(proof.cases, 8); assert.equal(reader.readings.length, proof.cases);
  assert.deepEqual(proof.oracleSources, provenance.oracleSources);
  for (const source of [...proof.producerSources, ...proof.sources, ...reader.assemblies]) assert.equal(hash(await readFile(source.filename)), source.sha256, source.filename);
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.filename === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.filename, fixture))), source.sha256);
  for (const reading of reader.readings) {
    const entry = manifest.find(row => row.name === reading.name); assert.ok(entry);
    const rawProducer = await readFile(entry.source.filename); assert.equal(hash(rawProducer), entry.source.sha256);
    const producer = JSON.parse(rawProducer);
    assert.equal(producer.name, entry.name);
    const emitted = producer.observations.flatMap(row => row.files).find(file => file.name === entry.filename && file.bytesBase64 === entry.bytesBase64);
    assert.ok(emitted);
    const bytes = Buffer.from(entry.bytesBase64, 'base64'); assert.equal(reading.sha256, hash(bytes));
    assert.equal(bytes.toString('utf8'), emitted.text);
    const expected = JSON.parse(bytes); assert.match(expected.Pin, /^[0-9A-F]{2}(?:-[0-9A-F]{2}){3}$/u);
    assert.equal(path.dirname(expected.PinFile), producer.ProgramData);
    const { ExpirationDate: readDate, ...value } = reading.value, { ExpirationDate: producedDate, ...fields } = expected;
    assert.deepEqual(value, fields); assert.equal(parseJsonDateTime(readDate).ticks, parseJsonDateTime(producedDate).ticks);
  }
});
