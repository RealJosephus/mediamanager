import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes } from '../database/native-text.js';
import { lowerInvariant, md5Guid } from '../core/identity.js';
import { nativeGuid, wireGuid } from '../users/native.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { defaultLibraryOptions } from './options.js';
import { idKey, libraryError, nonemptyId } from './records.js';

export const mediaSegmentTypes = Object.freeze(['Unknown', 'Commercial', 'Preview', 'Recap', 'Outro', 'Intro']);
const columns = tableDefinition('MediaSegments').columns;
export const mediaSegmentProviderId = name => md5Guid(lowerInvariant(name));

function readAndCloseFailure(primary, cleanup) {
  const failure = new AggregateError([primary, cleanup], 'Media segment read and cursor cleanup failed.', { cause: primary });
  if (primary !== null && ['object', 'function'].includes(typeof primary)) for (const key of ['code', 'status', 'statusCode']) {
    // Preserve public error metadata without allowing a hostile getter or
    // proxy to replace the actual read rejection or cleanup order.
    try { if (key in primary) failure[key] = primary[key]; } catch { }
  }
  return failure;
}

function segmentDto(raw) {
  const row = Object.fromEntries(columns.map(column => [column.name, decodeValue(column, raw[column.name], 'postgres')]));
  return { Id: wireGuid(row.Id), ItemId: wireGuid(row.ItemId), Type: mediaSegmentTypes[row.Type] ?? row.Type,
    StartTicks: row.StartTicks, EndTicks: row.EndTicks };
}

// Provider identities only filter existing rows. This read service never invokes
// analysis, extraction, Supports, or a provider's generation/cleanup methods.
export class MediaSegmentService {
  constructor({ store, library, providers = () => [] }) { Object.assign(this, { store, library, providers }); }

  read(itemId, { user = null, includeSegmentTypes = null, signal, consume }) {
    if (typeof consume !== 'function') throw new TypeError('Media segment reads require a bounded consumer.');
    if (!nonemptyId(itemId)) throw libraryError(400, "Guid can't be empty. (Parameter 'id')");
    return this.store.run(async database => {
      const selected = await this.library.withItemRecord(itemId, { user }, async item => {
        const folders = item.Type === 'CollectionFolder' ? [item] : await this.library.getCollectionFolders(item);
        const folder = folders.find(value => value.Type === 'CollectionFolder');
        const options = this.library.options.libraryOptions;
        const libraryOptions = (options instanceof Map ? options.get(idKey(folder?.Id)) ?? options.get(folder?.Id)
          : options?.[folder?.Id] ?? options?.[idKey(folder?.Id)]) ?? defaultLibraryOptions();
        const disabled = libraryOptions.DisabledMediaSegmentProviders ?? [];
        const providerIds = this.providers().filter(provider => {
          return !disabled.some(name => name != null && ordinalIgnoreCaseKey(name) === ordinalIgnoreCaseKey(provider.name));
        })
          .map(provider => mediaSegmentProviderId(provider.name));
        return { itemId: item.Id, providerIds };
      });
      if (!selected.providerIds.length || includeSegmentTypes?.length === 0) {
        return await consume({ TotalRecordCount: 0, StartIndex: 0 }, (async function* () {})());
      }
      const values = [nativeTextBytes(nativeGuid(selected.itemId)), selected.providerIds.map(nativeTextBytes)];
      const typeFilter = includeSegmentTypes === null ? '' : ' AND segment."Type" = ANY($3::integer[])';
      if (includeSegmentTypes !== null) values.push(includeSegmentTypes);
      // The cursor freezes the full SQL selection/count while Node retains at
      // most one 128-row page. SQLite's equal-start rowid order survives exchange.
      let cursorCleanup, cursorCleanupFailed = false;
      try { return await database.transaction(async () => {
        await database.client.query(`DECLARE media_segment_entries NO SCROLL CURSOR FOR
          SELECT ${columns.map(column => `segment.${q(column.name)}`).join(', ')}, count(*) OVER () AS "__count"
          FROM ${q(database.schemaName)}."MediaSegments" segment
          JOIN ${q(database.controlSchema)}."media_segment_order" sequence ON sequence.segment_id = segment."Id"
          WHERE segment."ItemId" = $1::bytea AND segment."SegmentProviderId" = ANY($2::bytea[])${typeFilter}
          ORDER BY segment."StartTicks", sequence.position`, values);
        let failed = false, primary;
        try {
          const fetch = async () => {
            signal?.throwIfAborted();
            const rows = (await database.client.query('FETCH FORWARD 128 FROM media_segment_entries')).rows;
            signal?.throwIfAborted(); return rows;
          };
          let first = await fetch();
          const count = Number(first[0]?.__count ?? 0);
          async function* pages() {
            let rows = first; first = null;
            while (rows.length) { yield rows.map(segmentDto); rows = await fetch(); }
          }
          return await consume({ TotalRecordCount: count, StartIndex: 0 }, pages());
        } catch (error) { failed = true; primary = error; throw error; }
        finally {
          try { await database.client.query('CLOSE media_segment_entries'); }
          catch (error) {
            cursorCleanupFailed = true; cursorCleanup = error;
            if (failed) throw readAndCloseFailure(primary, error);
            throw error;
          }
        }
      }, { readOnly: true, signal }); }
      finally {
        // Let transaction() finish its real ROLLBACK before marking the facade
        // unusable. An early discard would itself manufacture a rollback error
        // and replace the original consumer/close error's public metadata.
        if (cursorCleanupFailed) database.discardConnection(cursorCleanup);
      }
    }, { signal });
  }
}
