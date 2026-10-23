import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import { dtoOptions, itemImageTypes, projectItem } from '../../src/library/dto.js';
import { cleanValue, idKey, MIN_DATE } from '../../src/library/records.js';
import { stringifyNativeJson } from '../../src/core/json.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const inputUrl = new URL('./fixtures/dto-inherited-images/input.json', import.meta.url);
const inputBytes = await readFile(inputUrl), input = JSON.parse(inputBytes);
const itemId = index => `982f0000000000000000${String(index + 1).padStart(12, '0')}`;
const imageId = index => `983f0000000000000000${String(index + 1).padStart(12, '0')}`;
const fields = new Set(['ImageTags', 'BackdropImageTags', 'ImageBlurHashes', 'ParentPrimaryImageItemId', 'ParentPrimaryImageTag',
  'ParentLogoItemId', 'ParentLogoImageTag', 'ParentArtItemId', 'ParentArtImageTag', 'ParentThumbItemId',
  'ParentThumbImageTag', 'ParentBackdropItemId', 'ParentBackdropImageTags', 'AlbumPrimaryImageTag', 'AlbumId']);
const snapshot = async database => Object.fromEntries(await Promise.all(
  ['BaseItems', 'BaseItemImageInfos', 'ItemValues', 'ItemValuesMap'].map(async table => [table, await database.rows(table)])));

test('inherited DTO images match the actual native image field graph and cache tags', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'dto-inherited-images-' + randomUUID());
  await mkdir(output);
  const recording = await recordOracle({ project: 'tests/library/fixtures/dto-inherited-images/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(inputUrl), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json'), 'utf8'));
  assert.equal(recording.passed, true);
  assert.equal(native.actualDtoExecution, true);
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(native.assemblies.find(assembly => assembly.FullName.startsWith('jellyfin,')).sha256, recording.jellyfinDll.sha256);
  assert.equal(native.results.length, input.cases.length);
  const database = await createPostgresTestDatabase(t, 'dto_images');
  const store = new DomainStore(database), library = new LibraryService({ store, serverId: 'dto-images', programDataPath: 'Z:\\ImageContracts' });
  await attachLibraryNavigation(library);
  const results = [];
  try {
    for (const [caseIndex, sample] of input.cases.entries()) {
      await library.itemCreation.close();
      await database.client.query(`TRUNCATE TABLE "${database.schemaName}"."BaseItems", "${database.schemaName}"."ItemValues" CASCADE`);
      const ids = new Map(sample.items.map((item, index) => [item.key, itemId(index)]));
      for (const definition of sample.items) {
        const data = {};
        for (const name of ['Artists', 'AlbumArtists']) if (Object.hasOwn(definition, name)) data[name] = definition[name];
        if (definition.viewType) data.ViewType = definition.viewType;
        if (definition.displayParent) data.DisplayParentId = ids.get(definition.displayParent);
        await database.insert('BaseItems', postgresTestRow('BaseItems', {
          Id: ids.get(definition.key), Type: native.types[definition.Type], Name: definition.Name,
          CleanName: cleanValue(definition.Name), SortName: cleanValue(definition.Name), Path: definition.Path,
          Artists: definition.Artists?.join('|') ?? null, AlbumArtists: definition.AlbumArtists?.join('|') ?? null,
          IsFolder: ['Folder', 'CollectionFolder', 'PlaylistsFolder', 'MusicAlbum', 'MusicArtist', 'Series', 'Season',
            'UserRootFolder', 'UserView', 'AggregateFolder', 'BoxSet', 'PhotoAlbum'].includes(definition.Type),
          DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE, Data: JSON.stringify(data),
        }));
      }
      let imageIndex = 0;
      const values = new Map();
      for (const definition of sample.items) {
        const id = ids.get(definition.key);
        const references = Object.fromEntries([['parent', 'ParentId'], ['owner', 'OwnerId'], ['season', 'SeasonId'], ['series', 'SeriesId']]
          .filter(([key]) => definition[key]).map(([key, column]) => [column, ids.get(definition[key])]));
        if (Object.keys(references).length) await database.update('BaseItems', { Id: id }, references);
        for (const [type, property] of [[0, 'Artists'], [1, 'AlbumArtists']]) for (const name of definition[property] ?? []) {
          const key = type + '\0' + name;
          if (!values.has(key)) {
            const valueId = randomUUID(); values.set(key, valueId);
            await database.insert('ItemValues', { ItemValueId: valueId, Type: type, Value: name, CleanValue: cleanValue(name) });
          }
          await database.insert('ItemValuesMap', { ItemId: id, ItemValueId: values.get(key) });
        }
        for (const image of definition.images ?? []) await database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', {
          Id: imageId(imageIndex++), ItemId: id, ImageType: itemImageTypes.indexOf(image.type),
          Path: definition.Path + '.' + image.type + '.png', DateModified: image.stamp, Blurhash: Buffer.from(image.hash), Width: 10, Height: 20,
        }));
      }
      const before = await snapshot(database);
      await store.run(async session => {
        const baseRows = await session.rows('BaseItems');
        // The native dependency boundary supplies this scenario's collection
        // folders. Bind its declared root instead of deriving a different root
        // from the unrelated common program-data directory.
        library.options.userRoot = baseRows.find(row => row.Type === native.types.UserRootFolder) ?? null;
        const state = await library.load(session, null, { baseRows });
        try {
          const target = state.byId.get(idKey(ids.get(sample.target)));
          if (sample.batch) state.dtoImageArtistsBatch = await state.getDtoArtists(target.AlbumArtists);
          const selected = dtoOptions({ fields: [], enableuserdata: false, enableimages: sample.options?.enableImages,
            imagetypelimit: sample.options?.limit, enableimagetypes: sample.options?.types });
          const result = await projectItem(target, state, null, selected, { ...library.options,
            owner: sample.owner ? state.byId.get(idKey(ids.get(sample.owner))) : undefined });
          const wire = JSON.parse(stringifyNativeJson(result));
          const images = Object.fromEntries(Object.entries(wire).filter(([name]) => fields.has(name)));
          results.push({ name: sample.name, images });
          assert.deepEqual(images, native.results[caseIndex].images, sample.name);
        } finally { await state.dispose({ session }); }
      });
      assert.deepEqual(await snapshot(database), before, sample.name + ' is read-only');
    }
  } finally {
    try { await writeFile(path.join(output, 'postgres.json'), JSON.stringify({ results, scope: native.scope }, null, 2) + '\n', { flag: 'wx' }); }
    finally { await closeLibraryNavigation(library); }
  }
});
