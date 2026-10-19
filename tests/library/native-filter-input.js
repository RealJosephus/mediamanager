import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tableDefinition } from '../../src/database/model.js';
import { decodeValue } from '../../src/database/values.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { idKey } from '../../src/library/records.js';
import { nativeQueryInputs } from './native-query-inputs.js';

// Test-only assembly from the declared, stopped neutral exchange database.
// These are the recorder's input templates, never an expected HTTP response.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function readTemplates(inputs) {
  const sourceDescriptor = inputs.reference.sourceDatabase;
  assert.equal(sha(await readFile(sourceDescriptor.filename)), sourceDescriptor.sha256);
  const source = new DatabaseSync(sourceDescriptor.filename, { readOnly: true });
  try {
    const statement = source.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?');
    statement.setReadBigInts(true);
    const folderTemplate = statement.get('11111111-1111-1111-1111-111111111111');
    const movieTemplate = statement.get('22222222-2222-2222-2222-222222222222');
    assert.ok(folderTemplate && movieTemplate);
    return { sourceDescriptor, folderTemplate, movieTemplate };
  } finally { source.close(); }
}

const upperId = value => {
  const key = idKey(value);
  assert.match(key, /^[a-f0-9]{32}$/u);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`.toUpperCase();
};
function typedRow(table, row) {
  const columns = tableDefinition(table).columns;
  assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  return Object.fromEntries(columns.map(column => {
    const value = row[column.name];
    return [column.name, value == null ? value : column.clrType.replace('?', '') === 'Guid'
      ? upperId(value) : decodeValue(column, column.type === 'TEXT' ? nativeTextBytes(value) : value, 'sqlite')];
  }));
}

export async function seedNativeFilterInput({ database, fixture }, scenarioName, inputs = nativeQueryInputs) {
  const { sourceDescriptor, folderTemplate, movieTemplate } = await readTemplates(inputs);
  assert.match(scenarioName, /^[a-z-]+$/u);
  const nativeTypes = { Folder: 'MediaBrowser.Controller.Entities.Folder', Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
    BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet', Audio: 'MediaBrowser.Controller.Entities.Audio.Audio' };
  const fixedDate = '2026-09-29 12:00:00';
  await database.transaction(async connection => {
    for (const item of fixture.items) {
      if (item.type === 'AggregateFolder') continue;
      assert.ok(Object.hasOwn(nativeTypes, item.type));
      const isFolder = ['Folder', 'BoxSet'].includes(item.type), isMovie = item.type === 'Movie';
      const defaultData = isMovie ? { VideoType: 'VideoFile', IsHD: false, IsShortcut: false, RemoteTrailers: [] } : {};
      const row = typedRow('BaseItems', {
        ...(isFolder ? folderTemplate : movieTemplate),
        Id: upperId(item.id), Type: nativeTypes[item.type],
        ParentId: item.parentId == null ? null : upperId(item.parentId), TopParentId: item.topParentId == null ? null : upperId(item.topParentId),
        Name: item.name, CleanName: item.cleanName ?? item.name.toLowerCase(), SortName: item.sortName ?? item.cleanName ?? item.name.toLowerCase(),
        Path: `Z:\\ItemFilterOracle\\${scenarioName}\\${item.key}${isFolder ? '' : '.mkv'}`,
        IsFolder: isFolder ? 1 : 0, IsMovie: isMovie ? 1 : 0, IsSeries: 0, IsVirtualItem: item.isVirtualItem ? 1 : 0,
        MediaType: item.mediaType ?? (isMovie ? 'Video' : 'Unknown'), UnratedType: isMovie ? 'Movie' : 'Other',
        PrimaryVersionId: item.primaryVersionId == null ? null : upperId(item.primaryVersionId), OwnerId: item.ownerId == null ? null : upperId(item.ownerId),
        ExtraType: item.extraType ?? null, PresentationUniqueKey: item.presentationUniqueKey ?? `item-filter-${scenarioName}-${idKey(item.id)}`,
        ProductionYear: item.productionYear ?? null, CustomRating: item.customRating ?? null,
        OfficialRating: Object.hasOwn(item, 'officialRating') ? item.officialRating : null,
        InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null, InheritedParentalRatingSubValue: item.inheritedParentalRatingSubValue ?? null,
        Tags: Object.hasOwn(item, 'tagsText') ? item.tagsText : null, Genres: null, Studios: null, ProductionLocations: null,
        DateCreated: fixedDate, DateModified: fixedDate, DateLastSaved: item.dateLastSaved ?? fixedDate,
        Data: item.dataText ?? JSON.stringify(item.data ?? defaultData),
      });
      const { Id, ...values } = row;
      assert.equal(await connection.update('BaseItems', { Id }, values), 1n);
    }
    const byKey = new Map(fixture.items.map(item => [item.key, item]));
    for (const image of fixture.images ?? []) {
      const row = typedRow('BaseItemImageInfos', { Id: upperId(image.id), Blurhash: null, DateModified: fixedDate, Height: 1,
        ImageType: image.imageType, ItemId: upperId(byKey.get(image.itemKey).id), Path: `Z:\\ItemFilterOracle\\${scenarioName}\\${image.id}.jpg`, Width: 1 });
      const { Id, ...values } = row;
      assert.equal(await connection.update('BaseItemImageInfos', { Id }, values), 1n);
    }
  });
  assert.equal(sha(await readFile(sourceDescriptor.filename)), sourceDescriptor.sha256);
}
