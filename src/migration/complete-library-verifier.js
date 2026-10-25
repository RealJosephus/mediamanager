import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { validateMediaAccessPlan, verifyNativeMediaAccess } from './media-access.js';

const declaredGuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const observedGuid = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;
const taskStates = new Set(['Idle', 'Running', 'Cancelling']);
const taskStatuses = new Set(['Completed', 'Failed', 'Cancelled', 'Aborted']);
const jsonLimits = Object.freeze({ tasks: 4 * 1024 * 1024, virtualFolders: 8 * 1024 * 1024 });

export class CompleteLibraryVerificationError extends Error {
  constructor(code, message, evidence) {
    super(message);
    this.name = 'CompleteLibraryVerificationError';
    this.code = code;
    if (evidence !== undefined) this.evidence = evidence;
  }
}

const fail = (code, message, evidence) => { throw new CompleteLibraryVerificationError(code, message, evidence); };
const exactKeys = (value, allowed, description) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) {
    fail('invalid-declaration', `${description} has unknown or missing fields`);
  }
};
const normalizeGuid = value => observedGuid.test(value ?? '') ? value.replaceAll('-', '').toLowerCase() : undefined;
const pathApi = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? path.win32 : path.posix;
const identityPath = (value, description) => {
  const api = typeof value === 'string' ? pathApi(value) : path.posix;
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || /(^|[\\/])\.\.?([\\/]|$)/u.test(value)
    || !api.isAbsolute(value) || value.includes('://') || /^\/(?:[\\/])/u.test(value)
    || api === path.win32 && !/^[A-Za-z]:[\\/]|^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)) {
    fail('invalid-declaration', `${description} must be an absolute filesystem path without traversal`);
  }
  return value;
};
const identityPathKey = value => {
  const api = pathApi(value); let normalized = api.normalize(value);
  if (normalized.length > api.parse(normalized).root.length) normalized = normalized.replace(/[\\/]+$/u, '');
  return api === path.win32 ? ordinalIgnoreCaseKey(normalized) : normalized;
};
const comparableSet = (values, key = value => value) => [...new Set(values.map(key))].sort();
const sameSet = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function originAndToken(baseUrl, accessToken) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new TypeError('An explicit Jellyfin HTTP origin is required');
  }
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n"]/u.test(accessToken)) throw new TypeError('A Jellyfin access token is required');
  return { base, accessToken };
}

function positiveInteger(value, description, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${description} must be a positive safe integer`);
  return value;
}

async function boundedJson(response, maximumBytes, signal) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength != null && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || BigInt(declaredLength) > BigInt(maximumBytes))) {
    await response.body?.cancel().catch(() => {});
    fail('invalid-response', 'Native JSON response exceeds its verification limit');
  }
  const chunks = []; let length = 0;
  try {
    for await (const chunk of response.body ?? []) {
      signal?.throwIfAborted();
      length += chunk.length;
      if (length > maximumBytes) fail('invalid-response', 'Native JSON response exceeds its verification limit');
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { fail('invalid-response', 'Native endpoint returned invalid JSON'); }
}

function nativeClient({ baseUrl, accessToken, signal, requestTimeoutMs }) {
  const { base } = originAndToken(baseUrl, accessToken);
  positiveInteger(requestTimeoutMs, 'Request timeout');
  const requests = [];
  const request = async (route, { method = 'GET', maximumBytes } = {}) => {
    signal?.throwIfAborted();
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs);
    const response = await fetch(new URL(route, base), {
      method,
      headers: { Authorization: `MediaBrowser Token="${accessToken}"` },
      redirect: 'error',
      signal: requestSignal,
    });
    requests.push({ method, route, status: response.status });
    if (maximumBytes == null) return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail('native-http', `${method} ${route} returned ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      await response.body?.cancel().catch(() => {});
      fail('invalid-response', `${method} ${route} did not return JSON`);
    }
    return boundedJson(response, maximumBytes, signal);
  };
  return { base, requests, request };
}

function taskReceiptToken(result) {
  if (result == null) return null;
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('invalid-response', 'RefreshLibrary has an invalid prior task result');
  return JSON.stringify([result.Id, result.Key, result.StartTimeUtc, result.EndTimeUtc, result.Status]);
}

function validateTask(task, expectedId) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.Id !== 'string' || !task.Id
    || task.Key !== 'RefreshLibrary' || !taskStates.has(task.State) || expectedId != null && task.Id !== expectedId) {
    fail('invalid-response', 'RefreshLibrary task identity or state is invalid');
  }
  return task;
}

function completedReceipt(task, previousToken, acceptedAt) {
  const result = task.LastExecutionResult;
  const token = taskReceiptToken(result);
  if (token === previousToken) return undefined;
  if (!result || result.Id !== task.Id || result.Key !== 'RefreshLibrary' || !taskStatuses.has(result.Status)) {
    fail('invalid-response', 'RefreshLibrary returned an unknown completion receipt');
  }
  const started = Date.parse(result.StartTimeUtc), ended = Date.parse(result.EndTimeUtc);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) fail('invalid-response', 'RefreshLibrary returned invalid completion times');
  // HTTP Date has one-second precision. Bind the receipt to this POST using the
  // server's clock, allowing only that truncation interval.
  if (started < acceptedAt - 1000 || ended < acceptedAt - 1000) {
    fail('scan-not-completed', 'RefreshLibrary returned a completion receipt older than this verification request');
  }
  if (result.Status !== 'Completed') fail('scan-not-completed', `RefreshLibrary finished with ${result.Status}`, { taskId: task.Id, result });
  return {
    completed: true,
    taskId: task.Id,
    key: result.Key,
    status: result.Status,
    startTimeUtc: new Date(started).toISOString(),
    endTimeUtc: new Date(ended).toISOString(),
  };
}

/** Run the actual native RefreshLibrary scheduled task and require a new successful completion receipt. */
export async function runNativeCompleteLibraryScan({
  baseUrl,
  accessToken,
  signal,
  requestTimeoutMs = 30000,
  scanTimeoutMs = 30 * 60 * 1000,
  pollIntervalMs = 250,
} = {}) {
  positiveInteger(scanTimeoutMs, 'Scan timeout');
  positiveInteger(pollIntervalMs, 'Scan polling interval', scanTimeoutMs);
  const client = nativeClient({ baseUrl, accessToken, signal, requestTimeoutMs });
  const tasks = await client.request('/ScheduledTasks', { maximumBytes: jsonLimits.tasks });
  if (!Array.isArray(tasks)) fail('invalid-response', 'ScheduledTasks response is not an array');
  const matching = tasks.filter(task => task?.Key === 'RefreshLibrary');
  if (matching.length !== 1) fail('scan-task-ambiguous', `Expected exactly one RefreshLibrary task, found ${matching.length}`);
  const initial = validateTask(matching[0]);
  if (initial.State !== 'Idle') fail('scan-task-busy', `RefreshLibrary was ${initial.State} before verification`);
  const previousToken = taskReceiptToken(initial.LastExecutionResult);
  const start = await client.request(`/ScheduledTasks/Running/${encodeURIComponent(initial.Id)}`, { method: 'POST' });
  if (start.status !== 204) {
    await start.body?.cancel().catch(() => {});
    fail('native-http', `Starting RefreshLibrary returned ${start.status}`);
  }
  const acceptedAt = Date.parse(start.headers.get('date') ?? '');
  if (!Number.isFinite(acceptedAt)) {
    await start.body?.cancel().catch(() => {});
    fail('invalid-response', 'Starting RefreshLibrary did not return a valid server Date');
  }
  await start.body?.cancel().catch(() => {});
  const deadline = Date.now() + scanTimeoutMs;
  let observedRunning = false;
  for (;;) {
    signal?.throwIfAborted();
    const current = validateTask(await client.request(`/ScheduledTasks/${encodeURIComponent(initial.Id)}`, { maximumBytes: jsonLimits.tasks }), initial.Id);
    if (current.State === 'Cancelling') fail('scan-not-completed', 'RefreshLibrary entered Cancelling state');
    observedRunning ||= current.State === 'Running';
    if (current.State === 'Idle') {
      const receipt = completedReceipt(current, previousToken, acceptedAt);
      if (receipt) {
        if (!observedRunning) fail('scan-not-completed', 'RefreshLibrary completion was not preceded by an observed Running state');
        return { ...receipt, observedRunning, requests: client.requests };
      }
    }
    if (Date.now() >= deadline) fail('scan-timeout', 'RefreshLibrary did not produce a new completion receipt before the timeout');
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

/** Validate the immutable declaration against the database without contacting Jellyfin. */
export async function validateCompleteLibraryDeclaration(declaration, database) {
  declaration = structuredClone(declaration);
  exactKeys(declaration, ['scope', 'libraries', 'items'], 'complete library declaration');
  if (declaration.scope !== 'complete-library'
    || !Array.isArray(declaration.libraries) || declaration.libraries.length === 0
    || !Array.isArray(declaration.items) || declaration.items.length === 0) {
    fail('invalid-declaration', 'Complete-library scope requires non-empty libraries and items');
  }
  const accessPlan = { scope: 'explicit-items', items: declaration.items };
  let accessDeclaration;
  try { accessDeclaration = await validateMediaAccessPlan(accessPlan, database); }
  catch (error) {
    if (error instanceof CompleteLibraryVerificationError) throw error;
    fail('invalid-declaration', `media access declaration is invalid: ${error.message}`);
  }
  const declaredItems = new Map(declaration.items.map(item => [normalizeGuid(item.itemId), item]));
  const assigned = new Set(), libraryIds = new Set();
  const libraries = declaration.libraries.map(library => {
    exactKeys(library, ['itemId', 'name', 'collectionType', 'locations', 'itemIds'], 'library declaration');
    const itemId = normalizeGuid(library.itemId);
    if (!declaredGuid.test(library.itemId ?? '') || libraryIds.has(itemId)) fail('invalid-declaration', 'library item IDs must be unique canonical GUIDs');
    libraryIds.add(itemId);
    if (typeof library.name !== 'string' || !library.name || /[\0\r\n]/u.test(library.name)
      || library.collectionType !== null && (typeof library.collectionType !== 'string' || !library.collectionType || /[\0\r\n]/u.test(library.collectionType))
      || !Array.isArray(library.locations) || library.locations.length === 0 || !Array.isArray(library.itemIds)) {
      fail('invalid-declaration', 'library name, collection type, locations or item IDs are invalid');
    }
    const locations = library.locations.map((location, index) => identityPath(location, `library location ${index}`));
    const locationKeys = comparableSet(locations, identityPathKey);
    if (locationKeys.length !== locations.length) fail('invalid-declaration', 'library locations must be unique');
    const itemIds = library.itemIds.map(value => {
      const normalized = normalizeGuid(value);
      if (!declaredGuid.test(value ?? '') || !declaredItems.has(normalized)) fail('invalid-declaration', 'library item IDs must reference declared media items');
      assigned.add(normalized);
      const item = declaredItems.get(normalized);
      if (!locationKeys.includes(identityPathKey(item.identityRoot))) fail('invalid-declaration', 'declared media identity root is not a location of its assigned library');
      return normalized;
    });
    if (new Set(itemIds).size !== itemIds.length) fail('invalid-declaration', 'library item IDs must be unique within each library');
    return { itemId, name: library.name, collectionType: library.collectionType, locations, locationKeys, itemIds };
  });
  if (assigned.size !== declaredItems.size) fail('invalid-declaration', 'every declared media item must be assigned to at least one library');
  return {
    declarationValid: true,
    scope: declaration.scope,
    libraryCount: libraries.length,
    itemCount: declaredItems.size,
    libraries,
    declaredItems,
    accessPlan,
    accessDeclaration,
  };
}

function observedVirtualFolder(folder) {
  const itemId = normalizeGuid(folder?.ItemId);
  if (!itemId || typeof folder.Name !== 'string' || !folder.Name || /[\0\r\n]/u.test(folder.Name)
    || folder.CollectionType !== null && typeof folder.CollectionType !== 'string'
    || !Array.isArray(folder.Locations) || folder.Locations.length === 0) {
    fail('invalid-response', 'Native virtual folder response contains an unknown entry');
  }
  const locations = folder.Locations.map((location, index) => identityPath(location, `native virtual folder location ${index}`));
  const locationKeys = comparableSet(locations, identityPathKey);
  if (locationKeys.length !== locations.length) fail('invalid-response', 'Native virtual folder contains duplicate locations');
  return { itemId, name: folder.Name, collectionType: folder.CollectionType, locations, locationKeys };
}

async function verifyNativeInventory(validated, client, { pageSize, signal }) {
  const virtualFolders = await client.request('/Library/VirtualFolders', { maximumBytes: jsonLimits.virtualFolders });
  if (!Array.isArray(virtualFolders)) fail('invalid-response', 'Library/VirtualFolders response is not an array');
  const observedFolders = virtualFolders.map(observedVirtualFolder);
  if (new Set(observedFolders.map(folder => folder.itemId)).size !== observedFolders.length) fail('invalid-response', 'Native virtual folders contain duplicate item IDs');
  const declaredLibraryIds = comparableSet(validated.libraries.map(library => library.itemId));
  const observedLibraryIds = comparableSet(observedFolders.map(folder => folder.itemId));
  if (!sameSet(declaredLibraryIds, observedLibraryIds)) {
    fail('library-inventory-mismatch', 'Declared and native virtual library IDs differ', { declaredLibraryIds, observedLibraryIds });
  }
  for (const library of validated.libraries) {
    const observed = observedFolders.find(folder => folder.itemId === library.itemId);
    if (observed.name !== library.name || observed.collectionType !== library.collectionType || !sameSet(library.locationKeys, observed.locationKeys)) {
      fail('library-inventory-mismatch', `Native virtual library differs from declaration: ${library.itemId}`, { declared: library, observed });
    }
  }
  const reports = [];
  for (const library of validated.libraries) {
    const expectedIds = comparableSet(library.itemIds);
    const seenIds = new Set(), seenPaths = new Set(), observedItems = [];
    let startIndex = 0, total;
    do {
      signal?.throwIfAborted();
      const query = new URLSearchParams({
        ParentId: library.itemId,
        Recursive: 'true',
        Filters: 'IsNotFolder',
        CollapseBoxSetItems: 'false',
        Fields: 'Path',
        EnableImages: 'false',
        EnableUserData: 'false',
        EnableTotalRecordCount: 'true',
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        StartIndex: String(startIndex),
        Limit: String(pageSize),
      });
      const maximumBytes = Math.min(64 * 1024 * 1024, 1024 * 1024 + pageSize * 256 * 1024);
      const page = await client.request(`/Items?${query}`, { maximumBytes });
      if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.Items)
        || !Number.isSafeInteger(page.TotalRecordCount) || page.TotalRecordCount < 0
        || !Number.isSafeInteger(page.StartIndex) || page.StartIndex !== startIndex || page.Items.length > pageSize) {
        fail('invalid-response', 'Native item enumeration returned an invalid page');
      }
      if (total == null) total = page.TotalRecordCount;
      else if (total !== page.TotalRecordCount) fail('inventory-changed', 'Native item count changed during enumeration');
      if (page.Items.length === 0 && startIndex < total) fail('invalid-response', 'Native item enumeration ended before its declared total');
      for (const item of page.Items) {
        const itemId = normalizeGuid(item?.Id);
        if (!itemId || typeof item.Path !== 'string' || item.IsFolder !== false || !['Audio', 'Video'].includes(item.MediaType)
          || item.LocationType !== 'FileSystem') fail('invalid-response', 'Native item enumeration contains an unknown or non-filesystem item');
        if (seenIds.has(itemId)) fail('duplicate-native-item', `Native item enumeration repeated ${itemId}`);
        const itemPathKey = identityPathKey(identityPath(item.Path, 'native item path'));
        if (seenPaths.has(itemPathKey)) fail('duplicate-native-item', `Native item enumeration repeated path ${item.Path}`);
        seenIds.add(itemId); seenPaths.add(itemPathKey);
        const declaration = validated.declaredItems.get(itemId);
        if (!declaration || !library.itemIds.includes(itemId) || declaration.identityPath !== item.Path) {
          fail('library-item-mismatch', `Native item is extra or differs from its declaration: ${itemId}`, { libraryId: library.itemId, item });
        }
        observedItems.push({ itemId, identityPath: item.Path, mediaType: item.MediaType });
      }
      startIndex += page.Items.length;
    } while (startIndex < total);
    const observedIds = comparableSet(observedItems.map(item => item.itemId));
    if (startIndex !== total || !sameSet(expectedIds, observedIds)) {
      fail('library-item-mismatch', `Declared and native items differ for library ${library.itemId}`, {
        libraryId: library.itemId,
        declaredItemIds: expectedIds,
        observedItemIds: observedIds,
        nativeTotal: total,
      });
    }
    reports.push({ itemId: library.itemId, name: library.name, itemCount: observedItems.length, items: observedItems });
  }
  return { exact: true, virtualLibraryCount: observedFolders.length, itemCount: validated.declaredItems.size, libraries: reports, requests: client.requests };
}

/**
 * Verify three independent facts: a successful native full scan, an exact declared/native inventory,
 * and per-item playback/byte access. This intentionally does not promote release acceptance.
 */
export async function verifyNativeCompleteLibrary(declaration, {
  database,
  baseUrl,
  accessToken,
  signal,
  requestTimeoutMs = 30000,
  scanTimeoutMs = 30 * 60 * 1000,
  pollIntervalMs = 250,
  pageSize = 100,
} = {}) {
  positiveInteger(pageSize, 'Inventory page size', 1000);
  const validated = await validateCompleteLibraryDeclaration(declaration, database);
  const scan = await runNativeCompleteLibraryScan({ baseUrl, accessToken, signal, requestTimeoutMs, scanTimeoutMs, pollIntervalMs });
  const client = nativeClient({ baseUrl, accessToken, signal, requestTimeoutMs });
  const inventory = await verifyNativeInventory(validated, client, { pageSize, signal });
  const access = await verifyNativeMediaAccess(validated.accessPlan, { database, baseUrl, accessToken, signal, timeoutMs: requestTimeoutMs });
  if (!access.declaredItemsVerified || access.items.length !== validated.itemCount || access.items.some(item => !item.verified)) {
    fail('item-access-failed', 'At least one declared native media item was not enumerable, playable, or byte-exact', { scan, inventory, access });
  }
  return {
    checkedAt: new Date().toISOString(),
    origin: client.base.origin,
    declaration: {
      scope: validated.scope,
      libraryCount: validated.libraryCount,
      itemCount: validated.itemCount,
    },
    scan,
    inventory,
    access,
    checks: { scanCompleted: true, libraryInventoryExact: true, declaredItemsPlayable: true },
    acceptancePromotionRequired: true,
  };
}
