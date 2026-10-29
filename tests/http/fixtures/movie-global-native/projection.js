import assert from 'node:assert/strict';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativeModel } from '../../../../src/database/model.js';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { readXml } from '../../../../src/core/xml.js';
import { dateTicks } from '../../../../src/library/records.js';
import { nativeItemJsonContract, nativeItemJsonValidationManifest } from '../../../../src/library/native-item-data.js';
import { tokenizeJson } from '../../../../src/core/json-tokens.js';

const slash = value => value.replaceAll('\\', '/');
const key = value => String(value).replaceAll('-', '').toLowerCase();
const empty = '0'.repeat(32);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stable = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
const exactDate = value => value == null ? value : { ticks: dateTicks(value).toString() };
const aggregateLogicalPrefix = 'MediaBrowser.Controller.Entities.AggregateFolder|';
const taskRoles = { SplashscreenPostScanTask: 'Splashscreen', ArtistsPostScanTask: 'Artists',
  CollectionPosterVerifyPostScanTask: 'CollectionPosterVerify', CollectionPostScanTask: 'Collections',
  GenresPostScanTask: 'Genres', MusicGenresPostScanTask: 'MusicGenres', StudiosPostScanTask: 'Studios',
  CleanDatabaseScheduledTask: 'CleanDatabase', CleanDatabasePostScanTask: 'CleanDatabase' };
const dataManifest = nativeItemJsonValidationManifest();
// VirtualChildren is serialized through the declared BaseItem element type;
// Folder's contract adds only IsRoot to those common fields.
const baseDataContract = nativeItemJsonContract('MediaBrowser.Controller.Entities.Folder').filter(field => field.name !== 'IsRoot');
const dataPaths = new Set(['ShortcutPath', 'AdditionalParts', 'LocalAlternateVersions', 'SubtitleFiles', 'AudioFiles', 'LyricFiles', 'PhysicalLocationsList']);

/** New typed saves may differ in JSON layout. Unknown source tokens remain
 * literal, rather than becoming identities merely because they resemble one. */
export function projectMovieData(text, type, { logical, phase, identity, rooted, clock }) {
  const value = parseLosslessJson(text);
  if (!Object.hasOwn(dataManifest.contracts, type)) return { value, raw: text };
  const unknown = [];
  const visit = (node, contract, owner, role, path = []) => {
    if (!node.properties) return parseLosslessJson(text.slice(node.start, node.end));
    const fields = new Map(contract.map(field => [field.name, field]));
    const output = {};
    for (const [name, child] of node.properties) {
      const field = fields.get(name);
      if (!field) {
        unknown.push({ path: [...path, name], raw: text.slice(child.start, child.end) });
        output[name] = parseLosslessJson(text.slice(child.start, child.end)); continue;
      }
      const element = (entry, index) => {
        const kind = field.kind.replace(/\[\]$/u, '');
        const source = parseLosslessJson(text.slice(entry.start, entry.end));
        const childOwner = index === undefined ? owner : owner + '|' + name + '[' + index + ']';
        if (source == null) return source;
        if (kind === 'guid') return identity(source);
        if (kind === 'date') return clock(source, owner, name, phase);
        if (kind === 'entity') return visit(entry, baseDataContract, childOwner, 'BaseItem', [...path, name, index]);
        if (dataManifest.nested[kind]) return visit(entry,
          Object.entries(dataManifest.nested[kind]).map(([name, field]) => ({ name, ...field })), childOwner, kind, [...path, name]);
        if (dataPaths.has(name) || role === 'LinkedChild' && name === 'Path') return rooted(source);
        return source;
      };
      const projected = field.kind.endsWith('[]') && child.items ? child.items.map(element) : element(child);
      output[name] = name === 'PhysicalLocationsList' && type === 'MediaBrowser.Controller.Entities.AggregateFolder'
        && role === type && Array.isArray(projected) ? normalizeAggregatePhysicalLocations(projected, owner) : projected;
    }
    return output;
  };
  return { value: visit(tokenizeJson(text), nativeItemJsonContract(type), logical, type), unknown };
}

const movieContainers = new Set(['movie', 'movie/fileinfo', 'movie/fileinfo/streamdetails',
  'movie/fileinfo/streamdetails/video', 'movie/fileinfo/streamdetails/audio', 'movie/fileinfo/streamdetails/subtitle', 'movie/actor', 'movie/fanart']);
const boxSetContainers = new Set(['Item', 'Item/Genres', 'Item/Studios', 'Item/Tags', 'Item/Persons',
  'Item/Persons/Person', 'Item/CollectionItems', 'Item/CollectionItems/CollectionItem']);
export function projectMovieXml(node, { type, rooted, dateadded, added, framerate }) {
  const visit = (node, parents = [], schemaNamespace = true) => {
    const location = [...parents, node.name], path = location.join('/');
    const namespace = node.name.includes(':') ? node.namespaces['xmlns:' + node.name.split(':')[0]] : node.namespaces.xmlns ?? '';
    const schema = schemaNamespace && namespace === '';
    const movie = type === 'MediaBrowser.Controller.Entities.Movies.Movie';
    const boxSet = type === 'MediaBrowser.Controller.Entities.Movies.BoxSet';
    let body = node.text;
    if (schema && !node.children.length) {
      if (movie && path === 'movie/dateadded') body = dateadded(body);
      else if (boxSet && path === 'Item/Added') body = added(body);
      else if (movie && path === 'movie/fileinfo/streamdetails/video/framerate') body = framerate(body);
      else if (movie && path === 'movie/path' || boxSet && path === 'Item/CollectionItems/CollectionItem/Path') body = rooted(body);
    }
    const attributes = Object.fromEntries(Object.entries(node.attributes).filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:')).sort(([a], [b]) => compare(a, b)));
    const attributeNamespaces = Object.fromEntries(Object.keys(attributes).filter(name => name.includes(':'))
      .map(name => [name, node.namespaces['xmlns:' + name.split(':')[0]] ?? null]));
    const layout = schema && (movie ? movieContainers : boxSet ? boxSetContainers : new Set()).has(path);
    const content = node.content.map(entry => typeof entry === 'string' ? entry : visit(entry, location, schema))
      .filter(entry => !(layout && node.children.length && typeof entry === 'string' && !entry.trim()));
    return { name: node.name, namespace, attributes, attributeNamespaces,
      text: node.children.length ? null : body, content: node.children.length ? content : [] };
  };
  return visit(node);
}

/** AggregateFolder always places its own Path first. The remaining locations
 * come from recursive operating-system enumeration, whose order is not a
 * contract shared by DirectoryInfo and Node fs.readdir. */
export function normalizeAggregatePhysicalLocations(values, logical) {
  if (!logical.startsWith(aggregateLogicalPrefix)) return values;
  const own = logical.slice(aggregateLogicalPrefix.length);
  assert.ok(values.length > 0, 'AggregateFolder PhysicalLocationsList must retain its own Path.');
  assert.equal(values[0], own, 'AggregateFolder PhysicalLocationsList must retain its own Path at index 0.');
  return [values[0], ...values.slice(1).sort(compare)];
}

export function assertAggregatePhysicalLocationSet(values, own, expected) {
  assert.ok(Array.isArray(values), 'AggregateFolder PhysicalLocationsList must be an array.');
  assert.ok(values.length > 0, 'AggregateFolder PhysicalLocationsList must retain its own Path.');
  assert.equal(values[0], own, 'AggregateFolder PhysicalLocationsList must retain its own Path at index 0.');
  assert.equal(new Set(values).size, values.length, 'AggregateFolder PhysicalLocationsList must not contain duplicates.');
  assert.deepEqual([...values].sort(compare), [...expected].sort(compare),
    'AggregateFolder PhysicalLocationsList must retain the complete raw location set.');
}

export function isConcurrentBoxSetMetadataEditEvent(value) {
  return value.phase === 'created' && value.action === 'updated'
    && value.type === 'MediaBrowser.Controller.Entities.Movies.BoxSet' && Number(value.updateReason) === 16;
}

/** These samples are evidence of observed states, not an exhaustive model of
 * every legal race. An unseen value retains its original for explicit review. */
export function movieConcurrentEventPolicy(records) {
  const result = {};
  for (const [recordIndex, record] of records.entries()) for (const entry of record.trace ?? []) {
    const item = entry.detail?.item;
    if (entry.phase !== 'created' || item?.type !== 'MediaBrowser.Controller.Entities.Movies.BoxSet') continue;
    const root = slash(record.root), location = slash(item.path);
    const logical = item.type + '|' + (location === root ? '$CASE' : location.startsWith(root + '/') ? '$CASE/' + location.slice(root.length + 1) : item.path);
    const policy = result[logical] ??= { Genres: [], Studios: [] };
    for (const field of ['Genres', 'Studios']) {
      if (!Array.isArray(item[field]) || !item[field].every(value => typeof value === 'string')) continue;
      let variant = policy[field].find(value => isDeepStrictEqual(value.value, item[field]));
      if (!variant) { variant = { value: structuredClone(item[field]), observed: [] }; policy[field].push(variant); }
      variant.observed.push({ recordIndex, ordinal: entry.ordinal, action: entry.action, metadataId: entry.metadataId ?? null, requestId: entry.requestId ?? null });
    }
  }
  return result;
}

export function stabilizeMovieEventProjection(value, { policy, validateDate } = {}) {
  if (!isConcurrentBoxSetMetadataEditEvent(value)) return value;
  const projected = { ...value };
  for (const field of ['Genres', 'Studios']) {
    assert.ok(Array.isArray(value[field]) && value[field].every(entry => typeof entry === 'string'), 'The actual callback must retain typed ' + field + '.');
    if (!policy?.[field]?.some(variant => isDeepStrictEqual(variant.value, value[field]))) {
      const error = new Error('A concurrent BoxSet ' + field + ' value needs review against the current Native originals.');
      error.code = 'MOVIE_OBSERVATION_REVIEW_REQUIRED'; error.observation = { field, value: value[field], id: value.id }; throw error;
    }
    projected[field] = '$native-concurrent-' + field;
  }
  for (const field of ['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed']) {
    assert.ok(Object.hasOwn(value, field) && typeof value[field] === 'string', 'The actual callback must retain its DateTime ' + field + '.');
    validateDate(value[field], field);
    projected[field] = '$native-concurrent-' + field;
  }
  return projected;
}

const concurrentBoxSetRefreshReasons = [16, 2, 19];

/** Native dispatches this exact created-phase BoxSet callback cohort from
 * concurrent continuations. Canonicalize only those three contiguous callbacks;
 * added, image-update and every other event retain their observed order. */
export function stabilizeConcurrentBoxSetEventOrder(values, { before = [] } = {}) {
  const indices = values.map((value, index) => ({ value, index })).filter(({ value }) =>
    value.phase === 'created' && value.action === 'updated'
    && value.type === 'MediaBrowser.Controller.Entities.Movies.BoxSet'
    && concurrentBoxSetRefreshReasons.includes(Number(value.updateReason))).map(({ index }) => index);
  if (!indices.length) return values;
  assert.equal(indices.length, concurrentBoxSetRefreshReasons.length,
    'The controlled created-phase BoxSet refresh must emit exactly the observed callback cohort.');
  assert.equal(indices.at(-1) - indices[0], concurrentBoxSetRefreshReasons.length - 1,
    'The concurrent BoxSet callback cohort must not cross an unrelated event.');
  const byReason = new Map(indices.map(index => [Number(values[index].updateReason), values[index]]));
  assert.equal(byReason.size, concurrentBoxSetRefreshReasons.length,
    'The concurrent BoxSet callback cohort must contain each reason exactly once.');
  for (const reason of concurrentBoxSetRefreshReasons) assert.ok(byReason.has(reason),
    'The concurrent BoxSet callback cohort is missing update reason ' + reason + '.');
  for (const [left, right] of before) assert.ok(values.indexOf(byReason.get(left)) < values.indexOf(byReason.get(right)),
    'A real metadata worker causal edge must retain callback order: ' + left + ' before ' + right + '.');
  const result = [...values];
  concurrentBoxSetRefreshReasons.forEach((reason, offset) => { result[indices[0] + offset] = byReason.get(reason); });
  return result;
}

export function assertMovieEventCausality(trace) {
  const edges = new Map();
  const operations = new Map(trace.filter(entry => entry.action === 'metadata-begin' && entry.metadataId != null).map(entry => [Number(entry.metadataId), entry]));
  for (const entry of trace.filter(entry => ['added', 'updated', 'removed'].includes(entry.action))) {
    const begin = operations.get(Number(entry.metadataId));
    const own = begin && key(begin.detail.item?.id ?? begin.detail.reference) === key(entry.detail.item.id);
    const cohort = entry.phase === 'created' && entry.action === 'updated'
      && entry.detail.item.type === 'MediaBrowser.Controller.Entities.Movies.BoxSet' && [2, 19].includes(Number(entry.detail.updateReason));
    if (cohort && !own) {
      const error = new Error('The raced BoxSet refresh callback needs an actual owning metadata operation in the original trace.');
      error.code = 'MOVIE_OBSERVATION_REVIEW_REQUIRED'; error.observation = entry; throw error;
    }
    if (!own) continue;
    const completed = trace.find(value => value.action === 'metadata-completed' && value.metadataId === begin.metadataId);
    assert.ok(completed && Number(begin.ordinal) < Number(entry.ordinal) && Number(entry.ordinal) < Number(completed.ordinal),
      'An owned Item callback must occur inside its actual metadata operation.');
    if (entry.requestId != null) {
      const started = trace.find(value => value.action === 'queue-metadata-start' && Number(value.detail.requestId) === Number(entry.requestId));
      const finished = trace.find(value => value.action === 'queue-metadata-completed' && Number(value.detail.requestId) === Number(entry.requestId));
      // Folder validation can refresh other children after the queued target's
      // metadata callback. Those descendants retain their own operation span.
      if (started && key(started.detail.itemId) === key(entry.detail.item.id)) assert.ok(finished
        && Number(started.ordinal) < Number(entry.ordinal) && Number(entry.ordinal) < Number(finished.ordinal),
      'A queued target callback must occur inside its actual request metadata span.');
    }
    if (!cohort || Number(entry.detail.updateReason) !== 19) continue;
    const early = trace.find(value => value.action === 'updated' && value.metadataId === begin.metadataId
      && key(value.detail.item.id) === key(entry.detail.item.id) && Number(value.detail.updateReason) === 2);
    if (early) {
      assert.ok(Number(early.ordinal) < Number(entry.ordinal), 'The same refresh must publish its first save before its final save.');
      edges.set(key(entry.detail.item.id), [[2, 19]]);
    }
  }
  for (const admitted of trace.filter(entry => entry.phase === 'created' && entry.action === 'queue-admission-begin' && entry.detail.options?.ForceSave === true)) {
    const edit = trace.find(entry => entry.phase === admitted.phase && entry.action === 'updated'
      && key(entry.detail.item.id) === key(admitted.detail.itemId) && Number(entry.detail.updateReason) === 16
      && Number(entry.ordinal) < Number(admitted.ordinal));
    assert.ok(edit, 'Collection membership MetadataEdit must complete before its actual ForceSave queue admission.');
  }
  return edges;
}

/** Full raw snapshots stay intact. These bindings are independently checked in
 * each run and reused across its three stages, including deleted identities. */
export function projectMovieRun(record, specification, eventPolicy) {
  const root = slash(record.root), native = record.actualExecution === true;
  const logicalById = new Map(), idByLogical = new Map(), valueById = new Map(), idByValue = new Map();
  const clockByTicks = new Map(), ticksByClock = new Map(), previousByField = new Map(), clockBindings = [];
  const eventClockCounters = new Map(), eventClockByTicks = new Map();
  // File.Copy can preserve the common generated asset's real creation/mtime.
  // Its preparation window therefore precedes either independent runtime.
  const started = dateTicks(native ? record.ClockWindowStart : record.clockWindowStart), ended = dateTicks(record.endedAt);
  assert.ok(started <= dateTicks(record.startedAt));
  assert.equal(record.timeZone.offsetMinutes, specification.localTimezoneOffsetMinutes);
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
  const xmlCreated = new Map();
  for (const entry of record.trace ?? []) if (entry.action === 'added'
    && entry.detail.item.type === 'MediaBrowser.Controller.Entities.Movies.BoxSet') {
    const item = entry.detail.item, logical = identity(item.id), seed = dateTicks(item.DateCreated);
    assert.ok(seed >= started && seed <= ended, 'The actual collection creation must lie in its real run window.');
    const derived = seed / 10000000n * 10000000n + BigInt(record.timeZone.offsetMinutes) * 600000000n;
    assert.equal(xmlCreated.has(logical), false, 'The controlled collection must have one actual Added seed.');
    xmlCreated.set(logical, { seed, value: item.DateCreated, derived });
  }
  const xmlCreatedClock = (ticks, logical, field, phase) => {
    const binding = field === 'DateCreated' ? xmlCreated.get(logical) : null;
    if (!binding || ticks === binding.seed) return null;
    assert.equal(ticks, binding.derived, 'Collection Added may apply the actual local XML/AssumeUniversal transform exactly once.');
    assert.ok(record.trace.some(entry => entry.action === 'local-reader-completed'
      && entry.detail.provider.endsWith('BoxSetXmlProvider') && entry.detail.HasMetadata
      && rooted(entry.detail.Path) === logical.slice(logical.indexOf('|') + 1)
      && dateTicks(entry.detail.DateCreated) === ticks), 'The shifted clock must be returned by the actual XML parser.');
    const token = '$XMLADDED|' + clock(binding.value, logical, field, phase);
    if (!clockBindings.some(entry => entry.token === token)) clockBindings.push({ token, ticks: ticks.toString(),
      sourceTicks: binding.seed.toString(), localOffsetMinutes: record.timeZone.offsetMinutes, firstPhase: phase,
      transform: 'ToLocalTime second precision -> XML Added -> AssumeUniversal|AdjustToUniversal', logical, field });
    return token;
  };
  const clock = (value, logical, field, phase) => {
    if (value == null) return value;
    const ticks = dateTicks(value), serialized = ticks.toString();
    if (ticks === 0n) return { ticks: '0' };
    const xmlClock = xmlCreatedClock(ticks, logical, field, phase);
    if (xmlClock !== null) return xmlClock;
    assert.ok(ticks >= started && ticks <= ended, 'A projected clock is outside its actual run window: ' + logical + ':' + field);
    const fieldKey = logical + '|' + field;
    const clockKey = fieldKey + '|' + serialized;
    if (previousByField.has(fieldKey)) assert.ok(ticks >= previousByField.get(fieldKey),
      'A clock moved backwards within one owner/field role: ' + fieldKey + ' in ' + phase);
    previousByField.set(fieldKey, ticks);
    if (!clockByTicks.has(clockKey)) {
      const token = '$CLOCK|' + fieldKey + '|' + phase;
      assert.equal(ticksByClock.has(token), false, 'Two distinct clock values would collapse to one token.');
      clockByTicks.set(clockKey, token); ticksByClock.set(token, serialized);
      clockBindings.push({ token, ticks: serialized, firstPhase: phase, logical, field });
    }
    return clockByTicks.get(clockKey);
  };
  const pathColumns = new Set(['BaseItems.Path', 'LinkedChildren.Path', 'MediaStreamInfos.Path', 'BaseItemImageInfos.Path', 'ImageInfos.Path']);
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
          if (column.name === 'Data' && table.name === 'BaseItems') return [column.name,
            projectMovieData(value, row.Type, { logical, phase: observation.phase, identity, rooted, clock })];
          if (column.clrType.replace('?', '') === 'Guid') return [column.name, identity(value)];
          if (column.clrType.replace('?', '') === 'DateTime') return [column.name,
            table.name === 'BaseItems' && clockFields.has(column.name) ? clock(value, logical, column.name, observation.phase) : exactDate(value)];
          if (pathColumns.has(table.name + '.' + column.name)) return [column.name, rooted(value)];
          if (table.name === 'BaseItems' && column.name === 'PresentationUniqueKey' && key(value) === key(row.Id)) return [column.name, identity(value)];
          if (table.name === 'UserData' && column.name === 'CustomDataKey' && key(value) === key(row.ItemId)) return [column.name, identity(value)];
          return [column.name, value];
        }));
      });
      // Every order-bearing column remains present, including LinkedChildren's
      // SortOrder. Physical entity row order is retained in raw SQLite evidence.
      sql[table.name] = rows.sort((a, b) => compare(stable(a), stable(b)));
    }
    for (const name of ['__EFMigrationsHistory', '__EFMigrationsLock'])
      sql[name] = observation.snapshot.sql[name].map(row => structuredClone(row)).sort((a, b) => compare(stable(a), stable(b)));
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
    const xmlClock = xmlCreatedClock(ticks, logical, field, phase);
    if (xmlClock !== null) return xmlClock;
    assert.ok(ticks >= started && ticks <= ended, 'An Item event clock is outside the actual run window.');
    if (clockByTicks.has(clockKey)) return clockByTicks.get(clockKey);
    if (!eventClockByTicks.has(clockKey)) {
      const slot = logical + '|' + field + '|' + phase, index = eventClockCounters.get(slot) ?? 0;
      eventClockCounters.set(slot, index + 1); eventClockByTicks.set(clockKey, '$EVENTCLOCK|' + slot + '|' + index);
      clockBindings.push({ token: eventClockByTicks.get(clockKey), ticks: serialized, firstPhase: phase, logical, field, eventOnly: true });
    }
    return eventClockByTicks.get(clockKey);
  };
  let concurrentBoxSetEditEvents = 0;
  const events = {};
  const rawTrace = record.trace ?? [];
  const causalEdges = assertMovieEventCausality(rawTrace);
  assert.deepEqual(rawTrace.map(entry => Number(entry.ordinal)), Array.from({ length: rawTrace.length }, (_, index) => index + 1),
    'The raw trace must be cumulative, contiguous and complete.');
  for (const entry of rawTrace.filter(entry => specification.phases.includes(entry.phase) && ['added', 'updated', 'removed'].includes(entry.action))) {
    const item = entry.detail.item, logical = identity(item.id);
    assert.ok(logicalById.has(key(item.id)), 'Every emitted item identity must occur in an actual table snapshot.');
    const event = { phase: entry.phase, action: entry.action, id: logical, type: item.type, Name: item.Name,
      path: rooted(item.path), parent: identity(entry.detail.parent ?? null),
      updateReason: Number(entry.detail.updateReason), ParentId: identity(item.ParentId), OwnerId: identity(item.OwnerId),
      IsFolder: item.IsFolder, Genres: item.Genres, Studios: item.Studios, tmdbCollectionName: item.tmdbCollectionName,
      Overview: item.Overview ?? null, RunTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
      ProviderIds: item.ProviderIds, IsLocked: item.IsLocked };
    const concurrentEdit = isConcurrentBoxSetMetadataEditEvent(event);
    if (concurrentEdit) assert.equal(++concurrentBoxSetEditEvents, 1,
      'Only the single observed created-phase BoxSet MetadataEdit callback may stabilize raced fields.');
    for (const field of ['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed']) {
      event[field] = concurrentEdit ? item[field] : eventDate(item[field], logical, field, entry.phase);
    }
    (events[logical] ??= []).push(stabilizeMovieEventProjection(event, { policy: eventPolicy?.[logical], validateDate(value, field) {
      const ticks = dateTicks(value);
      if (field === 'DateCreated') {
        const created = xmlCreated.get(logical); assert.ok(created, 'The callback must identify the real collection creation.');
        if (ticks !== created.seed) {
          xmlCreatedClock(ticks, logical, field, entry.phase);
          assert.ok(rawTrace.some(value => value.action === 'local-reader-completed' && Number(value.ordinal) < Number(entry.ordinal)
            && value.detail.provider.endsWith('BoxSetXmlProvider') && value.detail.HasMetadata
            && rooted(value.detail.Path) === logical.slice(logical.indexOf('|') + 1) && dateTicks(value.detail.DateCreated) === ticks),
          'The concurrent callback must follow the actual XML reader that made its shifted creation reachable.');
        }
      } else assert.ok(ticks === 0n || ticks >= started && ticks <= ended, 'The concurrent callback DateTime must be minimum or inside its real run window.');
    } }));
  }
  const traceActions = rawTrace.map(entry => entry.action);
  if (native) assert.equal(record.registration.externalDataManager, 'Emby.Server.Implementations.Library.ExternalDataManager');
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
  const explicitSaves = rawTrace.filter(entry => entry.action === 'explicit-movie-save-completed');
  assert.equal(explicitSaves.length, specification.movies.length);
  assert.deepEqual(explicitSaves.map(entry => rooted(entry.detail.item.path)),
    specification.movies.map(name => '$CASE/media/' + name + '.mkv'));
  for (const entry of explicitSaves) {
    assert.equal(entry.phase, 'created'); assert.equal(Number(entry.detail.updateReason), specification.explicitMovieSaveUpdateReason);
    const begins = rawTrace.filter(value => value.action === 'explicit-movie-save-begin'
      && key(value.detail.item.id) === key(entry.detail.item.id));
    assert.equal(begins.length, 1); assert.ok(Number(begins[0].ordinal) < Number(entry.ordinal));
    assert.ok(rawTrace.some(value => value.action === 'local-saver-completed' && value.detail.saver.endsWith('MovieNfoSaver')
      && key(value.detail.itemId) === key(entry.detail.item.id) && Number(value.ordinal) > Number(begins[0].ordinal)
      && Number(value.ordinal) < Number(entry.ordinal)), 'Each explicit Movie save must execute the actual NFO saver.');
  }
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
    events: Object.fromEntries(Object.entries(events).sort(([a], [b]) => compare(a, b))
      .map(([logical, values]) => [logical, stabilizeConcurrentBoxSetEventOrder(values, { before: causalEdges.get(key(idByLogical.get(logical))) ?? [] })])),
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
    const aggregateLocations = (snapshot, expected) => {
      const rows = snapshot.sql.BaseItems.filter(row => row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
      assert.equal(rows.length, 1, 'Each raw Movie stage must contain exactly one AggregateFolder.');
      const locations = parseLosslessJson(rows[0].Data).PhysicalLocationsList.map(rooted);
      assertAggregatePhysicalLocationSet(locations, '$CASE/program/root', expected);
    };
    aggregateLocations(created, ['$CASE/program/root', '$CASE/media']);
    for (const snapshot of [updated, deleted]) aggregateLocations(snapshot,
      ['$CASE/program/root', '$CASE/media', '$CASE/program/data/collections']);
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
      assert.equal(row.Genres, genre);
      // The actual stored empty Studios column hydrates as [""]; merging
      // retains that entry beside the sidecar studio. ItemValues omits it.
      assert.equal(row.Studios, specification.studio + '|');
      assert.equal(parseLosslessJson(row.Data).TmdbCollectionName, specification.collectionName);
      assert.ok(BigInt(row.RunTimeTicks) > 0n);
      assert.ok(snapshot.sql.MediaStreamInfos.some(stream => key(stream.ItemId) === key(row.Id)
        && Number(stream.StreamType) === 1 && stream.Codec === 'mpeg2video' && Number(stream.Width) === 720 && Number(stream.Height) === 480));
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
    return projectMovieXml(node, { type: row.Type, rooted, dateadded(body) {
      const expected = new Date(Number((dateTicks(row.DateCreated) - 621355968000000000n) / 10000n)).toISOString().slice(0, 19).replace('T', ' ');
      assert.equal(body, expected, 'NFO dateadded must agree with the real persisted DateCreated to its own second precision.');
      return clock(row.DateCreated, logical, 'DateCreated', phase);
    }, added(body) {
      const instant = new Date(Number((dateTicks(row.DateCreated) - 621355968000000000n) / 10000n)), pad = value => String(value).padStart(2, '0');
      const expected = `${pad(instant.getMonth() + 1)}/${pad(instant.getDate())}/${instant.getFullYear()} ${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}`;
      assert.equal(body, expected, 'Collection XML Added must agree with its real persisted local DateCreated.');
      return clock(row.DateCreated, logical, 'DateCreated', phase);
    }, framerate(body) {
      const streams = observations.find(value => value.phase === phase).snapshot.sql.MediaStreamInfos
        .filter(stream => key(stream.ItemId) === key(row.Id) && Number(stream.StreamType) === 1);
      assert.equal(streams.length, 1, 'This original input has one video stream.');
      const stream = streams[0];
      const rate = stream.AverageFrameRate != null && Number(stream.AverageFrameRate) < 1000 ? stream.AverageFrameRate : stream.RealFrameRate;
      assert.ok(rate != null);
      // The publisher exposes a binary32 rate. Both NFO readers skip this
      // field; retain its value without imposing one decimal spelling.
      body = Math.fround(Number(body));
      assert.equal(body, Math.fround(Number(rate)), 'NFO framerate must retain its actual persisted video rate.');
      return body;
    } });
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
