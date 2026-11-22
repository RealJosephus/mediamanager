import path from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { md5Guid } from '../core/identity.js';
import { nativeGuid } from '../users/native.js';

export const skipperName = 'Intro Skipper';
export const skipperGuid = 'c83d86bb-a1e0-4c35-a113-e2101cf4ee6b';
export const skipperProvider = md5Guid('intro skipper');
export const skipperTypes = [5, 4, 2, 3, 1];
export const skipperFiles = ['introskipper-v2.db', 'introskipper.db', 'introskipper-cache.db'];

export async function hasNativeIntroSkipper(programData) {
  const plugins = path.join(programData, 'plugins');
  let entries;
  try {
    entries = await readdir(plugins, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let installed = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let meta;
    try {
      meta = JSON.parse(await readFile(path.join(plugins, entry.name, 'meta.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (String(meta.guid ?? meta.Guid ?? meta.id ?? '').toLowerCase() !== skipperGuid) continue;
    installed = true;
    const status = String(meta.status ?? meta.Status ?? 'Active').toLowerCase();
    if (['active', '0', 'restart', '1'].includes(status)) return true;
  }
  return installed ? false : null;
}

export async function companionFiles(directory) {
  const result = [];
  for (const name of skipperFiles) {
    const file = path.join(directory, name);
    try {
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('Expected a regular Intro Skipper database: ' + name);
      result.push({ name, file });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result;
}

const bigQuery = (db, sql) => {
  const q = db.prepare(sql);
  q.setReadBigInts(true);
  return q;
};
const hasColumn = (db, schema, table, name) =>
  db
    .prepare('PRAGMA ' + schema + '.table_info(' + table + ')')
    .all()
    .some((c) => c.name === name);
export function disabledSkipperItems(db, layout, schema = 'main') {
  if (layout === 'v2') return db.prepare('SELECT ItemId FROM ' + schema + '.DisabledItems').iterate();
  if (hasColumn(db, schema, 'DbDisabledEpisode', 'EpisodeId'))
    return db.prepare('SELECT EpisodeId AS ItemId FROM ' + schema + '.DbDisabledEpisode').iterate();
  return [];
}
export function skipperLayout(db, schema = 'main') {
  const columns = (table) =>
    new Set(
      db
        .prepare('PRAGMA ' + schema + '.table_info(' + table + ')')
        .all()
        .map((c) => c.name),
    );
  const has = (table, names) => names.every((n) => columns(table).has(n));
  if (
    has('Segments', [
      'Id',
      'ItemId',
      'Type',
      'StartTicks',
      'EndTicks',
      'Source',
      'State',
      'ConfigHash',
      'UpdatedAt',
    ]) &&
    has('DisabledItems', ['ItemId'])
  )
    return 'v2';
  if (has('DbSegment', ['ItemId', 'Type', 'Start', 'End'])) return 'legacy';
  return null;
}

export function* skipperRows(db, layout, schema = 'main') {
  const legacyDisable =
    layout === 'legacy' &&
    hasColumn(db, schema, 'DbDisabledEpisode', 'EpisodeId') &&
    hasColumn(db, schema, 'DbSegment', 'IsUserProvided');
  const rows =
    layout === 'v2'
      ? bigQuery(
          db,
          'SELECT s.*, EXISTS(SELECT 1 FROM ' +
            schema +
            '.DisabledItems d WHERE d.ItemId=s.ItemId) AS disabled FROM ' +
            schema +
            '.Segments s ORDER BY s.ItemId,s.Type,s.StartTicks',
        )
      : bigQuery(
          db,
          'SELECT s.*, ' +
            (legacyDisable
              ? '(s.IsUserProvided=0 AND EXISTS(SELECT 1 FROM ' +
                schema +
                '.DbDisabledEpisode d WHERE d.EpisodeId=s.ItemId))'
              : '0') +
            ' AS disabled FROM ' +
            schema +
            '.DbSegment s ORDER BY s.ItemId,s.Type,s.Start',
        );
  let previousItem, previousType;
  for (const r of rows.iterate()) {
    const type = skipperTypes[Number(r.Type)];
    if (!type) continue;
    const item = nativeGuid(r.ItemId);
    // The legacy provider casts seconds * TicksPerSecond to Int64 (truncation).
    if (
      layout === 'legacy' &&
      (!Number.isSafeInteger(Math.trunc(r.Start * 1e7)) || !Number.isSafeInteger(Math.trunc(r.End * 1e7)))
    )
      continue;
    const start = layout === 'v2' ? r.StartTicks : BigInt(Math.trunc(r.Start * 1e7));
    const end = layout === 'v2' ? r.EndTicks : BigInt(Math.trunc(r.End * 1e7));
    if (start < 0n || end <= start) continue;
    const id = layout === 'v2' ? nativeGuid(r.Id) : nativeGuid(md5Guid([item, type, start, end].join('/')));
    const active =
      layout === 'v2'
        ? r.State === 0n && (r.Source === 5n || !r.disabled)
        : !r.disabled && (type === 1 || item !== previousItem || type !== previousType);
    if (active) {
      previousItem = item;
      previousType = type;
    }
    yield { id, item, type, start, end, active, legacy: layout === 'legacy' };
  }
}

// The callers own a stopped working copy. Only the plugin's projection in the
// Jellyfin database is refreshed. Other providers never participate.
export function projectSkipper(db, layout, report) {
  db.exec(
    'CREATE TEMP TABLE skipper_projection(id TEXT PRIMARY KEY,item TEXT,type INTEGER,start INTEGER,end INTEGER)',
  );
  try {
    const insert = db.prepare('INSERT INTO temp.skipper_projection VALUES(?,?,?,?,?)');
    const legacyId = db.prepare(
      'SELECT Id FROM MediaSegments WHERE ItemId=? AND Type=? AND StartTicks=? AND EndTicks=? AND SegmentProviderId=? ORDER BY rowid LIMIT 1',
    );
    for (const r of skipperRows(db, layout, 'skipper'))
      if (r.active) {
        const id = (r.legacy && legacyId.get(r.item, r.type, r.start, r.end, skipperProvider)?.Id) || r.id;
        insert.run(id, r.item, r.type, r.start, r.end);
      }
    db.prepare(
      'DELETE FROM MediaSegments WHERE SegmentProviderId=? AND Type IN (1,2,3,4,5) AND NOT EXISTS(SELECT 1 FROM temp.skipper_projection p WHERE p.id=MediaSegments.Id)',
    ).run(skipperProvider);
    const foreign = db
      .prepare(
        'SELECT p.item FROM temp.skipper_projection p JOIN MediaSegments s ON p.id=s.Id WHERE s.SegmentProviderId<>?',
      )
      .all(skipperProvider);
    for (const row of foreign)
      report(
        'conflict',
        'item',
        row.item,
        'IntroSkipper',
        'segment identity already belongs to another provider',
      );
    db.prepare(
      'INSERT INTO MediaSegments(Id,ItemId,Type,StartTicks,EndTicks,SegmentProviderId) SELECT p.id,p.item,p.type,p.start,p.end,? FROM temp.skipper_projection p JOIN BaseItems b ON p.item=b.Id WHERE true ON CONFLICT(Id) DO UPDATE SET ItemId=excluded.ItemId,Type=excluded.Type,StartTicks=excluded.StartTicks,EndTicks=excluded.EndTicks WHERE MediaSegments.SegmentProviderId=excluded.SegmentProviderId AND (MediaSegments.ItemId,MediaSegments.Type,MediaSegments.StartTicks,MediaSegments.EndTicks) IS NOT (excluded.ItemId,excluded.Type,excluded.StartTicks,excluded.EndTicks)',
    ).run(skipperProvider);
  } finally {
    db.exec('DROP TABLE temp.skipper_projection');
  }
}

export async function attachSkipper(db, instance, report) {
  const files = await companionFiles(path.join(instance, 'data/data/introskipper'));
  const file = files.find((f) => f.name !== 'introskipper-cache.db');
  if (!file) return null;
  db.prepare('ATTACH DATABASE ? AS skipper').run(file.file);
  const layout = skipperLayout(db, 'skipper');
  if (!layout) report('origin-only', 'plugin', skipperName, 'database', 'unknown plugin schema retained');
  return layout ?? 'unknown';
}

export function blocksSkipperAddition(db, layout, item, type, value) {
  if (layout === 'unknown') return true;
  if (layout === 'legacy')
    return (
      hasColumn(db, 'skipper', 'DbDisabledEpisode', 'EpisodeId') &&
      Boolean(
        db.prepare('SELECT 1 FROM skipper.DbDisabledEpisode WHERE EpisodeId=? COLLATE NOCASE').get(item),
      )
    );
  if (layout !== 'v2') return false;
  if (db.prepare('SELECT 1 FROM skipper.DisabledItems WHERE ItemId=? COLLATE NOCASE').get(item)) return true;
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM skipper.Segments WHERE ItemId=? COLLATE NOCASE AND Type=? AND State=1 AND StartTicks<? AND EndTicks>?',
      )
      .get(item, skipperTypes.indexOf(type), BigInt(value.EndTicks), BigInt(value.StartTicks)),
  );
}

function legacySeconds(start, end) {
  const seconds = [Number(start) / 1e7, Number(end) / 1e7];
  return [start, end].every((ticks, i) => BigInt(Math.trunc(seconds[i] * 1e7)) === ticks) ? seconds : null;
}

function queueProjection(db, item) {
  if (db.prepare("SELECT 1 FROM skipper.sqlite_schema WHERE name='ProjectionQueue'").get())
    db.prepare(
      'INSERT INTO skipper.ProjectionQueue(ItemId,Version,AttemptCount) VALUES(?,1,0) ON CONFLICT(ItemId) DO UPDATE SET Version=Version+1,AttemptCount=0,NextAttemptAt=NULL,Failure=NULL',
    ).run(item);
}

// An externally supplied interval is an explicit edit. Give it the same
// protection and identity as an edit made in the native plugin's editor.
export function addSkipperMarker(db, layout, id, item, type, start, end) {
  const mode = skipperTypes.indexOf(type);
  if (layout === 'legacy') {
    const seconds = legacySeconds(start, end);
    if (!seconds) return false;
    const fields = ['ItemId', 'Type', 'Start', 'End'],
      values = [item, mode, ...seconds];
    if (hasColumn(db, 'skipper', 'DbSegment', 'IsUserProvided')) {
      fields.push('IsUserProvided');
      values.push(1);
    }
    if (hasColumn(db, 'skipper', 'DbSegment', 'ConfigHash')) {
      fields.push('ConfigHash');
      values.push('');
    }
    db.prepare(
      'INSERT INTO skipper.DbSegment(' +
        fields.join(',') +
        ') VALUES(' +
        fields.map(() => '?').join(',') +
        ')',
    ).run(...values);
    return true;
  }
  if (layout !== 'v2' || !hasColumn(db, 'skipper', 'Segments', 'CreatedAt')) return false;
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  db.prepare(
    "INSERT INTO skipper.Segments(Id,ItemId,Type,StartTicks,EndTicks,Source,State,ConfigHash,CreatedAt,UpdatedAt) VALUES(?,?,?,?,?,5,0,'',?,?)",
  ).run(id, item, mode, start, end, now, now);
  queueProjection(db, item);
  return true;
}

export function updateSkipperMarker(db, layout, segment, value, report) {
  const mode = skipperTypes.indexOf(segment.Type);
  const reject = (reason) => {
    report('conflict', 'item', segment.ItemId, 'IntroSkipper', reason);
    return false;
  };
  const start = value && BigInt(value.StartTicks),
    end = value && BigInt(value.EndTicks);
  if (layout === 'legacy') {
    const match =
      ' WHERE ItemId=? COLLATE NOCASE AND Type=? AND CAST(Start*10000000 AS INTEGER)=? AND CAST(End*10000000 AS INTEGER)=?';
    const args = [segment.ItemId, mode, segment.StartTicks, segment.EndTicks];
    if (db.prepare('SELECT COUNT(*) n FROM skipper.DbSegment' + match).get(...args).n !== 1)
      return reject('legacy native segment is ambiguous');
    if (value) {
      const seconds = legacySeconds(start, end);
      if (!seconds) return reject('legacy seconds cannot retain those ticks');
      const manual = hasColumn(db, 'skipper', 'DbSegment', 'IsUserProvided') ? ',IsUserProvided=1' : '';
      db.prepare('UPDATE skipper.DbSegment SET Start=?,End=?' + manual + match).run(...seconds, ...args);
    } else db.prepare('DELETE FROM skipper.DbSegment' + match).run(...args);
    return true;
  }
  const current = bigQuery(db, 'SELECT * FROM skipper.Segments WHERE Id=? COLLATE NOCASE AND State=0').get(
    segment.Id,
  );
  if (!current || current.StartTicks !== segment.StartTicks || current.EndTicks !== segment.EndTicks)
    return reject('native segment changed');
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  if (value) {
    const occupied = db
      .prepare(
        'SELECT 1 FROM skipper.Segments WHERE ItemId=? AND Type=? AND StartTicks=? AND EndTicks=? AND Id<>?',
      )
      .get(current.ItemId, mode, start, end, current.Id);
    if (occupied) return reject('a native segment or suppression already occupies the requested range');
    db.prepare(
      "UPDATE skipper.Segments SET StartTicks=?,EndTicks=?,Source=5,ConfigHash='',UpdatedAt=? WHERE Id=?",
    ).run(start, end, now, current.Id);
  } else if (current.Source === 5n) db.prepare('DELETE FROM skipper.Segments WHERE Id=?').run(current.Id);
  else db.prepare('UPDATE skipper.Segments SET State=1,UpdatedAt=? WHERE Id=?').run(now, current.Id);
  if (!value && db.prepare("SELECT 1 FROM skipper.sqlite_schema WHERE name='AnalyzedItems'").get())
    db.prepare('DELETE FROM skipper.AnalyzedItems WHERE ItemId=? AND Type=?').run(current.ItemId, mode);
  queueProjection(db, current.ItemId);
  return true;
}
