import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { resolvePostgresSearchCollation, releasePostgresSearchCollation } from './postgres-search-provider.js';

const countValue = value => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('PostgreSQL returned an invalid channel count.');
  return count;
};

/** CLR OrderBy(string) is stable for culture-equal provider names. The input
 * is the installed extension inventory, rather than library candidates. */
export async function orderPostgresChannelProviders(database, providers, culture = 'en-US') {
  if (!providers.length) return [];
  let collation, failure;
  try {
    collation = await resolvePostgresSearchCollation(database, culture);
    const result = await database.client.query({ text: `SELECT ordinal FROM unnest($1::bytea[]) WITH ORDINALITY provider(name, ordinal)
      ORDER BY ${nativeTextSql(database.schemaName).projection('provider.name')} COLLATE ${q(collation.schema)}.${q(collation.name)} ASC NULLS FIRST, ordinal`,
    values: [providers.map(provider => nativeTextBytes(provider.name))] });
    return result.rows.map(row => providers[Number(row.ordinal) - 1]);
  } catch (error) { failure = error; throw error; }
  finally { await releasePostgresSearchCollation(collation, failure); }
}

/** Native first creates every installed channel, then applies list filters.
 * This owned relation holds identities and live SortName projections. Scope,
 * user predicates, count, ordering and List.GetRange paging remain in SQL. */
export async function createPostgresChannelCatalog(database, { culture = 'en-US' } = {}) {
  const name = 'mm_channels_' + randomUUID().replaceAll('-', ''), table = `${q('pg_temp')}.${q(name)}`;
  const sql = nativeTextSql(database.schemaName);
  let attempted = false, closing, collation, failure;
  const close = primary => closing ??= (async () => {
    let cleanup;
    if (attempted) try { await database.client.query(`DROP TABLE IF EXISTS ${table}`); }
    catch (error) {
      if (!(primary && database.inTransaction && error.code === '25P02')) { database.discardConnection(error); cleanup = error; }
    }
    await releasePostgresSearchCollation(collation, primary, cleanup ? [cleanup] : []);
  })();
  try {
    collation = await resolvePostgresSearchCollation(database, culture);
    attempted = true;
    await database.client.query(`CREATE TEMP TABLE ${q(name)} (ordinal bigint PRIMARY KEY, "Id" bytea NOT NULL, slot text NOT NULL,
      "SortName" bytea, recordings boolean, latest boolean, deletion boolean, enabled boolean, allowed boolean)`);
    const order = `replace(replace(${sql.projection('channel."SortName"')}, chr(1) || '0', ''), chr(1) || '1', '') COLLATE ${q(collation.schema)}.${q(collation.name)} ASC NULLS FIRST, channel.ordinal`;
    const assertOpen = () => { if (closing) throw new Error('The channel catalog is closed.'); };
    const markerWhere = input => {
      const values = [], parts = [];
      for (const [key, column] of [['IsRecordingsFolder', 'recordings'], ['SupportsLatestItems', 'latest'], ['SupportsMediaDeletion', 'deletion']]) {
        if (input[key] != null) parts.push(`channel.${column} = $${values.push(input[key])}::boolean`);
      }
      return { text: parts.length ? parts.join(' AND ') : 'TRUE', values };
    };
    const access = (query, { userId, visibility, channelPolicy } = {}) => {
      const markers = markerWhere(query);
      const source = buildPostgresItemPageQuery(database, {
        ...(query.IsFavorite != null ? { isfavorite: query.IsFavorite } : {}),
      }, { itemIdsPlan: { text: `SELECT channel."Id" FROM ${table} channel WHERE ${markers.text}`, values: markers.values },
        userId, includeOwnedItems: true, includeAlternateVersions: true, groupByPresentationKey: false,
        resumableMode: 'memory', visibility });
      const values = [...source.values];
      const restrictions = [];
      if (channelPolicy) {
        const blocked = channelPolicy.BlockedChannels ?? [];
        if (blocked.length) restrictions.push(`NOT (${sql.guidKey('channel."Id"')} = ANY($${values.push(blocked.map(value => value.replaceAll('-', '').toLowerCase()))}::text[]))`);
        else if (channelPolicy.EnableAllChannels !== true) restrictions.push(`${sql.guidKey('channel."Id"')} = ANY($${values.push((channelPolicy.EnabledChannels ?? []).map(value => value.replaceAll('-', '').toLowerCase()))}::text[])`);
      }
      return { values, text: `channel."Id" IN (SELECT selected."Id" FROM (${source.text}) selected WHERE selected."Id" IS NOT NULL)${restrictions.length ? ' AND ' + restrictions.join(' AND ') : ''}` };
    };
    return Object.freeze({ close,
      async append(entries) {
        assertOpen();
        if (!entries.length || entries.length > 128) throw new TypeError('A channel catalog append requires 1..128 projections.');
        await database.client.query({ text: `INSERT INTO ${table}(ordinal, "Id", "SortName", recordings, latest, deletion, enabled, slot) SELECT * FROM unnest($1::bigint[], $2::bytea[], $3::bytea[], $4::boolean[], $5::boolean[], $6::boolean[], $7::boolean[], $8::text[])`,
          values: [entries.map(entry => entry.ordinal), entries.map(entry => nativeTextBytes(entry.Id)), entries.map(entry => entry.SortName == null ? null : nativeTextBytes(entry.SortName)),
            entries.map(entry => entry.recordings), entries.map(entry => entry.latest), entries.map(entry => entry.deletion), entries.map(() => null), entries.map(entry => entry.slot)] });
      },
      async markerCount(query) {
        assertOpen(); const condition = markerWhere(query);
        return countValue((await database.client.query({ text: `SELECT count(*)::bigint AS count FROM ${table} channel WHERE ${condition.text}`, values: condition.values })).rows[0].count);
      },
      async markerCandidates(query, offset = 0) {
        assertOpen(); const condition = markerWhere(query);
        return (await database.client.query({ text: `SELECT channel.ordinal, channel."Id", channel.slot FROM ${table} channel WHERE ${condition.text} ORDER BY ${order} OFFSET $${condition.values.length + 1} LIMIT 128`, values: [...condition.values, offset] })).rows
          .map(row => ({ ordinal: row.ordinal, Id: decodeNativeTextBytes(row.Id), slot: row.slot }));
      },
      async setMarker(column, entries) {
        assertOpen(); if (!entries.length) return;
        if (!['recordings', 'latest', 'deletion'].includes(column)) throw new TypeError('Unknown channel capability.');
        if (entries.length > 128) throw new TypeError('Channel capability updates require at most 128 results.');
        await database.client.query({ text: `UPDATE ${table} channel SET ${column} = decision.value
          FROM unnest($1::bigint[], $2::boolean[]) decision(ordinal, value) WHERE channel.ordinal = decision.ordinal`,
          values: [entries.map(entry => entry.ordinal), entries.map(entry => entry.value)] });
      },
      async seal(query, options) {
        assertOpen(); const condition = access(query, options);
        await database.client.query({ text: `UPDATE ${table} channel SET allowed = (${condition.text})`, values: condition.values });
      },
      async enabledCandidates(offset = 0) {
        assertOpen();
        const rows = (await database.client.query({ text: `SELECT channel.ordinal, channel."Id", channel.slot FROM ${table} channel
          WHERE channel.allowed IS TRUE ORDER BY ${order} OFFSET $1 LIMIT 128`, values: [offset] })).rows;
        return rows.map(row => ({ ordinal: row.ordinal, Id: decodeNativeTextBytes(row.Id), slot: row.slot }));
      },
      async setEnabled(entries) {
        assertOpen(); if (!entries.length) return;
        if (entries.length > 128) throw new TypeError('Channel enablement updates require at most 128 results.');
        await database.client.query({ text: `UPDATE ${table} channel SET enabled = decision.enabled FROM unnest($1::bigint[], $2::boolean[]) decision(ordinal, enabled) WHERE channel.ordinal = decision.ordinal`,
          values: [entries.map(entry => entry.ordinal), entries.map(entry => entry.enabled)] });
      },
      async select(query, options) {
        assertOpen(); const where = `channel.allowed IS TRUE${options.userId ? ' AND channel.enabled IS TRUE' : ''}`;
        const total = countValue((await database.client.query(`SELECT count(*)::bigint AS count FROM ${table} channel WHERE ${where}`)).rows[0].count);
        const index = query.StartIndex ?? 0, limit = query.Limit > 0 ? Math.min(query.Limit, total - index) : total - index;
        const invalid = index < 0 ? 'index' : limit < 0 ? 'count' : null;
        if (invalid) throw Object.assign(new RangeError(`Non-negative number required. (Parameter '${invalid}')`), { status: 400, statusCode: 400 });
        return Object.freeze({ total, startIndex: index, async page(offset = 0) {
          assertOpen();
          if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Channel pages require a nonnegative offset.');
          const remaining = Math.min(128, Math.max(0, limit - offset)); if (!remaining) return [];
          const result = await database.client.query({ text: `SELECT channel."Id", channel.slot FROM ${table} channel WHERE ${where}
            ORDER BY ${order} OFFSET $1 LIMIT $2`, values: [index + offset, remaining] });
          return result.rows.map(row => ({ Id: decodeNativeTextBytes(row.Id), slot: row.slot }));
        } });
      }
    });
  } catch (error) { failure = error; await close(failure); throw error; }
}

/** GetAllChannelFeatures captures repository IDs once. Individual lookups and
 * provider failures still occur in that complete SQL order. */
export async function createPostgresChannelFeatureQuery(database) {
  const source = buildPostgresItemPageQuery(database, { includeitemtypes: ['Channel'], sortby: ['SortName'], sortorder: ['Ascending'] },
    { includeOrdinal: true });
  const name = 'mm_channel_features_' + randomUUID().replaceAll('-', ''), table = `${q('pg_temp')}.${q(name)}`;
  let attempted = false, closing;
  const close = error => closing ??= (async () => {
    if (!attempted) return;
    try { await database.client.query(`DROP TABLE IF EXISTS ${table}`); }
    catch (cleanup) {
      if (error && database.inTransaction && cleanup.code === '25P02') return;
      database.discardConnection(cleanup); throw cleanup;
    }
  })();
  try {
    attempted = true;
    await database.client.query({ text: `CREATE TEMP TABLE ${q(name)} AS SELECT "Id", "__ordinal" FROM (${source.text}) selected WHERE "Id" IS NOT NULL`, values: source.values });
    return Object.freeze({ close, async page(offset = 0) {
      if (closing) throw new Error('The channel feature query is closed.');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Channel feature pages require a nonnegative offset.');
      const result = await database.client.query({ text: `SELECT "Id" FROM ${table} ORDER BY "__ordinal" OFFSET $1 LIMIT 128`, values: [offset] });
      return result.rows.map(row => decodeNativeTextBytes(row.Id));
    } });
  } catch (error) { await close(error); throw error; }
}
