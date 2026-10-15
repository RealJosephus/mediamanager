import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MetadataRegistry } from '../../src/metadata/registry.js';

const provenanceUrl = new URL('./fixtures/book-provider-order/provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Book default-order fixture binds actual CoreAppHost discovery and ProviderManager assembly', async () => {
  const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
  for (const file of provenance.files) assert.equal(hash(await readFile(new URL(file.filename, root))), file.sha256, file.filename);
  for (const file of provenance.requiredInputs) assert.equal(hash(await readFile(file.filename)), file.sha256, file.filename);
  const bytes = await readFile(provenance.record.filename); assert.equal(hash(bytes), provenance.record.sha256);
  const record = JSON.parse(bytes); assert.equal(record.passed, true); assert.equal(record.sourceFilesSha256, provenance.sourceFilesSha256);
  for (const source of record.sourceFiles) {
    const name = source.filename.replaceAll('\\', '/').split('/').at(-1);
    assert.equal(hash(await readFile(name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(name, root))), source.sha256);
  }
  for (const assembly of native.assemblies) assert.equal(provenance.requiredInputs.find(file => file.name === assembly.name)?.sha256, assembly.sha256);
});

test('registry retains actual discovered Book tie order and configured local-reader overrides', () => {
  const registry = new MetadataRegistry();
  registry.register({ id: 'book-locals', name: 'Book local metadata', providers: native.exports.map((value, index) => ({
    id: String(index), name: value.Name, kind: 'local', itemTypes: ['Book'], order: 50,
  })) });
  for (const sample of native.observed) {
    const libraryOptions = sample.name === 'library-order' ? { LocalMetadataReaderOrder: ['EPUB Metadata'] } : {};
    const globalOptions = sample.name === 'global-order' ? { LocalMetadataReaderOrder: ['Open Packaging Format'] } : {};
    assert.deepEqual(registry.discover({ item: { Type: 'Book', SupportsLocalMetadata: true }, kind: 'local', libraryOptions, globalOptions }).map(value => value.name), sample.providers.map(value => value.Name));
  }
});

test('same-named Book local metadata and dynamic images use independent configuration capabilities', () => {
  const registry = new MetadataRegistry(), name = 'EPUB Metadata';
  registry.register({ id: 'epub', name, providers: [
    { id: 'metadata', name, kind: 'local', itemTypes: ['Book'] },
    { id: 'cover', name, kind: 'image', imageSource: 'dynamic', itemTypes: ['Book'], imageTypes: ['Primary'] },
  ] });
  const item = { Type: 'Book', SupportsLocalMetadata: true };
  const local = settings => registry.discover({ item, kind: 'local', ...settings }).map(value => value.id);
  const image = settings => registry.discover({ item, kind: 'image', ...settings }).map(value => value.id);
  const disabled = { libraryOptions: { TypeOptions: [{ Type: 'Book', MetadataFetchers: [], ImageFetchers: [] }] } };
  assert.deepEqual(local(disabled), ['metadata']); assert.deepEqual(image(disabled), []);
  const enabled = { libraryOptions: { TypeOptions: [{ Type: 'Book', MetadataFetchers: [], ImageFetchers: [name] }] } };
  assert.deepEqual(local(enabled), ['metadata']); assert.deepEqual(image(enabled), ['cover']);
  const global = { globalOptions: { DisabledMetadataFetchers: [name], DisabledImageFetchers: [name] } };
  assert.deepEqual(local(global), ['metadata']); assert.deepEqual(image(global), []);
});
