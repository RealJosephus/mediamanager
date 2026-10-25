import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { bookInput, captureBook, recordBookCandidate } from './fixtures/book-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const input = await bookInput('order');
let native, runtime, database, directory;
before(async () => {
  native = (await captureBook('order')).native;
  directory = await mkdtemp(path.join(os.tmpdir(), 'book-order-'));
  database = await createPostgresTestDatabase(null, 'book_order');
  runtime = await createTestRuntime({ database, programDataPath: path.join(directory, 'program'),
    configurationDirectoryPath: path.join(directory, 'config'), storageConfiguration: path.join(directory, 'storage.json'),
    configuration: { IsStartupWizardCompleted: true }, serverId: 'book-order' });
});
after(async () => {
  try { await runtime?.close(); }
  finally {
    try { if (database) await dropPostgresTestDatabase(database); }
    finally {
      if (directory) {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('book-order-'));
        await rm(directory, { recursive: true });
      }
    }
  }
});
const item = { Type: 'Book', Path: 'Z:\\Books\\book.epub', SupportsLocalMetadata: true };
const discover = settings => runtime.metadata.registry.discover({ item, ...settings });

test('Book provider observations bind repeated actual CoreAppHost discovery and the supplied ProviderManager', async () => {
  assert.equal((await captureBook('order')).report.independentNativeCapturesAgree, true);
  assert.deepEqual(native.observed.map(row => row.name), input.contexts.map(row => row.name));
  assert.deepEqual(discover({ kind: 'local' }).map(provider => provider.name), native.exports.map(provider => provider.Name));
});

test('the actual runtime registry retains discovered Book tie order and configured local-reader overrides', async () => {
  for (const sample of native.observed) {
    const context = input.contexts.find(row => row.name === sample.name);
    const libraryOptions = context.libraryOrder === null ? {} : { LocalMetadataReaderOrder: context.libraryOrder };
    const globalOptions = { LocalMetadataReaderOrder: context.globalOrder };
    const providers = discover({ kind: 'local', libraryOptions, globalOptions }).map(value => value.name);
    await recordBookCandidate('order', sample.name, { providers });
    assert.deepEqual(providers, sample.providers.map(value => value.Name));
  }
});

test('same-named real Book local metadata and dynamic images use independent configuration capabilities', async () => {
  const name = 'EPUB Metadata';
  const selected = settings => discover(settings).filter(value => value.name === name).map(value => value.name);
  const local = settings => selected({ kind: 'local', ...settings });
  const image = settings => selected({ kind: 'image', ...settings });
  const disabled = { libraryOptions: { TypeOptions: [{ Type: 'Book', MetadataFetchers: [], ImageFetchers: [] }] } };
  assert.deepEqual(local(disabled), [name]); assert.deepEqual(image(disabled), []);
  const enabled = { libraryOptions: { TypeOptions: [{ Type: 'Book', MetadataFetchers: [], ImageFetchers: [name] }] } };
  assert.deepEqual(local(enabled), [name]); assert.deepEqual(image(enabled), [name]);
  const global = { globalOptions: { DisabledMetadataFetchers: [name], DisabledImageFetchers: [name] } };
  assert.deepEqual(local(global), [name]); assert.deepEqual(image(global), []);
  await recordBookCandidate('order', 'capabilities', { disabled: { local: local(disabled), image: image(disabled) },
    enabled: { local: local(enabled), image: image(enabled) }, global: { local: local(global), image: image(global) } });
});
