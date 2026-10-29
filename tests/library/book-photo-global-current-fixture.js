import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeModel } from '../../src/database/model.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const fixture = new URL('./fixtures/book-photo-global/', import.meta.url);
const inputFile = new URL('current/input.json', fixture);
const inputBytes = await readFile(inputFile);
export const matrix = JSON.parse(inputBytes);
export const assetUrls = new Map(matrix.assets.map(asset => [asset.id,
  new URL('current/assets/' + path.posix.basename(asset.filename.replaceAll('\\', '/')), fixture)]));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const slash = value => value?.replaceAll('\\', '/');
export const json = value => JSON.stringify(value,
  (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';

// All original public/persisted subject fields remain. Image bytes are also
// compared directly. Generated IDs and isolated root names are path roles;
// timestamps, internal queues/trace/cache and exception types stay diagnostic.
export function nativeSubjects(sample, snapshot) {
  const root = slash(sample.root), media = root + '/media', rows = snapshot.sql.BaseItems;
  const normalize = value => typeof value !== 'string' ? null : slash(value).replace(media, '$MEDIA').replace(root + '/program', '$PROGRAM');
  const ids = new Map(rows.map(row => [row.Id.toLowerCase(), slash(row.Path) ?? '$NONPATH:' + row.Type + ':' + row.Name]));
  return rows.filter(row => slash(row.Path)?.startsWith(media + '/')).map(row => {
    const cold = snapshot.cold.find(value => value.Id.toLowerCase() === row.Id.toLowerCase());
    assert.ok(cold, 'Actual repository must read persisted subject ' + row.Path);
    assert.equal(cold.Name, row.Name, row.Path);
    return { path: normalize(row.Path), type: row.Type, name: row.Name, isFolder: !!row.IsFolder, mediaType: row.MediaType,
      parent: normalize(ids.get(String(row.ParentId).toLowerCase())), seriesName: row.SeriesName, index: row.IndexNumber,
      overview: row.Overview, genres: row.Genres ?? '', width: row.Width ?? 0, height: row.Height ?? 0,
      images: cold.imagePaths.map(image => ({ kind: image.Type, extension: path.extname(image.Path),
        location: slash(image.Path).startsWith(media + '/') ? 'local' : 'internal', width: image.Width,
        height: image.Height, blurHash: image.BlurHash, sha256: image.sha256, base64: image.base64 })),
      ancestors: snapshot.sql.AncestorIds.filter(value => value.ItemId.toLowerCase() === row.Id.toLowerCase())
        .map(value => normalize(ids.get(value.ParentItemId.toLowerCase()))).sort() };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export const projectNative = native => native.results.map(sample => ({ name: sample.Name,
  steps: sample.observations.slice(1).map(observation => ({ name: observation.phase, succeeded: observation.succeeded,
    before: nativeSubjects(sample, observation.beforeScan), items: nativeSubjects(sample, observation.snapshot) })) }));

function auditSnapshot(snapshot) {
  for (const table of nativeModel.tables) {
    assert.ok(Array.isArray(snapshot.sql[table.name]), 'Full Native SQL table ' + table.name);
    for (const row of snapshot.sql[table.name]) for (const column of table.columns) {
      assert.ok(Object.hasOwn(row, column.name), table.name + '.' + column.name);
    }
  }
  for (const item of snapshot.cold) for (const image of item.imagePaths) {
    if (image.base64 === null) { assert.equal(image.sha256, null); continue; }
    assert.equal(digest(Buffer.from(image.base64, 'base64')), image.sha256, image.Path);
  }
  for (const file of snapshot.files.filter(entry => entry.base64 !== null)) {
    const bytes = Buffer.from(file.base64, 'base64');
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(digest(bytes), file.sha256, file.path);
  }
}

let pending;
export const currentBookPhoto = () => pending ??= capture();
async function capture() {
  const profile = JSON.parse(await readFile(new URL('current-profile.json', fixture), 'utf8'));
  const output = path.join(validationOutputRoot(), 'book-photo-global-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: digest(inputBytes), inputs: [], sourceBindings: [], captures: [],
    photoReplacementTiming: profile.photoReplacementTiming,
    nativeExecutionRecorded: false, independentRepeatMatched: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, fixture)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relativePath); assert.ok(expected, relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, expected.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    const captures = [], projections = [];
    for (const label of ['first', 'repeat']) {
      const nativeRoot = path.join(output, label);
      const receipt = { label, assemblies: [], nativeLibraries: [], releasedCases: [] }; report.captures.push(receipt);
      receipt.record = await recordOracle({ project: fileURLToPath(new URL('current/Oracle.csproj', fixture)), output: nativeRoot,
        args: [fileURLToPath(inputFile), fileURLToPath(new URL('current/assets', fixture)), '{output}/cases', '{output}/native.json'] });
      const filename = path.join(nativeRoot, 'native.json'), bytes = await readFile(filename), native = parseLosslessJson(bytes.toString('utf8'));
      receipt.observation = await describeFile(filename);
      assert.equal(receipt.record.passed, true); assert.equal(receipt.record.build.status, 0); assert.equal(receipt.record.process.status, 0);
      assert.equal(receipt.record.outputs.find(entry => entry.filename === filename)?.sha256, digest(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, digest(inputBytes));
      assert.equal(native.assemblies.find(entry => entry.name === 'Oracle')?.sha256, receipt.record.oracleAssembly.sha256);
      for (const assembly of native.assemblies) {
        const supplied = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        if (/^(?:Emby\.|Jellyfin\.|MediaBrowser\.|jellyfin$)/u.test(assembly.name)) assert.equal(supplied.available, true, assembly.name);
        if (supplied.available) {
          assert.equal(supplied.sha256, assembly.sha256, assembly.name); receipt.assemblies.push({ loaded: assembly, supplied });
        }
      }
      assert.ok(receipt.assemblies.some(entry => entry.loaded.name === 'jellyfin'));
      for (const library of native.nativeLibraries) {
        const supplied = await describeFile(path.join(build.runtime, 'runtimes', library.runtimeIdentifier, 'native', library.name));
        assert.equal(supplied.available, true); assert.equal(supplied.sha256, library.sha256); assert.equal(library.resolverObserved, true);
        receipt.nativeLibraries.push({ loaded: library, supplied });
      }
      assert.deepEqual(native.assetBindings.map(entry => ({ id: entry.Id, bytes: entry.bytes, sha256: entry.sha256 })),
        matrix.assets.map(entry => ({ id: entry.id, bytes: entry.bytes, sha256: entry.sha256 })));
      assert.deepEqual(native.results.map(entry => entry.Name), matrix.cases.map(entry => entry.name));
      for (const sample of native.results) {
        assert.equal(path.dirname(sample.root), path.join(nativeRoot, 'cases'));
        const requested = matrix.cases.find(entry => entry.name === sample.Name);
        assert.deepEqual(sample.observations.slice(1).map(entry => entry.phase), requested.steps.map(entry => entry.name));
        const releaseFile = path.join(sample.root, 'release.json');
        assert.equal(JSON.parse(await readFile(releaseFile, 'utf8')).completed, true);
        receipt.releasedCases.push(await describeFile(releaseFile));
        auditSnapshot(sample.observations[0].snapshot);
        for (const observation of sample.observations.slice(1)) {
          auditSnapshot(observation.beforeScan); auditSnapshot(observation.snapshot);
          for (const mutation of observation.mutations) if (mutation.photoReplacementTiming) {
            const timing = mutation.photoReplacementTiming;
            assert.ok(Date.parse(mutation.lastWriteTimeUtc) - Date.parse(timing.previousModified) > 1000,
              'Actual Native photo replacement crosses the public one-second change window.');
            assert.ok(Date.parse(timing.waitEndedAt) >= Date.parse(timing.notBefore));
          }
          assert.equal(observation.succeeded, observation.error === null && observation.scan?.Exception === null);
          assert.ok(Date.parse(observation.scanStartedAt) >= Date.parse(observation.startedAt));
          assert.ok(Date.parse(observation.scanEndedAt) >= Date.parse(observation.scanStartedAt));
        }
      }
      captures.push(native); projections.push(projectNative(native));
      await writeFile(path.join(output, label + '-projection.json'), json(projections.at(-1)), { flag: 'wx' });
    }
    report.nativeExecutionRecorded = true;
    // Real mtimes remain evidence. A differing functional result is a failure;
    // neither recording becomes a fabricated expected result for the other.
    try { assert.deepEqual(projections[1], projections[0]); report.independentRepeatMatched = true; }
    catch (error) { report.independentRepeatDifference = { message: error.message, stack: error.stack }; }
    await mkdir(path.join(output, 'candidate'));
    // The contract test fails on a differing repeat; still collect every formal
    // PG scan so a timing difference cannot hide the candidate's failure prefix.
    return { native: captures[0], cases: projections[0], repeatCases: projections[1], output, report };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function recordCandidate(name, observation) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
  const { output } = await currentBookPhoto();
  await writeFile(path.join(output, 'candidate', name + '.json'), json(observation), { flag: 'wx' });
}

export async function allTables(database) {
  return Object.fromEntries(await Promise.all(nativeModel.tables.map(async table => [table.name,
    await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })])));
}

export async function fileEvidence(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) continue;
    assert.equal(entry.isFile(), true, 'Only isolated regular files: ' + entry.name);
    const filename = path.join(entry.parentPath, entry.name), bytes = await readFile(filename), information = await stat(filename);
    files.push({ path: path.relative(root, filename).split(path.sep).join('/'), bytes: bytes.length, sha256: digest(bytes),
      base64: bytes.toString('base64'), modified: information.mtime.toISOString(), created: information.birthtime.toISOString() });
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** Bounded cost observations only; no result, query or timing acceptance gate. */
export function createBookPhotoCostObserver(fixtureName) {
  const root = process.env.MEDIAMANAGER_TEST_DIAGNOSTICS_ROOT;
  const enabled = path.isAbsolute(root ?? '');
  const context = new AsyncLocalStorage(), phases = new Map(), restorers = new Set();
  const tables = new Set([...nativeModel.tables.map(table => table.name), 'sets', 'rows', 'pins']);
  const comments = new Set(['item-ancestors', 'folder-scan-path-owners', 'playlist-library-roots',
    'identity-selectors', 'navigation-root-ids', 'page-relationship-graph', 'dto-artists-by-name', 'artist-selectors']);
  const verbs = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK']);
  let dirty = false, publishing = false, writes = Promise.resolve(), completed = false;
  function phaseStatistics(phase) {
    if (!/^[a-z][a-z0-9.-]{0,79}$/u.test(phase) || (!phases.has(phase) && phases.size >= 63)) phase = 'other';
    if (!phases.has(phase)) phases.set(phase, { phase, calls: 0, wallMs: 0, cpuUserMs: 0, cpuSystemMs: 0, driver: new Map() });
    return phases.get(phase);
  }
  function shape(args) {
    const descriptor = args[0] && typeof args[0] === 'object' ? Object.getOwnPropertyDescriptor(args[0], 'text') : null;
    const text = (typeof args[0] === 'string' ? args[0] : typeof descriptor?.value === 'string' ? descriptor.value : '').slice(0, 2048);
    const comment = /^\s*\/\*\s*([a-z0-9-]+)\s*\*\//u.exec(text);
    if (comment && comments.has(comment[1])) return 'comment/' + comment[1];
    const verb = text.replace(/^\s*\/\*[\s\S]*?\*\//u, '').trimStart().match(/^[A-Za-z]+/u)?.[0].toUpperCase();
    if (!verbs.has(verb)) return 'other';
    const table = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:"[^"]+"\.)?"([A-Za-z_][A-Za-z0-9_]*)"/iu.exec(text)?.[1];
    return verb + '/' + (tables.has(table) ? table : 'other');
  }
  function checkpoint() {
    if (!enabled) return;
    dirty = true;
    if (publishing) return;
    publishing = true;
    writes = (async () => {
      try {
        const filename = path.join(root, 'book-photo-cost-' + path.basename(fixtureName, '.js') + '-' + process.pid + '.json');
        assertValidationOutputChild(filename); await mkdir(root, { recursive: true });
        while (dirty) {
          dirty = false;
          const summary = { schemaVersion: 1, diagnosticOnly: true, fixture: fixtureName, observerClosed: completed,
            scope: 'Existing Node phases only. CPU and wall deltas are inclusive and include concurrent work in this process; nested/overlapping phases cannot be added. Driver elapsed time includes client roundtrip/continuation, can overlap CPU and other queries, and is not PostgreSQL server CPU or pool-acquisition time.',
            coverage: 'Pool observation is best effort. Main attachment is attempted after database creation, before runtime setup; the internally created relation pool is attempted after runtime setup. Earlier/checked-out/unscoped queries and replacement owners are unobserved; later observers may bypass a wrapper. Missing observations never prove zero work. Non-Promise queries without an explicit callback count dispatch only. No SQL, parameters, result values, error bodies or per-query journal are retained.',
            bounds: { phases: 64, driverBucketsPerPhase: 32, classifiedSqlPrefixCharacters: 2048 },
            phases: [...phases.values()].map(({ driver, ...value }) => {
              const buckets = [...driver.values()];
              return { ...value, driver: { count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
                completedCount: buckets.reduce((sum, bucket) => sum + bucket.completedCount, 0),
                totalMs: buckets.reduce((sum, bucket) => sum + bucket.totalMs, 0),
                maximumMs: Math.max(0, ...buckets.map(bucket => bucket.maximumMs)), buckets } };
            }) };
          await writeFile(filename + '.pending', JSON.stringify(summary, null, 2) + '\n');
          await rename(filename + '.pending', filename);
        }
      } catch { /* Missing cost evidence cannot replace any business result. */ }
      finally { publishing = false; }
    })();
    void writes.catch(() => {});
  }
  function observe(phase, operation) {
    if (!enabled) return operation();
    let current;
    try {
      current = { statistics: phaseStatistics(phase), parent: context.getStore(), active: true,
        started: performance.now(), cpu: process.cpuUsage() };
      current.statistics.calls++;
    } catch { return operation(); }
    const finish = () => {
      try {
        if (!current.active) return;
        current.active = false;
        const cpu = process.cpuUsage(current.cpu), statistics = current.statistics;
        statistics.wallMs += performance.now() - current.started;
        statistics.cpuUserMs += cpu.user / 1000; statistics.cpuSystemMs += cpu.system / 1000;
        if (['setup.runtime', 'step.scan', 'close.database'].includes(phase)) checkpoint();
      } catch { /* Preserve the actual operation and raw rejection. */ }
    };
    let invoked = false;
    try {
      return context.run(current, () => {
        invoked = true;
        let result;
        try { result = operation(); } catch (error) { finish(); throw error; }
        try {
          if (result instanceof Promise) return Promise.prototype.then.call(result,
            value => { finish(); return value; }, error => { finish(); throw error; });
          finish();
        } catch { finish(); }
        return result;
      });
    } catch (error) { if (invoked) throw error; return operation(); }
  }
  function observePool(database, owner) {
    if (!enabled || !['main', 'relation'].includes(owner)) return () => {};
    let pool;
    try { pool = database?.pool; } catch { return () => {}; }
    const clients = new Map();
    let active = true;
    const acquire = client => {
      try {
        if (!active || clients.has(client)) return;
        const original = client.query;
        if (typeof original !== 'function') return;
        function query(...args) {
          if (!active) return Reflect.apply(original, this, args);
          const observations = [], seen = new Set();
          let started;
          try {
            const category = owner + '/' + shape(args);
            for (let value = context.getStore(); value; value = value.parent) {
              if (!value.active || seen.has(value.statistics)) continue;
              seen.add(value.statistics);
              const buckets = value.statistics.driver;
              const key = buckets.has(category) || buckets.size < 31 ? category : 'other';
              if (!buckets.has(key)) buckets.set(key, { bucket: key, count: 0, completedCount: 0, totalMs: 0, maximumMs: 0 });
              const bucket = buckets.get(key); bucket.count++; observations.push(bucket);
            }
            started = performance.now();
          } catch { /* The original driver call still runs unchanged. */ }
          if (!observations.length) return Reflect.apply(original, this, args);
          let finished = false;
          const finish = () => {
            try {
              if (finished) return;
              finished = true;
              const elapsed = performance.now() - started;
              for (const bucket of observations) {
                bucket.completedCount++; bucket.totalMs += elapsed; bucket.maximumMs = Math.max(bucket.maximumMs, elapsed);
              }
            } catch { /* Timing never changes callback arguments or query results. */ }
          };
          const forwarded = [...args], callback = forwarded.at(-1);
          if (typeof callback === 'function') forwarded[forwarded.length - 1] = function (...values) {
            finish(); return Reflect.apply(callback, this, values);
          };
          let result;
          try { result = Reflect.apply(original, this, forwarded); }
          catch (error) { finish(); throw error; }
          if (typeof callback !== 'function') try {
            if (result instanceof Promise) return Promise.prototype.then.call(result,
              value => { finish(); return value; }, error => { finish(); throw error; });
          } catch { /* Return the actual original value even if observation fails. */ }
          return result;
        }
        client.query = query; clients.set(client, { original, query });
      } catch { /* An unavailable observer must not prevent pool admission. */ }
    };
    const restore = () => {
      active = false;
      try { pool?.off('acquire', acquire); } catch { /* Best-effort diagnostic removal only. */ }
      for (const [client, value] of clients) try {
        if (client.query === value.query) client.query = value.original;
      } catch { /* Never replace a later observer's wrapper. */ }
      clients.clear(); restorers.delete(restore);
    };
    try { pool.on('acquire', acquire); restorers.add(restore); }
    catch { restore(); }
    return restore;
  }
  return { observe, observePool, async close() {
    try { for (const restore of [...restorers]) restore(); completed = true; checkpoint(); await writes; }
    catch { /* This is never an acceptance condition. */ }
  } };
}
