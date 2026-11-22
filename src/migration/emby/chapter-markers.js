import { randomUUID } from 'node:crypto';
import { embyMarkerProviderName, mediaSegmentProviderId } from '../../library/media-segment-service.js';
import { statement } from './format.js';

export const markerProviderId = mediaSegmentProviderId(embyMarkerProviderName);
const intro = 'IntroSkip', credits = 'CreditsSkip';
const markerFields = [intro, credits];
const nativeTypes = { [intro]: 5, [credits]: 4 };
const chapterTypes = { [intro]: [1, 2], [credits]: [3] };
const chapterNames = ['Chapter', 'Intro Start', 'Intro End', 'Credits Start'];
export const isMarkerField = name => Object.hasOwn(nativeTypes, name);
export function chapterMarkerName(type) {
  return ['Chapter', 'IntroStart', 'IntroEnd', 'CreditsStart'][type ?? 0] ?? 'Unknown';
}

export function matchesMarker(field, a, b) {
  return field === credits && a && b && a.StartTicks === b.StartTicks
    && (a.EndTicks === null || b.EndTicks === null || a.EndTicks === b.EndTicks);
}

// A missing field represents a native layout we cannot safely edit. Null means
// that this kind is representable and is genuinely absent.
export function readMarkers(db, type, items, itemGuid, report) {
  const emby = type === 'emby';
  const sql = emby
    ? 'SELECT ItemId,MarkerType,StartPositionTicks,Name,ImagePath,ImageDateModified FROM Chapters3 WHERE MarkerType<>0 ORDER BY ItemId,ChapterIndex'
    : 'SELECT ItemId,Type,StartTicks,EndTicks FROM MediaSegments ORDER BY ItemId,rowid';
  let owner, group = [];
  const finish = () => {
    const item = items.get(owner);
    if (!item) return;
    const id = itemGuid(owner);
    const runtime = item.RunTimeTicks == null ? null : BigInt(item.RunTimeTicks);
    for (const field of markerFields) {
      if (emby && field === credits && group.some(row => chapterMarkerName(Number(row.MarkerType)) === 'Unknown')) {
        delete item[field];
        report('origin-only', 'item', id, field, 'unknown native marker types may describe additional credit boundaries');
        continue;
      }
      const candidates = group.filter(row => emby
        ? chapterTypes[field].includes(Number(row.MarkerType)) : Number(row.Type) === nativeTypes[field]);
      if (!candidates.length) continue;
      let start, end;
      if (emby) {
        const times = marker => candidates.filter(row => Number(row.MarkerType) === marker);
        const starts = times(chapterTypes[field][0]), ends = times(2);
        if (starts.length === 1 && (field === credits || ends.length === 1)) {
          start = starts[0].StartPositionTicks;
          end = field === credits ? null : ends[0].StartPositionTicks;
        }
      } else if (candidates.length === 1) {
        start = candidates[0].StartTicks;
        end = candidates[0].EndTicks;
      }
      const startOnly = emby && field === credits && start != null;
      const valid = start != null && start >= 0n && (runtime == null || start < runtime)
        && (startOnly || (end != null && end > start && (runtime == null || end <= runtime)
          && (field !== credits || end === runtime)));
      if (valid) item[field] = { StartTicks: String(start), EndTicks: startOnly ? null : String(end) };
      else {
        delete item[field];
        report('origin-only', 'item', id, field,
          'incomplete, duplicate or invalid boundaries, or credits do not end at the known runtime');
      }
    }
    for (const row of group) {
      const value = Number(emby ? row.MarkerType : row.Type);
      if (!(emby ? [1, 2, 3] : [4, 5]).includes(value))
        report('origin-only', 'item', id, emby ? 'Chapters3.MarkerType' : 'MediaSegments.Type', String(value));
      else if (emby && (row.ImagePath || row.ImageDateModified || (row.Name && row.Name !== chapterNames[value])))
        report('origin-only', 'item', id, 'Chapters3.MarkerMetadata', 'native marker label or artwork retained in the origin');
    }
  };
  for (const row of statement(db, sql).iterate()) {
    if (owner !== row.ItemId) {
      finish();
      owner = row.ItemId;
      group = [];
    }
    group.push(row);
  }
  finish();
}

// Native chapter indexes are also used to request chapter images. Keep them
// intact, moving a marker only if an ordinary chapter explicitly needs its slot.
function freeIndex(used) {
  let largest = -1;
  for (const index of used) if (index > largest) largest = index;
  if (largest < 2147483647) return largest + 1;
  for (let index = 0; index <= largest; index++) if (!used.has(index)) return index;
  throw new Error('No free Emby chapter index');
}

export function reserveChapterIndexes(db, item, chapters) {
  const wanted = new Set(chapters.map(chapter => chapter.ChapterIndex));
  const markers = db.prepare('SELECT ChapterIndex FROM Chapters3 WHERE ItemId=? AND MarkerType<>0 ORDER BY ChapterIndex').all(item);
  const used = new Set([...wanted, ...markers.map(row => row.ChapterIndex)]);
  for (const { ChapterIndex } of markers) {
    if (!wanted.has(ChapterIndex)) continue;
    const index = freeIndex(used);
    db.prepare('UPDATE Chapters3 SET ChapterIndex=? WHERE ItemId=? AND ChapterIndex=?').run(index, item, ChapterIndex);
    used.add(index);
  }
}

export function writeMarker(db, type, item, id, field, value, target, runtime, report, creditsEnd = 'preserve') {
  if (target && !Object.hasOwn(target, field)) {
    report('conflict', 'item', id, field, 'target contains native markers with ambiguous or unrepresentable bounds');
    return;
  }
  if (!value && !target?.[field]) return;
  if (value && field === credits && value.EndTicks === null && type === 'jellyfin') {
    const knownEnd = target?.[field]?.EndTicks;
    if (!knownEnd && (creditsEnd !== 'runtime' || runtime == null)) {
      report('origin-only', 'item', id, field, 'Emby supplies a credits start without a verified end');
      return;
    }
    value = { ...value, EndTicks: knownEnd ?? String(runtime) };
    if (!knownEnd) report('inferred', 'item', id, field, 'used the media runtime as the credits end by request');
  }
  if (value && ((runtime != null && BigInt(value.EndTicks) > BigInt(runtime))
      || BigInt(value.StartTicks) >= BigInt(value.EndTicks)
      || (field === credits && (runtime == null || BigInt(value.EndTicks) !== BigInt(runtime))))) {
    report('conflict', 'item', id, field, 'target runtime differs from segment bounds');
    return;
  }
  if (type === 'jellyfin') {
    const segmentType = nativeTypes[field];
    const old = db.prepare('SELECT Id FROM MediaSegments WHERE ItemId=? AND Type=?').all(item, segmentType);
    if (old.length > 1) throw new Error('Ambiguous target segment identity');
    if (!value) db.prepare('DELETE FROM MediaSegments WHERE ItemId=? AND Type=?').run(item, segmentType);
    else if (old.length) db.prepare('UPDATE MediaSegments SET StartTicks=?,EndTicks=? WHERE Id=?')
      .run(BigInt(value.StartTicks), BigInt(value.EndTicks), old[0].Id);
    else db.prepare('INSERT INTO MediaSegments(Id,ItemId,Type,StartTicks,EndTicks,SegmentProviderId) VALUES (?,?,?,?,?,?)')
      .run(randomUUID().toUpperCase(), item, segmentType, BigInt(value.StartTicks), BigInt(value.EndTicks), markerProviderId);
    return;
  }
  for (const kind of chapterTypes[field]) {
    const params = [item, kind];
    if (!value) {
      db.prepare('DELETE FROM Chapters3 WHERE ItemId=? AND MarkerType=?').run(...params);
      continue;
    }
    const ticks = BigInt(kind === 2 ? value.EndTicks : value.StartTicks);
    const changed = db.prepare('UPDATE Chapters3 SET StartPositionTicks=? WHERE ItemId=? AND MarkerType=?').run(ticks, ...params);
    if (!changed.changes) {
      const used = new Set(db.prepare('SELECT ChapterIndex FROM Chapters3 WHERE ItemId=?').all(item).map(r => r.ChapterIndex));
      db.prepare('INSERT INTO Chapters3(ItemId,ChapterIndex,StartPositionTicks,MarkerType,Name) VALUES (?,?,?,?,?)')
        .run(item, freeIndex(used), ticks, kind, chapterNames[kind]);
    }
  }
  // Emby's chapter writer invalidates its cached intro detection result on an edit.
  db.prepare("DELETE FROM ItemExtradata WHERE ItemId=? AND ExtradataTypeId IN (SELECT ExtradataTypeId FROM ItemExtradataTypes WHERE Name='IntroDetectionExtradata')").run(item);
}
