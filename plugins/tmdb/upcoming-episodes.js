import { nativeTextSql } from '@mediamanager/plugin-sdk/database/native-text-sql';
import { decodeNativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '@mediamanager/plugin-sdk/database/native-text';
import { createMetadataChildren } from '@mediamanager/plugin-sdk/library/metadata-children';
import { idKey } from '@mediamanager/plugin-sdk/library/records';
import { resolveSeries } from '@mediamanager/plugin-sdk/library/series-reference';
import { loadPostgresPageGraph,
  loadPostgresRowsByIds } from '@mediamanager/plugin-sdk/library/postgres-library-query';
import { quoteIdentifier as q } from '@mediamanager/plugin-sdk/database/model';
import { postgresNativeJsonEnumFunctionName, postgresOrdinalIgnoreCaseKeyFunctionName,
  postgresSafeNativeItemDataFunctionName, postgresNativeJsonGuidKeyFunctionName } from '@mediamanager/plugin-sdk/database/postgres-runtime-schema';

const tmdbKey = nativeTextOrdinalIgnoreCaseKey('Tmdb').toString('hex');
const postgresBatchSize = 32;
const postgresOrdinalKey = (db, expression) =>
  `${q(db.schemaName)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}(${expression})`;

function cancelled(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'cancelled';
}
/**
 * Production implementation of TmdbUpcomingEpisodesTask.ExecuteAsync. The
 * scheduled-task worker owns timing/history/cancellation; this class owns only
 * the native TMDB selection and per-item lifecycle order.
 */
export class TmdbUpcomingEpisodesMaintenance {
  constructor({ store, library, lifecycle, configuration, onError = () => {} } = {}) {
    if (!store || !library || !lifecycle || typeof lifecycle.remove !== 'function') {
      throw new TypeError('TMDB upcoming-episode maintenance requires library persistence and TV deletion lifecycle.');
    }
    if (configuration != null && typeof configuration !== 'object') {
      throw new TypeError('TMDB upcoming-episode maintenance configuration must be an object or null.');
    }
    if (typeof onError !== 'function') throw new TypeError('TMDB upcoming-episode maintenance error reporting must be a function.');
    Object.assign(this, { store, library, lifecycle, configuration, onError });
    this.children = createMetadataChildren({ store, library, linkedChildren: library.options.linkedChildren,
      configuration: library.options.configuration, libraryOptions: library.options.libraryOptions });
  }

  async #state({ types, virtual, tmdb = false, afterId = '' } = {}) {
    return this.store.run(async db => {
      const predicates = [`substring(${nativeTextSql(db.schemaName).projection('item."Type"')} from '[^.]+$') = ANY($1::text[])`];
      const values = [types];
      if (virtual !== undefined) predicates.push(`item."IsVirtualItem" IS ${virtual ? 'TRUE' : 'FALSE'}`);
      if (tmdb) predicates.push(`EXISTS (
        SELECT 1 FROM ${q(db.schemaName)}."BaseItemProviders" provider
        WHERE ${nativeTextSql(db.schemaName).guidLower("provider.\"ItemId\"")} = ${nativeTextSql(db.schemaName).guidLower("item.\"Id\"")}
          AND ${postgresOrdinalKey(db, 'provider."ProviderId"')} = decode('${tmdbKey}', 'hex')
          AND provider."ProviderValue" <> ''
      )`);
      values.push(idKey(afterId), postgresBatchSize);
      const result = await db.client.query({
        text: `SELECT item."Id", count(*) OVER () AS "__TotalRecordCount"
          FROM ${q(db.schemaName)}."BaseItems" item
          WHERE ${predicates.join(' AND ')}
            AND replace(${nativeTextSql(db.schemaName).guidLower("item.\"Id\"")}, '-', '') > $${values.length - 1}
          ORDER BY replace(${nativeTextSql(db.schemaName).guidLower("item.\"Id\"")}, '-', '') ASC
          LIMIT $${values.length}`,
        values,
      });
      const rows = await loadPostgresRowsByIds(db, result.rows.map(row => decodeNativeTextBytes(row.Id)));
      const graphRows = await loadPostgresPageGraph(db, rows, []);
      const total = result.rows.length ? Number(result.rows[0].__TotalRecordCount) : 0;
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid TMDB maintenance count.');
      return {
        state: await this.library.load(db, null, { includeUserData: false, baseRows: graphRows, includeManualLinks: false, includeFolderLinks: false, includeLinkGraph: false }),
        candidateIds: result.rows.map(row => decodeNativeTextBytes(row.Id)),
        total,
      };
    }, {
      readOnly: true,
      lockTimeoutMs: 250,
    });
  }

  async #seriesState(configuration, afterId = '') {
    return this.store.run(async db => {
      const sql = nativeTextSql(db.schemaName), baseItems = `${q(db.schemaName)}."BaseItems"`;
      const data = `${q(db.schemaName)}.${q(postgresSafeNativeItemDataFunctionName)}(collection."Type", collection."Data")`;
      const array = property => `json_array_elements(CASE WHEN json_typeof(data -> '${property}') = 'array'
        THEN data -> '${property}' ELSE '[]'::json END)`;
      const enabledRoots = `enabled_collections AS MATERIALIZED (
        SELECT ${data} AS data FROM ${baseItems} collection
        WHERE substring(${sql.projection('collection."Type"')} from '[^.]+$') = 'CollectionFolder'
          AND ${sql.guidKey('collection."Id"')} = ANY($1::text[])
      ), enabled_roots AS (
        SELECT ${q(db.schemaName)}.${q(postgresNativeJsonGuidKeyFunctionName)}(entry.value) AS "Key"
        FROM enabled_collections CROSS JOIN LATERAL ${array('PhysicalFolderIds')} entry(value)
        UNION
        SELECT ${sql.guidKey('physical."Id"')} AS "Key"
        FROM enabled_collections CROSS JOIN LATERAL (
          SELECT value FROM ${array('PhysicalLocations')}
          UNION ALL SELECT value FROM ${array('PhysicalLocationsList')}
        ) location JOIN ${baseItems} physical
          ON ${sql.pathKey('physical."Path"')} = ${sql.pathKey(sql.fromProjection("location.value #>> '{}'"))}
        WHERE substring(${sql.projection('physical."Type"')} from '[^.]+$') = 'Folder'
      )`;
      const result = await db.client.query({
        text: `WITH ${enabledRoots} SELECT item."Id", count(*) OVER () AS "__TotalRecordCount"
          FROM ${q(db.schemaName)}."BaseItems" item
          WHERE substring(${nativeTextSql(db.schemaName).projection('item."Type"')} from '[^.]+$') = 'Series'
            AND EXISTS (
              SELECT 1 FROM ${q(db.schemaName)}."BaseItemProviders" provider
              WHERE ${nativeTextSql(db.schemaName).guidLower("provider.\"ItemId\"")} = ${nativeTextSql(db.schemaName).guidLower("item.\"Id\"")}
                AND ${postgresOrdinalKey(db, 'provider."ProviderId"')} = decode('${tmdbKey}', 'hex')
                AND provider."ProviderValue" <> ''
            )
            AND (${q(db.schemaName)}.${q(postgresNativeJsonEnumFunctionName)}(
              ${q(db.schemaName)}.${q(postgresSafeNativeItemDataFunctionName)}(
                item."Type", item."Data") -> 'Status', 'SeriesStatus') IS DISTINCT FROM 'Ended'
              OR NOT COALESCE(replace(${nativeTextSql(db.schemaName).guidLower("item.\"TopParentId\"")}, '-', '') IN (SELECT "Key" FROM enabled_roots), FALSE))
            AND replace(${nativeTextSql(db.schemaName).guidLower("item.\"Id\"")}, '-', '') > $2
          ORDER BY replace(${nativeTextSql(db.schemaName).guidLower("item.\"Id\"")}, '-', '') ASC
          LIMIT $3`,
        values: [configuration.EnabledMissingEpisodeLibraries.map(idKey), idKey(afterId), postgresBatchSize],
      });
      const rows = await loadPostgresRowsByIds(db, result.rows.map(row => decodeNativeTextBytes(row.Id)));
      const graphRows = await loadPostgresPageGraph(db, rows, []);
      const total = result.rows.length ? Number(result.rows[0].__TotalRecordCount) : 0;
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid TMDB series count.');
      return {
        state: await this.library.load(db, null, { includeUserData: false, baseRows: graphRows, includeManualLinks: false, includeFolderLinks: false, includeLinkGraph: false }),
        candidateIds: result.rows.map(row => decodeNativeTextBytes(row.Id)),
        total,
      };
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  #report(error, series) {
    try {
      void Promise.resolve(this.onError(error, series)).catch(() => {});
    } catch { /* Per-series diagnostics cannot replace the scheduled pass. */ }
  }

  async #removeAllVirtualItems(reportProgress, signal) {
    let afterId = '', processed = 0, episodeTotal = null;
    for (;;) {
      const batch = await this.#state({ types: ['Episode'], virtual: true, tmdb: true, afterId });
      try {
        const candidates = batch.candidateIds.map(id => batch.state.byId.get(idKey(id))).filter(Boolean);
        episodeTotal ??= batch.total;
        if (!candidates.length) break;
        for (const episode of candidates) {
          signal?.throwIfAborted();
          await this.lifecycle.remove(episode);
          processed++;
          if (episodeTotal > 0) reportProgress(95 * Math.min(processed, episodeTotal) / episodeTotal);
        }
        afterId = batch.candidateIds.at(-1);
      } finally { await batch.state.dispose(); }
    }

    // Query again after the independently committed episode deletions. Native
    // GetItemList observes that new repository state before deciding whether a
    // virtual season is empty.
    afterId = '';
    for (;;) {
      const batch = await this.#state({ types: ['Season'], virtual: true, tmdb: true, afterId });
      try {
        const seasons = batch.candidateIds.map(id => batch.state.byId.get(idKey(id))).filter(Boolean);
        if (!seasons.length) break;

        for (const season of seasons) {
          signal?.throwIfAborted();
          const episodes = await this.children.seasonEpisodes(season, {
            physicalSeriesId: resolveSeries(season, batch.state.byId)?.Id,
          });
          try {
            if ((await episodes.count()) === 0n) await this.lifecycle.remove(season);
          } finally { await episodes.close(); }
        }
        afterId = batch.candidateIds.at(-1);
      } finally { await batch.state.dispose(); }
    }
    reportProgress(100);
  }

  async run({ signal, reportProgress = () => {} } = {}) {
    const configuration = this.configuration;
    if (configuration == null) {
      reportProgress(100);
      return;
    }
    if ((!configuration.ImportUnairedEpisodes && !configuration.ImportMissingEpisodes)
      || configuration.EnabledMissingEpisodeLibraries.length === 0) {
      await this.#removeAllVirtualItems(reportProgress, signal);
      return;
    }

    let afterId = '', processed = 0, total = null;
    for (;;) {
      const batch = await this.#seriesState(configuration, afterId);
      try {
        const series = batch.candidateIds.map(id => batch.state.byId.get(idKey(id))).filter(Boolean);
        total ??= batch.total;
        if (!series.length) break;
        for (const item of series) {
          signal?.throwIfAborted();
          try {
            await this.library.validateChildren(item, {
              MetadataRefreshMode: 'Default',
              ImageRefreshMode: 'ValidationOnly',
              IsAutomated: true,
              recursive: true,
              signal,
              reportProgress() {},
            });
          } catch (error) {
            if (cancelled(error, signal)) throw error;
            this.#report(error, item);
          }
          processed++;
          if (total > 0) reportProgress(100 * Math.min(processed, total) / total);
        }
        afterId = batch.candidateIds.at(-1);
      } finally { await batch.state.dispose(); }
    }
    if (processed !== total) reportProgress(100);
  }
}
