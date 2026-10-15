import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { recordOracle } from '../validation/oracle.js';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';

const [output, candidate] = process.argv.slice(2);
if (![output, candidate].every(value => value && path.isAbsolute(value))) {
  throw new Error('Usage: node tools/compat/check-password-reset-files.js NEW_ABSOLUTE_EVIDENCE_DIRECTORY CANDIDATE_EVIDENCE_DIRECTORY');
}
const fixture = path.resolve('tests/http/fixtures/password-reset');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['local', 'anonymous-local', 'case-name', 'unicode-name', 'unknown-reset-provider', 'with-schedules', 'save-user-failure', 'generated-pin-flow'];
const sources = [], entries = [];
for (const name of names) {
  const filename = path.join(candidate, 'password-reset', name + '.json'), bytes = await readFile(filename), row = JSON.parse(bytes);
  sources.push({ filename, sha256: hash(bytes) });
  const file = row.observations.flatMap(observation => observation.files).find(file => !file.directory && file.bytesBase64
    && JSON.parse(file.text)?.PinFile?.startsWith(row.ProgramData));
  assert.ok(file, name);
  const produced = Buffer.from(file.bytesBase64, 'base64'); assert.equal(produced.toString('utf8'), file.text);
  assert.match(JSON.parse(produced).Pin, /^[0-9A-F]{2}(?:-[0-9A-F]{2}){3}$/u);
  entries.push({ name, filename: file.name, bytesBase64: file.bytesBase64, source: sources.at(-1) });
}
const producerSources = await Promise.all(['src/users/password-reset-service.js', 'src/users/native.js', 'src/core/identity.js'].map(async filename => ({ filename, sha256: hash(await readFile(filename)) })));
await mkdir(output);
const manifest = path.join(output, 'manifest.json'), inputBytes = Buffer.from(JSON.stringify(entries, null, 2) + '\n');
await writeFile(manifest, inputBytes, { flag: 'wx' });
const record = await recordOracle({ project: path.join(fixture, 'Oracle.csproj'), output: path.join(output, 'oracle'),
  args: ['read-files', manifest, '{output}/read-files.json'] });
const rawReading = path.join(output, 'oracle/read-files.json'), readerBytes = await readFile(rawReading), reader = JSON.parse(readerBytes);
assert.equal(reader.actualDefaultProviderReader, true); assert.equal(reader.inputSha256, hash(inputBytes));
assert.equal(reader.type, 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider+SerializablePasswordReset');
assert.deepEqual(reader.readings.map(row => row.name), names);
for (const reading of reader.readings) {
  const entry = entries.find(row => row.name === reading.name), bytes = Buffer.from(entry.bytesBase64, 'base64'), expected = JSON.parse(bytes);
  assert.equal(reading.sha256, hash(bytes));
  const { ExpirationDate: actualDate, ...actual } = reading.value, { ExpirationDate: expectedDate, ...values } = expected;
  assert.deepEqual(actual, values); assert.equal(parseJsonDateTime(actualDate).ticks, parseJsonDateTime(expectedDate).ticks);
}
for (const source of [...sources, ...producerSources, ...reader.assemblies]) assert.equal(hash(await readFile(source.filename)), source.sha256);
const proof = { rawReading, readingSha256: hash(readerBytes), manifest, manifestSha256: hash(inputBytes),
  record: path.join(output, 'oracle/record.json'), build: record.build, process: record.process,
  oracleSources: record.sourceFiles.map(row => ({ filename: path.basename(row.filename), sha256: row.sha256 })),
  sources, producerSources, actualDefaultProviderReader: true, cases: entries.length, phaseAcceptance: false };
await writeFile(path.join(fixture, 'consumer.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: true, cases: entries.length }));
