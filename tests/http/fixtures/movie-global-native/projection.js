import assert from 'node:assert/strict';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeModel } from '../../../../src/database/model.js';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { readXml } from '../../../../src/core/xml.js';
import { dateTicks } from '../../../../src/library/records.js';

const slash = value => value.replaceAll('\\', '/');
const key = value => String(value).replaceAll('-', '').toLowerCase();
const empty = '0'.repeat(32);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stable = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
const exactDate = value => value == null ? value : { ticks: dateTicks(value).toString() };
const taskRoles = { SplashscreenPostScanTask: 'Splashscreen', ArtistsPostScanTask: 'Artists',
  CollectionPosterVerifyPostScanTask: 'CollectionPosterVerify', CollectionPostScanTask: 'Collections',
  GenresPostScanTask: 'Genres', MusicGenresPostScanTask: 'MusicGenres', StudiosPostScanTask: 'Studios',
  CleanDatabaseScheduledTask: 'CleanDatabase', CleanDatabasePostScanTask: 'CleanDatabase' };

/** Full raw snapshots stay intact. These bindings are independently checked in
 * each run and reused across its three stages, including deleted identities. */
export function projectMovieRun(record, specification) {
  const root = slash(record.root), native = record.actualExecution === true;
  const logicalById = new Map(), idByLogical = new Map(), valueById = new Map(), idByValue = new Map();
  const clockByTicks = new Map(), ticksByClock = new Map(), previousByField = new Map(), clockBindings = [];
  const eventClockCounters = new Map(), eventClockByTicks = new Map();
  // File.Copy can preserve the common generated asset's real creation/mtime.
  // Its preparation window therefore precedes either independent runtime.
  const started = dateTicks(native ? record.ClockWindowStart : record.clockWindowStart), ended = dateTicks(record.endedAt);
  assert.ok(started <= dateTicks(record.startedAt));
  const clockFields = new Set(specification.projectionPolicy.clockColumns.map(value => value.split('.')[1]));
  const rooted = value => {
    if (typeof value !== 'string') return value;
    let normalized = slash(value).replace(/%AppDataPath%/giu, root + '/program/data')
      .replace(/%MetadataPath%/giu, root + '/program/metadata');
    if (normalized === root) return '$CASE';
    if (normalized.startsWith(root + '/')) return '$CASE/' + normalized.slice(root.length + 1);
    return value;
  };
  const bind = (forward, reverse, identity, logical) => {
    const id = key(identity); assert.match(id, /^[a-f0-9]{32}$/u); assert.notEqual(id, empty);
    if (forward.has(id)) assert.equal(forward.get(id), logical, 'An identity changed its semantic binding.');
    if (reverse.has(logical)) assert.equal(reverse.get(logical), id, 'One semantic entity changed identity across stages.');
    forward.set(id, logical); reverse.set(logical, id);
  };
  for (const observation of record.observations) {
    assert.deepEqual([...observation.snapshot.tables].sort(), specification.tables);
    assert.deepEqual(Object.keys(observation.snapshot.sql).sort(), specification.tables);
    for (const row of observation.snapshot.sql.BaseItems) {
      const location = row.Path == null ? '$NONPATH:' + row.Name : rooted(row.Path);
      bind(logicalById, idByLogical, row.Id, row.Type + '|' + location);
    }
    for (const row of observation.snapshot.sql.ItemValues)
      bind(valueById, idByValue, row.ItemValueId, 'ItemValue|' + row.Type + '|' + row.Value);
  }
  // A real create/remove pair may occur entirely between the two observed SQL
  // boundaries. Preserve and bind such transient entities from their raw events.
  for (const entry of record.trace ?? []) if (['added', 'updated', 'removed'].includes(entry.action)) {
    const item = entry.detail.item;
    const location = item.path == null ? '$NONPATH:' + item.Name : rooted(item.path);
    bind(logicalById, idByLogical, item.id, item.type + '|' + location);
  }
  const identity = value => {
    if (value == null) return value;
    const id = key(value);
    if (id === empty) return '$EMPTY';
    return logicalById.get(id) ?? valueById.get(id) ?? value;
  };
  const clock = (value, logical, field, phase) => {
    if (value == null) return value;
    const ticks = dateTicks(value), serialized = ticks.toString();
    if (ticks === 0n) return { ticks: '0' };
    assert.ok(ticks >= started && ticks <= ended, 'A projected clock is outside its actual run window: ' + logical + ':' + field);
    const fieldKey = logical + '|' + field;
    const clockKey = fieldKey + '|' + serialized;
    if (previousByField.has(fieldKey)) assert.ok(ticks >= previousByField.get(fieldKey), 'This input did not backdate clocks.');
    previousByField.set(fieldKey, ticks);
    if (!clockByTicks.has(clockKey)) {
      const token = '$CLOCK|' + fieldKey + '|' + phase;
      assert.equal(ticksByClock.has(token), false, 'Two distinct clock values would collapse to one token.');
      clockByTicks.set(clockKey, token); ticksByClock.set(token, serialized);
      clockBindings.push({ token, ticks: serialized, firstPhase: phase, logical, field });
    }
    return clockByTicks.get(clockKey);
  };
  const text = (value, logical, field, phase) => {
    if (value == null) return value;
    if (clockFields.has(field)) return clock(value, logical, field, phase);
    if (typeof value === 'string' && /^[a-f\d]{8}(?:-?[a-f\d]{4}){3}-?[a-f\d]{12}$/iu.test(value)) return identity(value);
    return rooted(value);
  };
  const data = (value, logical, phase, field) => {
    if (Array.isArray(value)) return value.map(entry => data(entry, logical, phase, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .map(name => [name, data(value[name], logical, phase, name)]));
    return text(value, logical, field, phase);
  };
  const observations = record.observations.filter(value => value.boundary === 'metadata-drained');
  assert.deepEqual(observations.map(value => value.phase), specification.phases);
  const scanOutcomes = record.observations.map(observation => {
    assert.equal(observation.status, 'completed'); assert.equal(observation.scanRunning, false);
    assert.equal(observation.Exception, null); assert.equal(observation.ExceptionMessage, null);
    return { phase: observation.phase, boundary: observation.boundary, status: observation.status,
      scanRunning: observation.scanRunning, Exception: observation.Exception, ExceptionMessage: observation.ExceptionMessage };
  });
  const stages = observations.map(observation => {
    assert.equal(observation.Exception, null); assert.deepEqual(observation.queue, { queued: [], processing: false });
    const sql = {};
    const items = [...observation.snapshot.sql.BaseItems].sort((a, b) => compare(identity(a.Id), identity(b.Id)));
    // Bind persisted clocks before Data or XML uses their aliases.
    for (const row of items) for (const field of clockFields) clock(row[field], identity(row.Id), field, observation.phase);
    for (const table of nativeModel.tables) {
      const rows = observation.snapshot.sql[table.name].map(row => {
        assert.deepEqual(Object.keys(row).sort(), table.columns.map(column => column.name).sort(), table.name + ': no field may disappear.');
        const logical = table.name === 'BaseItems' ? identity(row.Id) : table.name;
        return Object.fromEntries(table.columns.map(column => {
          const value = row[column.name];
          if (value == null) return [column.name, value];
          if (column.type === 'INTEGER') return [column.name, BigInt(value).toString()];
          if (column.name === 'Data' && table.name === 'BaseItems') return [column.name, data(parseLosslessJson(value), logical, observation.phase)];
          if (column.clrType.replace('?', '') === 'Guid') return [column.name, identity(value)];
          if (column.clrType.replace('?', '') === 'DateTime') return [column.name,
            table.name === 'BaseItems' && clockFields.has(column.name) ? clock(value, logical, column.name, observation.phase) : exactDate(value)];
          return [column.name, text(value, logical, column.name, observation.phase)];
        }));
      });
      // Every order-bearing column remains present, including LinkedChildren's
      // SortOrder. Physical entity row order is retained in raw SQLite evidence.
      sql[table.name] = rows.sort((a, b) => compare(stable(a), stable(b)));
    }
    for (const name of ['__EFMigrationsHistory', '__EFMigrationsLock'])
      sql[name] = observation.snapshot.sql[name].map(row => data(row, name, observation.phase)).sort((a, b) => compare(stable(a), stable(b)));
    const xml = observation.snapshot.files.map(file => {
      const absolute = root + '/' + file.path;
      const row = items.find(item => {
        const full = rooted(item.Path);
        return file.path.endsWith('/collection.xml') ? full === rooted(path.dirname(absolute))
          : typeof full === 'string' && full.replace(/\.[^/.]+$/u, '.nfo') === rooted(absolute);
      });
      assert.ok(row, 'Every captured NFO/XML must belong to a persisted item: ' + file.path);
      return { path: file.path, document: xmlNode(readXml(file.text), row, observation.phase) };
    }).sort((a, b) => compare(a.path, b.path));
    return { phase: observation.phase, boundary: observation.boundary, status: observation.status,
      scanRunning: observation.scanRunning, Exception: observation.Exception, ExceptionMessage: observation.ExceptionMessage,
      queue: { queued: observation.queue.queued.map(identity), processing: observation.queue.processing },
      sql, xml, mediaFiles: observation.snapshot.mediaFiles.map(file => ({ path: file.path, bytes: Number(file.bytes), sha256: file.sha256 })),
      sqliteSequence: observation.snapshot.sqliteSequence.map(row => ({ name: row.name, seq: String(row.seq) })) };
  });
  assertScenario();

  const eventDate = (value, logical, field, phase) => {
    if (value == null) return value ?? null;
    const ticks = dateTicks(value), serialized = ticks.toString();
    const clockKey = logical + '|' + field + '|' + serialized;
    if (ticks === 0n) return { ticks: '0' };
    assert.ok(ticks >= started && ticks <= ended, 'An Item event clock is outside the actual run window.');
    if (clockByTicks.has(clockKey)) return clockByTicks.get(clockKey);
    if (!eventClockByTicks.has(clockKey)) {
      const slot = logical + '|' + field + '|' + phase, index = eventClockCounters.get(slot) ?? 0;
      eventClockCounters.set(slot, index + 1); eventClockByTicks.set(clockKey, '$EVENTCLOCK|' + slot + '|' + index);
      clockBindings.push({ token: eventClockByTicks.get(clockKey), ticks: serialized, firstPhase: phase, logical, field, eventOnly: true });
    }
    return eventClockByTicks.get(clockKey);
  };
  const events = {};
  const rawTrace = record.trace ?? [];
  assert.deepEqual(rawTrace.map(entry => Number(entry.ordinal)), Array.from({ length: rawTrace.length }, (_, index) => index + 1),
    'The raw trace must be cumulative, contiguous and complete.');
  for (const entry of rawTrace.filter(entry => specification.phases.includes(entry.phase) && ['added', 'updated', 'removed'].includes(entry.action))) {
    const item = entry.detail.item, logical = identity(item.id);
    assert.ok(logicalById.has(key(item.id)), 'Every emitted item identity must occur in an actual table snapshot.');
    const projected = { phase: entry.phase, action: entry.action, id: logical, type: item.type, Name: item.Name,
      path: rooted(item.path), parent: identity(entry.detail.parent ?? null),
      updateReason: Number(entry.detail.updateReason), ParentId: identity(item.ParentId), OwnerId: identity(item.OwnerId),
      IsFolder: item.IsFolder, Genres: item.Genres, Studios: item.Studios, tmdbCollectionName: item.tmdbCollectionName,
      Overview: item.Overview ?? null, RunTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
      ProviderIds: item.ProviderIds, IsLocked: item.IsLocked };
    for (const field of ['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed'])
      projected[field] = eventDate(item[field], logical, field, entry.phase);
    (events[logical] ??= []).push(projected);
  }
  const traceActions = rawTrace.map(entry => entry.action);
  assert.equal(record.registration.externalDataManager, native
    ? 'Emby.Server.Implementations.Library.ExternalDataManager' : 'ExternalDataManager');
  if (native) assert.deepEqual(record.registration.externalDataDependencies, [
    'Emby.Server.Implementations.Library.KeyframeManager',
    'Jellyfin.Server.Implementations.MediaSegments.MediaSegmentManager',
    'Emby.Server.Implementations.Library.PathManager',
    'Jellyfin.Server.Implementations.Trickplay.TrickplayManager',
    'Emby.Server.Implementations.Chapters.ChapterManager',
  ]);
  const cleanups = rawTrace.filter(entry => entry.action === 'external-cleanup-begin');
  assert.ok(cleanups.some(entry => entry.phase === 'deleted' && entry.detail.method === 'DeleteExternalItemFiles'
    && rooted(entry.detail.item.path) === '$CASE/media/First.mkv'),
  'The real deleted Movie must execute external file cleanup.');
  assert.deepEqual(rawTrace.filter(entry => entry.action === 'external-cleanup-failed'), []);
  assert.equal(rawTrace.filter(entry => entry.action === 'external-cleanup-completed').length, cleanups.length);
  for (const begin of cleanups) {
    const completed = rawTrace.filter(entry => entry.action === 'external-cleanup-completed'
      && Number(entry.detail.cleanupId) === Number(begin.detail.cleanupId));
    assert.equal(completed.length, 1, 'Every real external cleanup requires its own actual completion.');
    const end = completed[0];
    assert.ok(Number(begin.ordinal) < Number(end.ordinal));
    assert.equal(end.phase, begin.phase); assert.equal(end.detail.method, begin.detail.method);
    assert.equal(identity(end.detail.item.id), identity(begin.detail.item.id));
    const snapshots = [begin.detail.snapshot, end.detail.snapshot];
    for (const snapshot of snapshots) {
      assert.deepEqual(Object.keys(snapshot.tables).sort(), ['Chapters', 'KeyframeData', 'MediaSegments', 'TrickplayInfos']);
      assert.ok(snapshot.paths.length > 0);
      for (const entry of snapshot.paths) {
        assert.ok(rooted(entry.path).startsWith('$CASE/'), 'Actual extracted-data paths must stay under the declared case root.');
        assert.ok(['absent', 'file', 'directory'].includes(entry.kind));
        for (const file of entry.files) {
          assert.match(file.sha256, /^[a-f0-9]{64}$/u); assert.ok(Number(file.bytes) >= 0);
        }
      }
    }
    assert.deepEqual(snapshots[1].paths.map(entry => entry.path), snapshots[0].paths.map(entry => entry.path));
  }
  assert.equal(traceActions.filter(action => action === 'probe-begin').length >= 2, true, 'Both actual Movie inputs must reach ffprobe.');
  assert.equal(traceActions.filter(action => action === 'probe-failed').length, 0);
  assert.equal(traceActions.filter(action => action === 'before-global').length, 3);
  assert.equal(traceActions.filter(action => action === 'after-global').length, 3);
  const updatedRead = rawTrace.find(entry => entry.phase === 'updated' && entry.action === 'local-reader-completed'
    && entry.detail.provider.endsWith('MovieNfoProvider') && rooted(entry.detail.Path) === '$CASE/media/First.mkv'
    && entry.detail.HasMetadata === true && entry.detail.Name === 'Updated First');
  assert.ok(updatedRead, 'The real Movie NFO reader must execute and return the timed updated title.');
  assert.deepEqual(updatedRead.detail.Genres, [specification.changedGenre]);
  assert.deepEqual(updatedRead.detail.Studios, [specification.studio]);
  assert.equal(updatedRead.detail.tmdbCollectionName, specification.collectionName);
  assert.ok(rawTrace.some(entry => entry.action === 'local-saver-completed' && entry.detail.saver.endsWith('MovieNfoSaver')),
    'The actual Movie NFO saver must execute.');
  assert.ok(rawTrace.some(entry => entry.action === 'local-saver-completed' && entry.detail.saver.endsWith('BoxSetXmlSaver')),
    'The actual BoxSet XML saver must execute.');
  const registered = record.registration.postScanTasks;
  let registrationOrder;
  if (native) {
    assert.deepEqual(record.registration.discoveredPostScanTypes.map(name => name.split(',')[0]), registered,
      'Each native task registration must retain actual CoreAppHost export order.');
    registrationOrder = registered.map(name => taskRoles[name.split('.').at(-1)]);
  } else {
    registrationOrder = record.registration.postScanTaskTypes.map(name => taskRoles[name]);
    assert.deepEqual(registered, registrationOrder, 'Node task names must correspond to their actual registered task types.');
  }
  assert.ok(registrationOrder.every(Boolean));
  assert.deepEqual([...registrationOrder].sort(), [...specification.postScanTasks].sort());
  const queued = [];
  for (const phase of specification.phases) {
    const phaseTrace = rawTrace.filter(entry => entry.phase === phase);
    const role = entry => native ? taskRoles[entry.detail.type.split('.').at(-1)] : entry.detail.name;
    const begins = phaseTrace.filter(entry => entry.action === 'post-task-begin'), completes = phaseTrace.filter(entry => entry.action === 'post-task-completed');
    assert.deepEqual(begins.map(role), registrationOrder, phase + ': actual task begin order must match this side\'s exports.');
    assert.deepEqual(completes.map(role), registrationOrder, phase + ': actual task completion order must match this side\'s exports.');
    for (let index = 0; index < begins.length; index++) {
      assert.ok(Number(begins[index].ordinal) < Number(completes[index].ordinal));
      if (index) assert.ok(Number(completes[index - 1].ordinal) < Number(begins[index].ordinal));
    }
    const returned = phaseTrace.findIndex(entry => entry.action === 'after-global');
    const drain = phaseTrace.findIndex(entry => entry.action === 'queue-drain-completed');
    assert.ok(returned >= 0 && drain > returned, phase + ': preserve actual global-returned and queue-drained boundaries.');
    const admissions = phaseTrace.filter(entry => entry.action === 'queue-admission-begin');
    assert.equal(admissions.length, specification.queuePolicy.expectedAdmissions[phase], phase + ': actual admission count');
    const requests = {}, seen = new Set();
    for (const admitted of admissions) {
      const requestId = Number(admitted.detail.requestId), target = identity(admitted.detail.itemId);
      const options = queueOptions(admitted.detail.options), signature = target + '|' + stable(options);
      assert.equal(seen.has(signature), false, 'This input does not contain ambiguous duplicate admissions.'); seen.add(signature);
      const requestTrace = phaseTrace.filter(entry => Number(entry.detail?.requestId) === requestId);
      const one = action => { const values = requestTrace.filter(entry => entry.action === action); assert.equal(values.length, 1, action); return values[0]; };
      const admissionReturned = one('queue-admission-returned'), startedEntry = one('queue-metadata-start'), completedEntry = one('queue-metadata-completed');
      const drainedEntry = one('queue-request-drained');
      assert.ok(Number(admitted.ordinal) < Number(admissionReturned.ordinal));
      assert.ok(Number(admitted.ordinal) < Number(startedEntry.ordinal));
      assert.ok(Number(startedEntry.ordinal) < Number(completedEntry.ordinal));
      assert.ok(Number(completedEntry.ordinal) < Number(drainedEntry.ordinal));
      assert.ok(Number(drainedEntry.ordinal) < Number(phaseTrace[drain].ordinal));
      for (const entry of [admissionReturned, startedEntry, completedEntry, drainedEntry]) assert.equal(identity(entry.detail.itemId), target);
      assert.deepEqual({ Started: Number(drainedEntry.detail.Started), Completed: Number(drainedEntry.detail.Completed), Failed: Number(drainedEntry.detail.Failed) },
        { Started: 1, Completed: 1, Failed: 0 });
      assert.deepEqual(drainedEntry.detail.queue, { queued: [], processing: false });
      const failures = requestTrace.filter(entry => /-failed$/u.test(entry.action)); assert.deepEqual(failures, []);
      if (!native) {
        const workerStarted = one('queue-worker-start'), workerCompleted = one('queue-worker-completed');
        assert.ok(Number(workerStarted.ordinal) < Number(startedEntry.ordinal));
        assert.ok(Number(completedEntry.ordinal) < Number(workerCompleted.ordinal) && Number(workerCompleted.ordinal) < Number(drainedEntry.ordinal));
        one('queue-item-completed');
      }
      (requests[target] ??= []).push({ target, options, priority: Number(admitted.detail.priority),
        metadataStart: queueItem(startedEntry.detail.item), metadataCompleted: queueItem(completedEntry.detail.item),
        completionStatus: 'completed',
        actualPartialOrder: ['admitted', 'metadata-started', 'metadata-completed', 'whole-worker-drained'],
        admissionReturned: true, started: 1, completed: 1, failed: 0, drained: 1 });
    }
    const total = action => phaseTrace.filter(entry => entry.action === action).length;
    const counts = { admitted: admissions.length, metadataStarted: total('queue-metadata-start'), metadataCompleted: total('queue-metadata-completed'),
      metadataFailed: total('queue-metadata-failed'), drained: total('queue-request-drained'),
      duplicateAdmissions: admissions.length - seen.size, unaccountedAdmissions: admissions.length - total('queue-metadata-start') };
    assert.equal(counts.unaccountedAdmissions, 0); assert.equal(counts.metadataFailed, 0);
    assert.equal(counts.metadataCompleted, counts.admitted); assert.equal(counts.drained, counts.admitted);
    assert.equal(total('queue-drain-begin'), 1); assert.equal(total('queue-drain-completed'), 1);
    assert.deepEqual(phaseTrace[drain].detail, { queued: [], processing: false });
    queued.push({ phase, counts, requests: Object.fromEntries(Object.entries(requests).sort(([a], [b]) => compare(a, b))),
      realDrain: { began: 1, completed: 1, queued: [], processing: false } });
  }
  assert.ok(BigInt(record.updateInput.elapsedTicks) > BigInt(record.updateInput.toleranceTicks));
  return { stages, scanOutcomes, queued, registrationOrder,
    events: Object.fromEntries(Object.entries(events).sort(([a], [b]) => compare(a, b))),
    bindings: { items: Object.fromEntries(logicalById), itemValues: Object.fromEntries(valueById), clocks: clockBindings,
      actualExternalCleanup: { calls: cleanups.length, completed: cleanups.length, failures: 0,
        observation: 'Each actual service invocation retains before/after extracted path existence, real file bytes/SHA and the complete four affected SQL tables in the unmodified raw trace. No nonexistent-path premise bypasses the service.' },
      rawQueueBoundaries: record.observations.map(value => ({ phase: value.phase, boundary: value.boundary, queue: value.queue })) } };

  function queueOptions(options) {
    const modes = { None: 0, ValidationOnly: 1, Default: 2, FullRefresh: 3 };
    const mode = value => { const actual = typeof value === 'string' ? modes[value] : Number(value ?? 2); assert.ok([0, 1, 2, 3].includes(actual)); return actual; };
    return { MetadataRefreshMode: mode(options.MetadataRefreshMode), ImageRefreshMode: mode(options.ImageRefreshMode),
      ForceSave: options.ForceSave ?? false, ReplaceAllMetadata: options.ReplaceAllMetadata ?? false,
      IsAutomated: options.IsAutomated ?? true, RemoveOldMetadata: options.RemoveOldMetadata ?? false,
      RefreshPaths: options.RefreshPaths == null ? [] : options.RefreshPaths.map(rooted) };
  }
  function queueItem(item) {
    return { id: identity(item.id), type: item.type, Name: item.Name, Genres: item.Genres, Studios: item.Studios,
      tmdbCollectionName: item.tmdbCollectionName ?? null, Overview: item.Overview ?? null,
      RunTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks), IsLocked: item.IsLocked, ProviderIds: item.ProviderIds };
  }
  function assertScenario() {
    const raw = phase => observations.find(value => value.phase === phase).snapshot;
    const created = raw('created'), updated = raw('updated'), deleted = raw('deleted');
    const movieAt = (snapshot, name) => snapshot.sql.BaseItems.find(row => rooted(row.Path) === '$CASE/media/' + name + '.mkv');
    const valueRows = (snapshot, item) => {
      const ids = new Set(snapshot.sql.ItemValuesMap.filter(row => key(row.ItemId) === key(item.Id)).map(row => key(row.ItemValueId)));
      return snapshot.sql.ItemValues.filter(row => ids.has(key(row.ItemValueId)) && [2, 3].includes(Number(row.Type)))
        .map(row => ({ type: Number(row.Type), value: row.Value })).sort((a, b) => a.type - b.type || compare(a.value, b.value));
    };
    const movie = (snapshot, name, title, genre, locked) => {
      const row = movieAt(snapshot, name); assert.ok(row, title);
      assert.equal(row.Type, 'MediaBrowser.Controller.Entities.Movies.Movie'); assert.equal(row.Name, title);
      assert.equal(row.Overview, specification.overview); assert.equal(Number(row.IsLocked), Number(locked));
      assert.equal(row.Genres, genre); assert.equal(row.Studios, specification.studio);
      assert.equal(parseLosslessJson(row.Data).TmdbCollectionName, specification.collectionName);
      assert.ok(BigInt(row.RunTimeTicks) > 0n);
      assert.ok(snapshot.sql.MediaStreamInfos.some(stream => key(stream.ItemId) === key(row.Id)
        && Number(stream.StreamType) === 1 && stream.Codec === 'ffv1' && Number(stream.Width) === 32 && Number(stream.Height) === 32));
      assert.deepEqual(valueRows(snapshot, row), [{ type: 2, value: genre }, { type: 3, value: specification.studio }]);
      const parent = snapshot.sql.BaseItems.find(value => key(value.Id) === key(row.ParentId));
      assert.equal(rooted(parent?.Path), '$CASE/media');
      assert.ok(snapshot.sql.AncestorIds.some(value => key(value.ItemId) === key(row.Id) && key(value.ParentItemId) === key(parent.Id)));
      const file = snapshot.files.find(file => file.path === 'media/' + name + '.nfo'); assert.ok(file);
      const document = readXml(file.text), custom = document.children.find(node => node.name === 'custom');
      assert.equal(custom?.text, 'retained'); assert.equal(custom?.attributes.keep, 'true');
      assert.equal(document.children.find(node => node.name === 'title')?.text, title);
      return row;
    };
    const first = movie(created, 'First', 'First', specification.originalGenre, false);
    const second = movie(created, 'Second', 'Second', specification.originalGenre, false);
    assert.equal(key(movie(updated, 'First', 'Updated First', specification.changedGenre, true).Id), key(first.Id));
    assert.equal(key(movie(updated, 'Second', 'Second', specification.originalGenre, false).Id), key(second.Id));
    assert.equal(key(movie(deleted, 'Second', 'Second', specification.originalGenre, false).Id), key(second.Id));
    assert.equal(key(record.updateInput.originalItemId), key(first.Id));
    assert.equal(deleted.sql.BaseItems.some(row => key(row.Id) === key(first.Id) || rooted(row.Path) === '$CASE/media/First.mkv'), false);
    for (const table of ['AncestorIds', 'MediaStreamInfos', 'ItemValuesMap', 'BaseItemProviders', 'BaseItemMetadataFields', 'BaseItemImageInfos', 'Chapters', 'AttachmentStreamInfos'])
      assert.equal(deleted.sql[table].some(row => key(row.ItemId) === key(first.Id)), false, table + ': deleted Movie relations');
    assert.equal(deleted.sql.LinkedChildren.some(row => key(row.ChildId) === key(first.Id) || key(row.ParentId) === key(first.Id)), false);
    let collectionId;
    for (const [index, snapshot] of [created, updated, deleted].entries()) {
      const movies = snapshot.sql.BaseItems.filter(row => row.Type === 'MediaBrowser.Controller.Entities.Movies.Movie');
      assert.equal(movies.length, index === 2 ? 1 : 2);
      const collections = snapshot.sql.BaseItems.filter(row => row.Type === 'MediaBrowser.Controller.Entities.Movies.BoxSet' && row.Name === specification.collectionName);
      assert.equal(collections.length, 1); const collection = collections[0];
      collectionId ??= key(collection.Id); assert.equal(key(collection.Id), collectionId);
      const links = snapshot.sql.LinkedChildren.filter(row => key(row.ParentId) === collectionId).sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder));
      assert.deepEqual(links.map(row => key(row.ChildId)).sort(), (index === 2 ? [key(second.Id)] : [key(first.Id), key(second.Id)]).sort());
      const xml = snapshot.files.filter(file => file.path.endsWith('/collection.xml')); assert.equal(xml.length, 1);
      if (index < 2) {
        const list = readXml(xml[0].text).children.find(node => node.name === 'CollectionItems'); assert.ok(list);
        assert.deepEqual(list.children.filter(node => node.name === 'CollectionItem').map(node => rooted(node.children.find(value => value.name === 'Path')?.text)).sort(),
          ['$CASE/media/First.mkv', '$CASE/media/Second.mkv']);
      }
      // Automatic maintenance does not promise an XML rewrite after deletion.
      // The complete actual XML still participates in the native/PG comparison.
      const media = snapshot.mediaFiles;
      assert.deepEqual(media.map(file => file.path), index === 2 ? ['media/Second.mkv'] : ['media/First.mkv', 'media/Second.mkv']);
      const binding = native ? { bytes: Number(record.Media.Bytes), sha256: record.Media.Sha256 } : record.media;
      for (const file of media) { assert.equal(file.sha256, binding.sha256); assert.equal(Number(file.bytes), Number(binding.bytes)); }
    }
  }

  function xmlNode(node, row, phase) {
    const logical = identity(row.Id);
    let body = node.text;
    if (node.name === 'dateadded') {
      const expected = new Date(Number((dateTicks(row.DateCreated) - 621355968000000000n) / 10000n)).toISOString().slice(0, 19).replace('T', ' ');
      assert.equal(body, expected, 'NFO dateadded must agree with the real persisted DateCreated to its own second precision.');
      body = clock(row.DateCreated, logical, 'DateCreated', phase);
    } else if (node.name === 'Added') {
      const instant = new Date(Number((dateTicks(row.DateCreated) - 621355968000000000n) / 10000n)), pad = value => String(value).padStart(2, '0');
      const expected = `${pad(instant.getMonth() + 1)}/${pad(instant.getDate())}/${instant.getFullYear()} ${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}`;
      assert.equal(body, expected, 'Collection XML Added must agree with its real persisted local DateCreated.');
      body = clock(row.DateCreated, logical, 'DateCreated', phase);
    } else body = text(body, logical, node.name, phase);
    const namespace = node.name.includes(':') ? node.namespaces['xmlns:' + node.name.split(':')[0]] : node.namespaces.xmlns ?? '';
    const attributes = Object.fromEntries(Object.entries(node.attributes).filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:')).sort(([a], [b]) => compare(a, b)));
    // Layout-only indentation between child elements is reader-insignificant.
    // Leaf and mixed content, unknown elements and real attributes survive.
    const content = node.content.map(entry => typeof entry === 'string' ? text(entry, logical, node.name, phase) : xmlNode(entry, row, phase))
      .filter(entry => !(node.children.length && typeof entry === 'string' && !entry.trim()));
    return { name: node.name, namespace, attributes, text: node.children.length ? null : body,
      content: node.children.length ? content : [] };
  }
}

export function differences(actual, expected, prefix = '$', limit = 1000) {
  const result = [];
  const visit = (a, b, location) => {
    if (isDeepStrictEqual(a, b) || result.length >= limit) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) visit(a[name], b[name], location + (Array.isArray(a) ? '[' + name + ']' : '.' + name));
      return;
    }
    result.push({ path: location, actual: a === undefined ? { missing: true } : a, expected: b === undefined ? { missing: true } : b });
  };
  visit(actual, expected, prefix); return { entries: result, truncated: result.length >= limit };
}
