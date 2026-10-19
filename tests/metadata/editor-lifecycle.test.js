import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { loadLibrary } from '../../src/library/records.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MetadataEditorService, containingFolderPath } from '../../src/metadata/editor-service.js';
import { stringifyNativeJson } from '../../src/core/json.js';

const input = JSON.parse(await readFile(new URL('./fixtures/editor-lifecycle/input.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('./fixtures/editor-lifecycle/native.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');

test('editor lifecycle oracle retains its independently recorded source and input identities', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/editor-lifecycle/provenance.json', import.meta.url), 'utf8'));
  for (const [name, filename] of Object.entries({ input: './fixtures/editor-lifecycle/input.json', native: './fixtures/editor-lifecycle/native.json',
    oracle: './fixtures/editor-lifecycle/Program.cs', project: './fixtures/editor-lifecycle/Oracle.csproj', buildProperties: '../Directory.Build.props' })) {
    assert.equal(digest(await readFile(new URL(filename, import.meta.url))), provenance.files[name].sha256, name);
  }
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
});

for (const scenario of input.filter(entry => entry.mode === 'content')) test(`PostgreSQL native content-type edit: ${scenario.name}`, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const expected = native.results.find(entry => entry.name === scenario.name);
  const itemId = '82000000-0000-0000-0000-000000000001';
  const item = { Id: itemId, Type: scenario.type, IsFolder: scenario.type === 'Folder', Name: 'Original', Path: scenario.path,
    VideoType: scenario.videoType, AdditionalParts: scenario.stacked ? ['part2'] : [], IsPlaceHolder: scenario.placeholder };
  const configuration = { ContentTypes: structuredClone(scenario.contentTypes ?? []) };
  let configurationSaves = 0, status, error;
  const database = await createPostgresTestDatabase(t, 'editor_lifecycle');
  const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, column.nullable ? null : type === 'DateTime' ? '2026-10-09 00:00:00'
      : type === 'bool' ? false : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));
  if (!scenario.missing) await database.insert('BaseItems', {
    ...blank, Id: itemId, Name: item.Name, Path: item.Path, IsFolder: item.IsFolder,
    Type: 'MediaBrowser.Controller.Entities.' + ({ Movie: 'Movies.Movie', Audio: 'Audio.Audio' }[scenario.type] ?? scenario.type),
    Data: JSON.stringify({ VideoType: item.VideoType, AdditionalParts: item.AdditionalParts, IsPlaceHolder: item.IsPlaceHolder }),
  });
  const library = { store: new DomainStore(database), options: {},
    load: async (connection, _user, { baseRows }) => loadLibrary(connection, {}, { baseRows }) };
  const service = new MetadataEditorService({ library, configuration, localization: { text: value => value }, configurationStore: {
    async updateContentTypes(transform) {
      configuration.ContentTypes = transform(configuration.ContentTypes); configurationSaves++;
      if (scenario.failConfiguration) throw new Error('Injected configuration save failure');
    }
  } });
  try { await service.updateContentType(itemId, scenario.contentType); status = 204; }
  catch (failure) {
    if (failure.status === 404) status = 404;
    else error = { type: 'IOException', Message: failure.message };
  }
  const actual = JSON.parse(stringifyNativeJson({ name: scenario.name, status, error, itemName: item.Name,
    containingFolder: containingFolderPath(item), contentTypes: configuration.ContentTypes, configurationSaves, calls: [] }));
  await service.close(); assert.deepEqual(actual, expected);
});
