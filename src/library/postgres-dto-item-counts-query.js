import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { queryPostgresNamedItemCounts } from './postgres-named-items-query.js';
import { idKey } from './records.js';

const general = ['Audio', 'Episode', 'Movie', 'LiveTvProgram', 'MusicAlbum', 'MusicArtist', 'MusicVideo', 'Series', 'Trailer'];
export const dtoItemCountKinds = Object.freeze({
  Genre: general, Studio: general, Year: general,
  MusicArtist: ['Audio', 'MusicAlbum', 'MusicVideo'],
  MusicGenre: ['Audio', 'MusicAlbum', 'MusicArtist', 'MusicVideo'],
  Person: ['Audio', 'AudioBook', 'Book', 'Episode', 'Movie', 'LiveTvProgram', 'MusicAlbum', 'MusicArtist', 'MusicVideo', 'Series', 'Trailer'],
});
const countedTypes = { Movie: 'MovieCount', Series: 'SeriesCount', Episode: 'EpisodeCount', MusicArtist: 'ArtistCount',
  LiveTvProgram: 'ProgramCount', Trailer: 'TrailerCount', Audio: 'SongCount', MusicAlbum: 'AlbumCount',
  MusicVideo: 'MusicVideoCount', BoxSet: 'BoxSetCount', Book: 'BookCount' };
const publicNames = Object.values(countedTypes).filter(name => !['BoxSetCount', 'BookCount'].includes(name));
const emptyCounts = () => Object.fromEntries([...publicNames.map(name => [name, 0]), ['ChildCount', 0]]);
const int32 = expression => `(((((${expression})::bigint + 2147483648) % 4294967296 + 4294967296) % 4294967296) - 2147483648)`;

/** Count only the final selected DTO identities; all associations remain SQL. */
export async function queryPostgresDtoItemCounts(database, items, { scope = {}, userId, visibility } = {}) {
  const groups = new Map(), counts = new Map();
  for (const item of items) {
    if (!Object.hasOwn(dtoItemCountKinds, item.Type)) continue;
    counts.set(idKey(item.Id), emptyCounts());
    if (!groups.has(item.Type)) groups.set(item.Type, new Set());
    groups.get(item.Type).add(item.Id);
  }
  for (const [kind, requested] of groups) {
    const ids = [...requested];
    const query = { includeitemtypes: dtoItemCountKinds[kind] };
    if (!['Person', 'Year'].includes(kind)) {
      const values = await queryPostgresNamedItemCounts(database, { kind, ids, query, scope, userId, visibility, includeEmpty: true });
      for (const [id, value] of values) counts.set(id, value);
      continue;
    }
    const sql = nativeTextSql(database.schemaName);
    const table = name => `${q(database.schemaName)}.${q(name)}`;
    const same = (a, b) => `${sql.guidKey(a)} = ${sql.guidKey(b)}`;
    const plan = buildPostgresItemPageQuery(database, query, { scope, userId, visibility });
    const values = [...plan.values, ids.map(idKey)];
    const selected = `$${values.length}`;
    // Int32.TryParse(NumberStyles.Integer, InvariantCulture) trims only the
    // integer ASCII whitespace, accepts signs and final NULs, and rejects overflow.
    const yearText = `btrim(regexp_replace(${sql.projection('name."Name"')}, '(' || chr(1) || '0)*$', ''),
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || ' ')`;
    const year = sql.safeInt32(sql.fromProjection(yearText));
    const association = kind === 'Person'
      ? `JOIN ${table('Peoples')} person ON person."Name" = name."Name"
         JOIN ${table('PeopleBaseItemMap')} credit ON ${same('credit."PeopleId"', 'person."Id"')}
         JOIN sources item ON ${same('item."Id"', 'credit."ItemId"')}`
      : `JOIN sources item ON item."ProductionYear" = ${year}`;
    const result = await database.client.query({
      text: `WITH source_ids AS (${plan.text}), sources AS (SELECT item.* FROM source_ids source
          JOIN ${table('BaseItems')} item ON ${same('item."Id"', 'source."Id"')}),
        requested AS (SELECT "Id", "Name" FROM ${table('BaseItems')}
          WHERE ${sql.guidKey('"Id"')} = ANY(${selected}::text[])),
        associated AS (SELECT DISTINCT name."Id" AS name_id, item."Id", item."Type"
          FROM requested name ${association})
        SELECT name."Id", ${Object.entries(countedTypes).map(([type, field]) =>
    `${int32(`count(*) FILTER (WHERE substring(${sql.projection('associated."Type"')} from '[^.]+$') = '${type}')`)} AS ${q(field)}`).join(', ')}
        FROM requested name LEFT JOIN associated ON ${same('associated.name_id', 'name."Id"')}
        GROUP BY name."Id"`, values,
    });
    for (const row of result.rows) {
      const value = Object.fromEntries(publicNames.map(name => [name, Number(row[name])]));
      value.ChildCount = Object.values(countedTypes).reduce((sum, name) => (sum + Number(row[name])) | 0, 0);
      counts.set(idKey(decodeNativeTextBytes(row.Id)), value);
    }
  }
  return counts;
}
