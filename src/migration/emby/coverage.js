import { quoteIdentifier } from '../../database/model.js';
import { dateFields, scalarFields, stateFields } from './format.js';
import { streamFields } from './catalog.js';

// Report native fields retained in the private source image independently of the
// common projection. Counts and names are sufficient; credentials never enter this report.
const columns = {
  MediaItems: [
    'Id',
    'guid',
    'type',
    'ParentId',
    'SeriesId',
    'AlbumId',
    'Container',
    'IndexNumberEnd',
    'UserDataKeyId',
    'ProviderIds',
    'Images',
    'LockedFields',
    ...scalarFields,
    ...dateFields,
  ],
  UserDatas: ['UserDataKeyId', 'userId', 'LastPlayedDateInt', ...stateFields],
  ListItems: ['ListId', 'ListItemId', 'ListItemOrder'],
  ItemLinks2: ['ItemId', 'Type', 'LinkedId', 'LinkOrder'],
  ItemPeople2: ['ItemId', 'PersonId', 'Role', 'PersonType', 'ListOrder'],
  Chapters3: ['ItemId', 'ChapterIndex', 'StartPositionTicks', 'Name', 'ImagePath', 'ImageDateModified', 'MarkerType'],
  MediaStreams2: ['ItemId', ...streamFields],
  AncestorIds2: ['ItemId', 'AncestorId', 'Distance'],
  LocalUsersv2: ['Id', 'guid'],
};
export function originCoverage(db) {
  const detail = [];
  for (const schema of ['main', 'accounts']) {
    const tables = db
      .prepare('SELECT name FROM ' + schema + ".sqlite_schema WHERE type='table' ORDER BY name")
      .all();
    for (const { name } of tables) {
      if (name.startsWith('sqlite_') || name.startsWith('fts_')) continue;
      const table = quoteIdentifier(name);
      const mapped = new Set((columns[name] ?? []).map((c) => c.toLowerCase()));
      const preserved = db
        .prepare('PRAGMA ' + schema + '.table_info(' + table + ')')
        .all()
        .map((c) => c.name)
        .filter((c) => !mapped.has(c.toLowerCase()));
      if (!preserved.length) continue;
      detail.push({
        database: schema === 'main' ? 'library.db' : 'users.db',
        table: name,
        rows: db.prepare('SELECT count(*) AS n FROM ' + schema + '.' + table).get().n,
        sourceColumns: preserved,
      });
    }
  }
  return detail;
}
