import assert from 'node:assert/strict';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guid, idKey, dateText, EMPTY_ID, cleanValue } from '../../src/library/records.js';
import { ordinal, integer, folderData } from './video-discovery-fixture.js';

export async function seedNativeConstructorControl(fixture, loaded, sample) {
  // The recorder seeds one Folder and one video using native constructors.
  // These independent fixture values are not copied from a result or mapper.
  if (sample.aggregateParent) {
    const empty = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
      column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
    const aggregateId = '98C00000-0000-0000-0000-000000000003';
    await fixture.database.insert('BaseItems', { ...empty, Id: aggregateId, Type: 'MediaBrowser.Controller.Entities.AggregateFolder',
      Name: 'Aggregate', Path: path.join(fixture.stateRoot, 'physical-root'), CleanName: cleanValue('Aggregate'), IsFolder: true,
      Data: JSON.stringify({ VirtualChildren: [], PhysicalLocationsList: [], ...folderData(), IsRoot: true }) });
    await fixture.database.update('BaseItems', { Id: loaded.parent.Id }, { ParentId: aggregateId, TopParentId: loaded.parent.Id });
    await fixture.database.update('BaseItems', { Id: loaded.item.Id }, { TopParentId: loaded.parent.Id });
    loaded.parent.ParentId = aggregateId; loaded.parent.NativeTopParentId = loaded.parent.Id;
  }
  const rows = (await fixture.database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER');
  const byId = new Map(rows.map(row => [idKey(row.Id), row]));
  for (const row of rows) {
    const musicVideo = row.Type.endsWith('.MusicVideo');
    await fixture.database.update('BaseItems', { Id: row.Id }, { ChannelId: EMPTY_ID, Width: 0, Height: 0,
      UnratedType: row.Type.endsWith('.Movie') || row.Type.endsWith('.BoxSet') ? 'Movie' : musicVideo ? 'Music' : 'Other',
      ...(musicVideo ? { Artists: '' } : {}),
      MediaType: row.IsFolder ? 'Unknown' : 'Video',
      Genres: '', Studios: '', Tags: '', ProductionLocations: '', SortName: row.Name.toLowerCase() });
    let parentId = row.ParentId;
    while (parentId) {
      await fixture.database.insert('AncestorIds', { ItemId: row.Id, ParentItemId: parentId });
      parentId = byId.get(idKey(parentId))?.ParentId;
    }
  }
}

export async function insertFailure(fixture, sample) {
  const { database } = fixture;
  const table = sample.failLinks ? 'LinkedChildren' : 'BaseItems';
  const when = sample.failInsertAlternate ? ' AND NEW."OwnerId" IS NOT NULL' : '';
  await database.client.query(`CREATE FUNCTION creation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TRUE${when} THEN RAISE EXCEPTION 'Controlled creation failure'; END IF; RETURN NEW; END $$`);
  await database.client.query(`CREATE TRIGGER creation_failure BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION creation_failure()`);
}

function rewriteData(value, fixture) {
  if (Array.isArray(value)) return value.map(value => rewriteData(value, fixture));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, rewriteData(value, fixture)]));
  return typeof value === 'string' ? value.replace(fixture.stateRoot, '$STATE') : integer(value);
}

export async function completeColumns(fixture, resolved, sample) {
  const primaryIds = new Set(resolved.map(item => idKey(item.Id)));
  return (await fixture.database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER').map(row => Object.fromEntries(tableDefinition('BaseItems').columns.map(column => {
    const value = row[column.name];
    if (value == null) return [column.name, null];
    if (column.name === 'Audio') return [column.name, ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'][value] ?? value];
    if (column.name === 'Data') {
      const data = rewriteData(parseLosslessJson(value), fixture);
      if ((sample.deleteCreated || sample.mutation) && data.DateLastSaved && data.DateLastSaved !== '0001-01-01T00:00:00.0000000Z') {
        assert.equal(dateText(data.DateLastSaved), dateText(fixture.now));
        assert.equal(dateText(row.DateLastSaved), dateText(fixture.now)); data.DateLastSaved = '$UTC_SAVE';
      }
      return [column.name, data];
    }
    if (column.clrType.includes('Guid')) return [column.name, guid(value)];
    if (column.clrType.includes('DateTime')) {
      const date = dateText(value);
      if ((sample.deleteCreated || sample.mutation) && column.name === 'DateLastSaved') {
        assert.equal(date, fixture.now); return [column.name, '$UTC_SAVE'];
      }
      if (column.name === 'DateCreated' && primaryIds.has(idKey(row.Id)) && (row.Type === 'MediaBrowser.Controller.Entities.Folder' || sample.useResolveTime)) {
        assert.equal(date, fixture.now, 'Stored resolve UTC must equal the supplied clock.');
        return [column.name, '$UTC_RESOLVE'];
      }
      return [column.name, date];
    }
    return [column.name, rewriteData(value, fixture)];
  }))).sort((left, right) => ordinal(left.Id, right.Id));
}
