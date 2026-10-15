import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const manifest = new URL('./fixtures/reader-layouts/provenance.json', import.meta.url);
const root = new URL('.', manifest);
const sha = value => createHash('sha256').update(value).digest('hex');
const provenance = JSON.parse(await readFile(manifest));

export async function layoutFixture(kind) {
  const filenames = [kind + '-input.json', kind + '-native.json', kind + '-comparison.json'];
  const [input, native, comparison] = await Promise.all(filenames.map(async filename => {
    const bytes = await readFile(new URL(filename, root));
    assert.equal(sha(bytes), provenance.files.find(file => file.filename === filename).sha256, filename);
    return JSON.parse(bytes);
  }));
  const reference = provenance.records.find(record => record.kind === kind);
  const recordBytes = await readFile(reference.filename);
  assert.equal(sha(recordBytes), reference.sha256);
  const record = JSON.parse(recordBytes);
  assert.equal(record.passed, true);
  for (const source of [...record.sourceFiles, record.dotnet, record.jellyfinDll, record.oracleAssembly])
    assert.equal(sha(await readFile(source.filename)), source.sha256, source.filename);
  assert.equal(native.inputSha256, provenance.files.find(file => file.filename === filenames[0]).sha256);
  assert.equal(provenance.productionReplacement, false);
  assert.equal(provenance.candidateVerified, false);
  const baseline = JSON.parse(await readFile(new URL(`./fixtures/${kind}/native.json`, import.meta.url)));
  const baseResults = baseline.results ?? baseline.parserResults;
  const projection = ({ name, raw, ...value }) => value;
  for (const entry of comparison) {
    const actual = (native.results ?? native.parserResults).find(value => value.name === entry.name && (value.type ?? null) === entry.type);
    const original = baseResults.find(value => value.name === entry.originalName && (value.type ?? null) === entry.type);
    if (entry.equivalent) assert.deepEqual(projection(actual), projection(original), entry.name);
    else assert.notDeepEqual(projection(actual), projection(original), entry.name + ' must remain a functional counterexample');
  }
  return { input, native, comparison };
}
