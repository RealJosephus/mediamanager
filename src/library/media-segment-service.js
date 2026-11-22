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
export const embyMarkerProviderName = 'Emby Chapter Markers';
export const introSkipperProviderName = 'Intro Skipper';
export const analysisProviderName = 'MediaManager Intro and Credits';

// Native Web reads MediaSourceInfo.HasSegments before requesting the segments.
// Use the same authoritative plugin rows for this flag and for the playback API.
export async function readProjectedSegmentFlags(db, ids) {
  const control = q(db.controlSchema), native = q(db.schemaName);
  const { rows } = await db.client.query(`SELECT item, (
    EXISTS(SELECT 1 FROM ${native}."MediaSegments" s WHERE s."ItemId"=item AND (s."SegmentProviderId"<>$2 OR s."Type" NOT IN (1,2,3,4,5)))
    OR EXISTS(SELECT 1 FROM ${control}.intro_skipper_segments p WHERE p.item_id=item)
    ) AS present FROM unnest($1::bytea[]) AS requested(item)`, [
    ids.map(id => nativeTextBytes(nativeGuid(id))), nativeTextBytes(mediaSegmentProviderId(introSkipperProviderName)),
  ]);
  return rows.map(row => [idKey(row.item.toString('utf8')), row.present]);
}

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
  constructor({ store, library, providers = () => [], skipperProjection = false }) { Object.assign(this, { store, library, providers, skipperProjection }); }

  async disabledProviders(item) {
    const folders = item.Type === 'CollectionFolder' ? [item] : await this.library.getCollectionFolders(item);
    const folder = folders.find(value => value.Type === 'CollectionFolder');
    const options = this.library.options.libraryOptions;
    const libraryOptions = (options instanceof Map ? options.get(idKey(folder?.Id)) ?? options.get(folder?.Id)
      : options?.[folder?.Id] ?? options?.[idKey(folder?.Id)]) ?? defaultLibraryOptions();
    return (libraryOptions.DisabledMediaSegmentProviders ?? []).filter(name => name != null).map(ordinalIgnoreCaseKey);
  }

  async providerEnabled(itemId, name) {
    return this.library.withItemRecord(itemId, {}, async item => !(await this.disabledProviders(item)).includes(ordinalIgnoreCaseKey(name)));
  }

  async hasPublishedProvider(name) {
    return this.store.run(async db => Boolean((await db.rows('MediaSegments', {
      where: { SegmentProviderId:mediaSegmentProviderId(name) }, columns:['Id'], limit:1,
    })).length));
  }

  async heldTypes(itemId, signal, connection) {
    const read = async db => {
      const held = new Set((await db.rows('MediaSegments', { where: { ItemId: itemId }, columns: ['Type'] })).map(r => r.Type));
      const table = q(db.controlSchema) + '."intro_skipper_protected"';
      if (this.skipperProjection) for (const { type } of (await db.client.query('SELECT type FROM ' + table + ' WHERE item_id=$1', [nativeTextBytes(nativeGuid(itemId))])).rows) held.add(type);
      return held;
    };
    return connection ? read(connection) : this.store.run(read, { signal });
  }

  async saveMissing(item, provider, candidates, signal) {
    if (!(await this.providerEnabled(item.Id, provider))) return;
    return this.store.run(db => db.transaction(async tx => {
      const [current] = await tx.rows('BaseItems', { where: { Id: item.Id }, columns: ['Path', 'RunTimeTicks', 'DateModified'] });
      if (!current || current.Path !== item.Path || current.RunTimeTicks !== item.RunTimeTicks || current.DateModified !== item.DateModified) return;
      const held = await this.heldTypes(item.Id, signal, tx);
      for (const { Id, Type, StartTicks, EndTicks } of candidates) {
        if (held.has(Type) || StartTicks < 0n || EndTicks <= StartTicks || EndTicks > current.RunTimeTicks) continue;
        await tx.insert('MediaSegments', { Id, Type, StartTicks, EndTicks, ItemId: item.Id, SegmentProviderId: mediaSegmentProviderId(provider) });
      }
    }, { writeLockTables: ['MediaSegments'], signal }), { signal });
  }

  read(itemId, { user = null, includeSegmentTypes = null, signal, consume }) {
    if (typeof consume !== 'function') throw new TypeError('Media segment reads require a bounded consumer.');
    if (!nonemptyId(itemId)) throw libraryError(400, "Guid can't be empty. (Parameter 'id')");
    return this.store.run(async database => {
      const selected = await this.library.withItemRecord(itemId, { user }, async item => {
        const disabled = await this.disabledProviders(item);
        const providerIds = this.providers().filter(provider => {
          return !disabled.includes(ordinalIgnoreCaseKey(provider.name));
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
        const usePrivate = this.skipperProjection && selected.providerIds.includes(mediaSegmentProviderId(introSkipperProviderName));
        if (usePrivate) {
          values.push(nativeTextBytes(mediaSegmentProviderId(introSkipperProviderName)));
          const skipper = '$' + values.length;
          const ctl = q(database.controlSchema);
          await database.client.query(`DECLARE media_segment_entries NO SCROLL CURSOR FOR
            SELECT segment.*,count(*) OVER () AS "__count" FROM (
              SELECT ${columns.map(c => 's.' + q(c.name)).join(',')},o.position FROM ${q(database.schemaName)}."MediaSegments" s
              JOIN ${ctl}.media_segment_order o ON o.segment_id=s."Id"
              WHERE s."ItemId"=$1 AND s."SegmentProviderId"=ANY($2::bytea[]) AND (s."SegmentProviderId"<>${skipper} OR s."Type" NOT IN (1,2,3,4,5))
              UNION ALL SELECT ${columns.map(c => ({ Id:'p.id',ItemId:'p.item_id',Type:'p.type',StartTicks:'p.start_ticks',EndTicks:'p.end_ticks',SegmentProviderId:skipper + '::bytea' }[c.name])).join(',')},
                coalesce(o.position, p.position+4611686018427387904) FROM ${ctl}.intro_skipper_segments p
                LEFT JOIN ${ctl}.media_segment_order o ON o.segment_id=p.id WHERE p.item_id=$1
            ) segment WHERE true${typeFilter} ORDER BY segment."StartTicks",segment.position,segment."Id"`, values);
        } else await database.client.query(`DECLARE media_segment_entries NO SCROLL CURSOR FOR
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
