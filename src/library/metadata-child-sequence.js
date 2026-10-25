import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';

const scalarColumns = Object.freeze({
  Id: 'bytea', Type: 'bytea', ItemType: 'bytea', ParentId: 'bytea', OwnerId: 'bytea', Path: 'bytea', Name: 'bytea', SortName: 'bytea', ForcedSortName: 'bytea',
  SeasonId: 'bytea', SeriesId: 'bytea', PresentationUniqueKey: 'bytea', SeriesPresentationUniqueKey: 'bytea', LocationType: 'bytea', SourceType: 'bytea',
  OfficialRating: 'bytea', CustomRating: 'bytea', Album: 'bytea', PremiereDate: 'bytea', DateCreated: 'bytea', DateLastMediaAdded: 'bytea',
  IsFolder: 'boolean', IsVirtualItem: 'boolean', ProductionYear: 'integer', ParentIndexNumber: 'integer', IndexNumber: 'integer', IndexNumberEnd: 'integer',
  AirsAfterSeasonNumber: 'integer', AirsBeforeSeasonNumber: 'integer', AirsBeforeEpisodeNumber: 'integer', RunTimeTicks: 'bigint',
  Genres: 'bytea[]', Studios: 'bytea[]', Artists: 'bytea[]', AlbumArtists: 'bytea[]',
  MusicBrainzAlbumArtist: 'bytea', MusicBrainzAlbum: 'bytea', MusicBrainzReleaseGroup: 'bytea'
});

/** Each yielded page owns its exact typed entities until the consumer advances
 * or returns. The whole captured relation stays owned until explicit close. */
export function metadataChildSequence(cohort, linkedChildren, store) {
  let closed = false;
  const active = () => { if (closed) throw new Error('The metadata child sequence has been released.'); };
  async function* pages() {
    active();
    for (let after = 0n; ;) {
      const page = await cohort.page({ after, limit: 128 });
      try {
        if (!page.entries.length) return;
        after = page.entries.at(-1).Ordinal;
        yield page.entries.map(entry => entry.item);
      } finally { await page.release(); }
    }
  }
  return Object.freeze({ pages,
    async withItemAtOrdinal(ordinal, operation) {
      active(); if (typeof ordinal!=='bigint'||ordinal<=0n) throw new TypeError('A positive bigint ordinal is required.');
      const page=await cohort.page({after:ordinal-1n,limit:1});
      let primary, operationFailed=false;
      try { const entry=page.entries[0]; return await operation(entry?.Ordinal===ordinal?entry.item:null); }
      catch(error) {primary=error;operationFailed=true;throw error;}
      finally {
        try {await page.release();}
        catch(cleanup) {
          if(operationFailed)throw new AggregateError([primary,cleanup],primary?.message??'Metadata child callback and release failed.',{cause:primary});
          throw cleanup;
        }
      }
    },
    count() { active(); return cohort.count(); },
    async some(predicate) { for await (const page of pages()) for (const item of page) if (await predicate(item)) return true; return false; },
    aggregationSession(operation) {
      active();
      return store.run(async session => {
        const table = q('mm_metadata_projection_' + randomUUID().replaceAll('-', ''));
        const fields = Object.entries(scalarColumns);
        let primaryError;
        try {
          await session.client.query(`CREATE TEMP TABLE ${table}("Ordinal" bigint PRIMARY KEY,${fields.map(([field, type]) => `${q(field)} ${type}`).join(',')})`);
          let ordinal = 0n;
          for await (const page of pages()) {
            const rows = page.map(item => [++ordinal, ...fields.map(([field, type]) => {
              let value = field === 'Type' ? item.NativeType : field === 'ItemType' ? item.Type : item[field];
              if (field.startsWith('MusicBrainz')) {
                const key = Object.keys(item.ProviderIds ?? {}).find(key => key.toUpperCase() === field.toUpperCase());
                value = item.ProviderIds?.[key] || null;
              }
              if (value == null) return null;
              if (type === 'bytea[]') return value.map(entry => entry == null ? null : nativeTextBytes(entry));
              return type === 'bytea' ? nativeTextBytes(String(value)) : value;
            })]);
            const values = rows.flat(), width = fields.length + 1;
            await session.client.query({ text: `INSERT INTO ${table} VALUES ${rows.map((_, row) => '(' + Array.from({ length: width }, (_, column) => '$' + (row * width + column + 1)).join(',') + ')').join(',')}`, values });
          }
          return await operation(session, { plan: Object.freeze({ text: `SELECT * FROM ${table} ORDER BY "Ordinal"`, values: Object.freeze([]) }) });
        } catch (error) { primaryError = error; throw error; }
        finally {
          // A discarded backend will delete every temporary object on release.
          // Its facade rejects queries, so do not overwrite the callback error
          // with another query to that same discarded connection.
          if (!session.connectionReleaseError) {
            try { await session.client.query(`DROP TABLE IF EXISTS ${table}`); }
            catch (cleanupError) {
              // Projection creation and the callback share the owning
              // transaction; its rollback removes this temporary table.
              if (!(primaryError && session.inTransaction && cleanupError.code === '25P02')) {
                session.discardConnection(cleanupError);
                if (primaryError) throw new AggregateError([primaryError, cleanupError], primaryError.message, { cause: primaryError });
                throw cleanupError;
              }
            }
          }
        }
      });
    },
    async close() { if (closed) return; closed = true; await cohort.release(); }
  });
}
