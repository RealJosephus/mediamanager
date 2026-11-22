import { same } from './format.js';
import { isMarkerField, matchesMarker } from './chapter-markers.js';
import { mergeProviderIds } from './provider-ids.js';

const legacyChapterFields = chapters => chapters.map(({ ImageDateModified, ...row }) => row);

const streamTypes = {
  jellyfin: ['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric'],
  emby: ['Unknown', 'Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Attachment', 'Data'],
};
const byStreamIndex = rows => new Map(rows?.map(row => [row.StreamIndex, row]));

// Receipts store each endpoint's native rows. Translate only the comparison and
// write projection, so an earlier receipt and an untouched origin remain usable.
function projectStreams(rows, target, previousSource, previousTarget, sourceType, issue) {
  const sourceKinds = streamTypes[sourceType];
  const targetKinds = sourceType === 'emby' ? streamTypes.jellyfin : streamTypes.emby;
  const existing = byStreamIndex(target);
  const beforeSource = byStreamIndex(previousSource);
  const beforeTarget = byStreamIndex(previousTarget);
  const result = new Map();
  for (const row of existing.values()) {
    if (!sourceKinds.includes(targetKinds[row.StreamType])) result.set(row.StreamIndex, row);
  }
  for (const row of rows) {
    const index = row.StreamIndex;
    const kind = sourceKinds[row.StreamType];
    const mapped = targetKinds.indexOf(kind);
    const current = existing.get(index);
    if (mapped < 0) {
      issue?.('origin-only', 'stream ' + index + ' has no target type for ' + (kind ?? row.StreamType));
      if (current) result.set(index, current);
    } else if (result.has(index)) {
      issue?.('conflict', 'stream ' + index + ' is occupied by a target-only type');
    } else if (current && current.StreamType === row.StreamType &&
        beforeSource.get(index)?.StreamType === row.StreamType && beforeTarget.get(index)?.StreamType === row.StreamType) {
      // Older writers copied the ordinal. Neither endpoint proves which type is
      // correct until it has been re-probed or explicitly corrected.
      issue?.('conflict', 'stream ' + index + ' retains the same ordinal with different native meanings; verify against the media');
      result.set(index, current);
    } else {
      result.set(index, { ...row, StreamType: mapped });
    }
  }
  return [...result.values()].sort((a, b) => a.StreamIndex - b.StreamIndex);
}

// Compare each endpoint with its own last projection. The target can legitimately
// have lower precision or a different set of expressible fields.
export function changesBetween(source, target, baseSource, baseTarget, report, {
  legacyChapters = false, sourceType, pendingProviders, pendingProviderEdits, legacyProviderItems, rememberTargetEdit,
} = {}) {
  const changes = [];
  for (const key of new Set([...source.keys(), ...baseSource.keys()])) {
    let value = source.get(key), before = baseSource.get(key);
    const current = target.get(key), previous = baseTarget.get(key);
    const [kind, id] = key.split('/');
    const pending = kind === 'item' && pendingProviders?.get(id);
    const owed = kind === 'item' && pendingProviderEdits?.get(id);
    const legacy = kind === 'item' && legacyProviderItems?.has(id);
    const targetProviderEdit = current && previous?.Providers && !same(current.Providers, previous.Providers);
    if (sourceType && value?.Streams && (value.Streams.length || current?.Streams?.length || before?.Streams?.length)) {
      const priorStreams = before?.Streams;
      const project = (rows, issue) => projectStreams(rows, current?.Streams, priorStreams, previous?.Streams, sourceType, issue);
      value = { ...value, Streams: project(value.Streams, (status, detail) => report(status, kind, id, 'Streams', detail)) };
      if (before?.Streams) before = { ...before, Streams: project(before.Streams) };
    }
    if (same(value, before) && !pending && !owed && !legacy && !targetProviderEdit) continue;
    if (!value) {
      if (!current) continue;
      if (!same(current, previous)) {
        report('conflict', kind, id, 'deletion', 'target has edits');
        continue;
      }
      changes.push({ key, value: null, fields: [] });
      continue;
    }
    if (!current) {
      if (previous) {
        report('conflict', kind, id, 'deletion', 'target removed a source-edited object');
        continue;
      }
      if (value.Providers)
        value = { ...value, Providers: mergeProviderIds(value.Providers, [], [], [], {
          targetType: sourceType === 'jellyfin' ? 'emby' : 'jellyfin',
          issue: (status, reason, evidence) => report(status, kind, id, 'Providers', reason, evidence),
        }) };
      changes.push({ key, value, fields: Object.keys(value) });
      continue;
    }
    const changed = [];
    for (const name of Object.keys(value)) {
      if (name === 'Providers') {
        const merged = mergeProviderIds(value.Providers, current.Providers, before?.Providers, previous?.Providers, {
          pending, owed, legacy, targetType: sourceType === 'jellyfin' ? 'emby' : 'jellyfin',
          issue: (status, reason, evidence) => report(status, kind, id, name, reason, evidence),
          rememberTargetEdit: provider => rememberTargetEdit?.(id, provider),
        });
        if (!same(merged, current.Providers ?? [])) {
          value = { ...value, Providers: merged };
          changed.push(name);
        }
        continue;
      }
      if (same(value[name], before?.[name]) || same(value[name], current[name]) || matchesMarker(name, value[name], current[name])) continue;
      if (name === 'Chapters' && legacyChapters && before?.Chapters && previous?.Chapters) {
        const input = legacyChapterFields(value.Chapters), output = legacyChapterFields(current.Chapters);
        if (same(input, legacyChapterFields(before.Chapters)) || same(input, output)) continue;
        if (same(output, legacyChapterFields(previous.Chapters))) changed.push(name);
        else report('conflict', kind, id, name, 'older exchange stored typed markers as ordinary chapters');
        continue;
      }
      if (isMarkerField(name) && !Object.hasOwn(previous ?? {}, name) && !Object.hasOwn(before ?? {}, name)) {
        // Older exchanges did not track marker semantics. Fill an empty target;
        // its existing native markers predate our ability to compare edits.
        if (value[name] && current[name] === null) changed.push(name);
        else if (value[name]) report('conflict', kind, id, name, 'pre-existing or unrepresentable target markers');
        continue;
      }
      if (previous && !same(previous[name], current[name])) {
        report('conflict', kind, id, name, 'both endpoints edited');
        continue;
      }
      if (!before && !previous) {
        report('conflict', kind, id, name, 'identity already exists on the target');
        continue;
      }
      changed.push(name);
    }
    if (changed.length) changes.push({ key, value, fields: changed });
  }
  return changes;
}
