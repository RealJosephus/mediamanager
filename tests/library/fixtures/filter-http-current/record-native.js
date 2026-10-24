// A new consumer identity for same-workflow Native HTTP observations.
// Historical recorder/provenance files remain immutable and are never loaded here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../../../tools/compat/filter-reference-output.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';
import { catalog, currentFilterCases } from './scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const recorderPath = fileURLToPath(import.meta.url);
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => String(value).toUpperCase();
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256File = async filename => sha256Bytes(await readFile(filename));
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const quote = name => `"${String(name).replaceAll('"', '""')}"`;

export async function recordCurrentItemFilterNative(scenarioName, destination, profile, preferredPort = 19000) {
  const descriptor = catalog[scenarioName];
  assert.ok(descriptor, 'Declared current filter scenario is required.');
  assertValidationOutputChild(destination);
  assert.equal(existsSync(destination), false, 'Current filter output must be new.');
  assert.ok(Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535);
  const fixturePath = path.join(repoRoot, descriptor.fixture), fixtureBytes = await readFile(fixturePath);
  const originalFixture = JSON.parse(fixtureBytes);
  const privateOutput = await createPrivateFilterOutput(destination);
  let failure;
  try {
    const current = await currentNativeReference({ fixtureUserId: originalFixture.userId });
    privateOutput.addSecret(current.accessToken);
    const evidenceRoot = privateOutput.root, nativeRun = evidenceRoot;
    const sourceRoot = current.sourceRoot, sourceDatabase = current.sourceDatabase;
    const jellyfinDll = current.jellyfinDll, dotnet = current.dotnet, ffmpeg = current.ffmpeg;
    const ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/^ffmpeg/iu, 'ffprobe'));
    const referenceRoot = path.join(nativeRun, 'reference'), databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
    const sourceDatabaseDescriptor = await describeFile(sourceDatabase);
    assert.equal(sourceDatabaseDescriptor.available, true);
    const seedScenario = descriptor.seedScenario ?? scenarioName;
    const identityMapping = [{ kind: 'user', fixture: originalFixture.userId, actual: current.userId }];
    let fixture, itemByKey, itemById, valueByKey, sourceTemplates;
    const scenarioCases = currentFilterCases(descriptor, originalFixture);
    assert.equal(scenarioCases.reduce((count, entry) => count + entry.endpoints.length, 0), descriptor.expectedRecords);
    async function available(port) {
      return await new Promise(resolve => {
        const server = createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
      });
    }

    async function choosePort(start) {
      for (let port = start; port <= Math.min(65535, start + 100); port++) if (await available(port)) return port;
      throw new Error(`No free loopback port from ${start} through ${Math.min(65535, start + 100)}.`);
    }

    async function artifactEntries(names) {
      const entries = [];
      for (const name of names) {
        const filename = path.join(evidenceRoot, name);
        const info = await stat(filename);
        entries.push({ path: name.replaceAll('\\', '/'), size: info.size, sha256: await sha256File(filename) });
      }
      return entries;
    }

    async function verifyArtifactEntries(entries) {
      for (const entry of entries) {
        const filename = path.join(evidenceRoot, entry.path);
        const info = await stat(filename);
        assert.equal(info.size, entry.size, `${entry.path}: artifact size changed.`);
        assert.equal(await sha256File(filename), entry.sha256, `${entry.path}: artifact hash changed.`);
      }
      return true;
    }

    async function artifactTamperNegativeControl(entries) {
      await verifyArtifactEntries(entries);
      const tampered = entries.map((entry, index) => index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry);
      await assert.rejects(() => verifyArtifactEntries(tampered), /artifact hash changed/u);
      return { pristineManifestAccepted: true, tamperedManifestRejected: true };
    }

    async function prepareReference(port) {
      await mkdir(nativeRun, { recursive: true });
      await cp(sourceRoot, referenceRoot, { recursive: true, filter(source) {
        const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
        return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
      } });
      await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
      await cp(sourceDatabase, databasePath, { errorOnExist: true, force: false });
      await current.prepareClone(referenceRoot, port);
      const templates = new DatabaseSync(databasePath, { readOnly: true });
      try {
        sourceTemplates = {
          folderTemplate: templates.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
            .get('11111111-1111-1111-1111-111111111111'),
          movieTemplate: templates.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
            .get('22222222-2222-2222-2222-222222222222'),
        };
        const aggregate = templates.prepare('SELECT "Id" FROM "BaseItems" WHERE "Type" = ?')
          .get('MediaBrowser.Controller.Entities.AggregateFolder');
        assert.ok(sourceTemplates.folderTemplate && sourceTemplates.movieTemplate && aggregate);
        const declared = originalFixture.items.find(item => item.type === 'AggregateFolder');
        if (declared) identityMapping.push({ kind: 'aggregate', fixture: declared.id, actual: aggregate.Id });
      } finally { templates.close(); }
      const replace = value => {
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
        if (typeof value !== 'string') return value;
        for (const entry of identityMapping) {
          if (idKey(value) === idKey(entry.fixture)) return entry.actual;
          value = value.replaceAll(entry.fixture, entry.actual);
        }
        return value;
      };
      fixture = replace(originalFixture);
      itemByKey = new Map(fixture.items.map(item => [item.key, item]));
      itemById = new Map(fixture.items.map(item => [idKey(item.id), item]));
      valueByKey = new Map((fixture.itemValues ?? []).map(value => [value.key, value]));
    }

    function ancestorsFor(item) {
      if (Array.isArray(item.ancestorIds)) return [...new Set(item.ancestorIds.map(upperId))];
      const ancestors = [];
      let parentId = item.parentId;
      while (parentId) {
        ancestors.push(upperId(parentId));
        parentId = itemById.get(idKey(parentId))?.parentId ?? null;
      }
      return [...new Set(ancestors)];
    }

    function seedDatabase() {
      const database = new DatabaseSync(databasePath);
      try {
        const { folderTemplate, movieTemplate } = sourceTemplates;
        const aggregate = database.prepare(`SELECT * FROM "BaseItems"
          WHERE "Type" = 'MediaBrowser.Controller.Entities.AggregateFolder' LIMIT 1`).get();
        assert.ok(folderTemplate && movieTemplate && aggregate, 'Current controlled folder, movie, and aggregate templates are required.');
        const nativeTypes = {
          Folder: 'MediaBrowser.Controller.Entities.Folder',
          Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
          BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet',
          Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
        };
        const folderTypes = new Set(['Folder', 'BoxSet']);
        const fixedDate = '2026-09-29 12:00:00';
        const targetIds = fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => upperId(item.id));
        const valueIds = (fixture.itemValues ?? []).map(value => upperId(value.id));
        const placeholders = values => values.map(() => '?').join(',');
        database.exec('BEGIN IMMEDIATE');
        try {
          if (targetIds.length) {
            database.prepare(`DELETE FROM "AncestorIds" WHERE "ItemId" IN (${placeholders(targetIds)})`).run(...targetIds);
            database.prepare(`DELETE FROM "LinkedChildren" WHERE "ParentId" IN (${placeholders(targetIds)}) OR "ChildId" IN (${placeholders(targetIds)})`)
              .run(...targetIds, ...targetIds);
            database.prepare(`DELETE FROM "BaseItemImageInfos" WHERE "ItemId" IN (${placeholders(targetIds)})`).run(...targetIds);
            database.prepare(`DELETE FROM "ItemValuesMap" WHERE "ItemId" IN (${placeholders(targetIds)})`).run(...targetIds);
          }
          if (valueIds.length) {
            database.prepare(`DELETE FROM "ItemValuesMap" WHERE "ItemValueId" IN (${placeholders(valueIds)})`).run(...valueIds);
            database.prepare(`DELETE FROM "ItemValues" WHERE "ItemValueId" IN (${placeholders(valueIds)})`).run(...valueIds);
          }
          for (const item of fixture.items) {
            if (item.type === 'AggregateFolder') {
              assert.equal(idKey(item.id), idKey(aggregate.Id), 'Fixture aggregate must bind the native aggregate folder.');
              continue;
            }
            const isFolder = folderTypes.has(item.type);
            const isMovie = item.type === 'Movie';
            const defaultData = isMovie
              ? { VideoType: 'VideoFile', IsHD: false, IsShortcut: false, RemoteTrailers: [] }
              : {};
            const row = {
              ...(isFolder ? folderTemplate : movieTemplate),
              Id: upperId(item.id),
              Type: nativeTypes[item.type],
              ParentId: item.parentId == null ? null : upperId(item.parentId),
              TopParentId: item.topParentId == null ? null : upperId(item.topParentId),
              Name: item.name,
              CleanName: item.cleanName ?? item.name.toLowerCase(),
              SortName: item.sortName ?? item.cleanName ?? item.name.toLowerCase(),
              Path: `Z:\\ItemFilterOracle\\${seedScenario}\\${item.key}${isFolder ? '' : '.mkv'}`,
              IsFolder: isFolder ? 1 : 0,
              IsMovie: isMovie ? 1 : 0,
              IsSeries: 0,
              IsVirtualItem: item.isVirtualItem ? 1 : 0,
              MediaType: item.mediaType ?? (isMovie ? 'Video' : 'Unknown'),
              UnratedType: isMovie ? 'Movie' : 'Other',
              PrimaryVersionId: item.primaryVersionId == null ? null : upperId(item.primaryVersionId),
              OwnerId: item.ownerId == null ? null : upperId(item.ownerId),
              ExtraType: item.extraType ?? null,
              PresentationUniqueKey: item.presentationUniqueKey ?? `item-filter-${seedScenario}-${idKey(item.id)}`,
              ProductionYear: item.productionYear ?? null,
              CustomRating: item.customRating ?? null,
              OfficialRating: Object.hasOwn(item, 'officialRating') ? item.officialRating : null,
              InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null,
              InheritedParentalRatingSubValue: item.inheritedParentalRatingSubValue ?? null,
              Tags: Object.hasOwn(item, 'tagsText') ? item.tagsText : null,
              Genres: null,
              Studios: null,
              ProductionLocations: null,
              DateCreated: fixedDate,
              DateModified: fixedDate,
              DateLastSaved: item.dateLastSaved ?? fixedDate,
              Data: item.dataText ?? JSON.stringify(item.data ?? defaultData),
            };
            const columns = Object.keys(row);
            const updates = columns.filter(column => column !== 'Id')
              .map(column => `${quote(column)}=excluded.${quote(column)}`).join(',');
            database.prepare(`INSERT INTO "BaseItems" (${columns.map(quote).join(',')})
              VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT("Id") DO UPDATE SET ${updates}`)
              .run(...columns.map(column => row[column]));
            for (const ancestorId of ancestorsFor(item)) {
              database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)')
                .run(row.Id, ancestorId);
            }
          }
          for (const link of fixture.links ?? []) {
            database.prepare('INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)')
              .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
          }
          const itemValueTypes = { Genre: 2, Studio: 3, Tags: 4 };
          for (const value of fixture.itemValues ?? []) {
            database.prepare('INSERT INTO "ItemValues" ("ItemValueId", "Type", "Value", "CleanValue") VALUES (?, ?, ?, ?)')
              .run(upperId(value.id), itemValueTypes[value.type] ?? value.type, value.value,
                value.cleanValue ?? value.value.toLowerCase());
          }
          for (const link of fixture.itemValueLinks ?? []) {
            database.prepare('INSERT INTO "ItemValuesMap" ("ItemId", "ItemValueId") VALUES (?, ?)')
              .run(upperId(itemByKey.get(link.itemKey).id), upperId(valueByKey.get(link.valueKey).id));
          }
          for (const image of fixture.images ?? []) {
            database.prepare(`INSERT INTO "BaseItemImageInfos"
              ("Id", "Blurhash", "DateModified", "Height", "ImageType", "ItemId", "Path", "Width")
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(upperId(image.id), null, fixedDate, 1, image.imageType,
              upperId(itemByKey.get(image.itemKey).id), `Z:\\ItemFilterOracle\\${seedScenario}\\${image.id}.jpg`, 1);
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        database.close();
      }
    }

    function normalizeSqlValue(value) {
      if (Buffer.isBuffer(value)) return { type: 'blob', base64: value.toString('base64') };
      if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
      return value;
    }

    function canonicalRows(rows) {
      return rows.map(row => Object.fromEntries(Object.entries(row)
        .map(([key, value]) => [key, normalizeSqlValue(value)])))
        .sort((left, right) => stable(left).localeCompare(stable(right), 'en'));
    }

    function databaseSnapshot() {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      database.exec('PRAGMA busy_timeout=5000');
      try {
        const targetIds = fixture.items.map(item => upperId(item.id));
        const valueIds = (fixture.itemValues ?? []).map(value => upperId(value.id));
        const placeholders = values => values.map(() => '?').join(',');
        const selected = (sql, parameters) => database.prepare(sql).all(...parameters);
        const tableDefinitions = database.prepare(`SELECT "name", "sql" FROM "sqlite_master"
          WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`).all();
        const tableSummaries = tableDefinitions.map(definition => {
          const rows = canonicalRows(database.prepare(`SELECT * FROM ${quote(definition.name)}`).all());
          const columns = database.prepare(`PRAGMA table_info(${quote(definition.name)})`).all();
          const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quote(definition.name)})`).all();
          const indexes = database.prepare(`PRAGMA index_list(${quote(definition.name)})`).all()
            .map(index => ({ ...index,
              columns: database.prepare(`PRAGMA index_info(${quote(index.name)})`).all() }));
          return {
            name: definition.name,
            sqlSha256: sha256Bytes(Buffer.from(definition.sql ?? '')),
            columnsSha256: sha256Bytes(Buffer.from(stable(columns))),
            foreignKeysSha256: sha256Bytes(Buffer.from(stable(foreignKeys))),
            indexesSha256: sha256Bytes(Buffer.from(stable(indexes))),
            rowCount: rows.length,
            rowsSha256: sha256Bytes(Buffer.from(stable(rows))),
          };
        });
        const hasSequence = database.prepare(`SELECT COUNT(*) AS "count" FROM "sqlite_master"
          WHERE "type" = 'table' AND "name" = 'sqlite_sequence'`).get().count > 0;
        const sequences = hasSequence ? canonicalRows(database.prepare('SELECT * FROM "sqlite_sequence"').all()) : [];
        const pragmas = {
          applicationId: database.prepare('PRAGMA application_id').get().application_id,
          autoVacuum: database.prepare('PRAGMA auto_vacuum').get().auto_vacuum,
          encoding: database.prepare('PRAGMA encoding').get().encoding,
          foreignKeys: database.prepare('PRAGMA foreign_keys').get().foreign_keys,
          journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode,
          pageSize: database.prepare('PRAGMA page_size').get().page_size,
          schemaVersion: database.prepare('PRAGMA schema_version').get().schema_version,
          userVersion: database.prepare('PRAGMA user_version').get().user_version,
        };
        const foreignKeyCheck = canonicalRows(database.prepare('PRAGMA foreign_key_check').all());
        const integrityCheck = canonicalRows(database.prepare('PRAGMA integrity_check').all());
        const complete = { tableSummaries, sequences,
          sequencesSha256: sha256Bytes(Buffer.from(stable(sequences))), pragmas, foreignKeyCheck, integrityCheck };
        complete.sha256 = sha256Bytes(Buffer.from(stable(complete)));
        return {
          baseItems: selected(`SELECT "Id", "OwnerId", "PrimaryVersionId", "ExtraType", "CustomRating", "OfficialRating",
            "InheritedParentalRatingValue", "InheritedParentalRatingSubValue", "PresentationUniqueKey", "Tags", "DateLastSaved"
            FROM "BaseItems" WHERE "Id" IN (${placeholders(targetIds)}) ORDER BY "Id"`, targetIds),
          ancestorIds: selected(`SELECT "ItemId", "ParentItemId" FROM "AncestorIds"
            WHERE "ItemId" IN (${placeholders(targetIds)}) ORDER BY "ItemId", "ParentItemId"`, targetIds),
          linkedChildren: selected(`SELECT "ParentId", "SortOrder", "ChildId", "ChildType" FROM "LinkedChildren"
            WHERE "ParentId" IN (${placeholders(targetIds)}) OR "ChildId" IN (${placeholders(targetIds)})
            ORDER BY "ParentId", "SortOrder", "ChildId"`, [...targetIds, ...targetIds]),
          itemValues: valueIds.length ? selected(`SELECT "ItemValueId", "Type", "Value", "CleanValue" FROM "ItemValues"
            WHERE "ItemValueId" IN (${placeholders(valueIds)}) ORDER BY "ItemValueId"`, valueIds) : [],
          itemValuesMap: valueIds.length ? selected(`SELECT "ItemId", "ItemValueId" FROM "ItemValuesMap"
            WHERE "ItemValueId" IN (${placeholders(valueIds)}) ORDER BY "ItemId", "ItemValueId"`, valueIds) : [],
          imageInfos: selected(`SELECT "Id", "ItemId", "ImageType", "Path", "Width", "Height" FROM "BaseItemImageInfos"
            WHERE "ItemId" IN (${placeholders(targetIds)}) ORDER BY "Id"`, targetIds),
          foreignKeyCheck,
          complete,
        };
      } finally {
        database.close();
      }
    }

    function selectedDatabaseSnapshot() {
      const { complete: _complete, ...selected } = databaseSnapshot();
      return selected;
    }

    function completeDatabaseSnapshot() {
      return databaseSnapshot().complete;
    }

    function serializeDatabase() {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try { return Buffer.from(database.serialize()); }
      finally { database.close(); }
    }

    async function restoreSerializedDatabase(bytes) {
      for (const suffix of ['-wal', '-shm']) {
        const filename = databasePath + suffix;
        if (existsSync(filename)) await unlink(filename);
      }
      await writeFile(databasePath, bytes);
      assert.equal(databaseIsUnlocked(), true, 'Restored native database is still locked.');
    }

    function authorization(token) {
      return `MediaBrowser Client="CompatibilityValidation", Device="IsolatedItemFilterReference", DeviceId="item-filter-native-${scenarioName}", Version="1.0"${token ? `, Token="${token}"` : ''}`;
    }

    async function request(origin, route, { method = 'GET', token, body } = {}) {
      const response = await fetch(origin + route, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: authorization(token),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const bodyText = await response.text();
      let bodyJson;
      try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); } catch { /* Preserve the raw body. */ }
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        bodyText,
        ...(bodyJson === undefined ? {} : { bodyJson }),
      };
    }

    function expectedStatusFor(testCase, endpoint) {
      return endpoint === 'detail' ? testCase.detailExpectedStatus : testCase.expectedStatus ?? 200;
    }

    function validateResponseContract(response, { endpoint, expectedStatus, label, route = '' }) {
      assert.equal(response.status, expectedStatus,
        `${label} returned ${response.status}, expected ${expectedStatus}: ${response.bodyText.slice(0, 1000)}`);
      assert.ok(response.contentType?.startsWith('application/json'), `${label} did not return JSON.`);
      assert.ok(response.bodyJson && typeof response.bodyJson === 'object' && !Array.isArray(response.bodyJson),
        `${label} did not return a JSON object.`);
      if (response.status === 200 && endpoint !== 'detail') {
        const body = response.bodyJson;
        assert.ok(Array.isArray(body.Items), `${label} did not return an Items array.`);
        assert.ok(Number.isInteger(body.TotalRecordCount) && body.TotalRecordCount >= 0,
          `${label} returned an invalid TotalRecordCount.`);
        assert.ok(Number.isInteger(body.StartIndex) && body.StartIndex >= 0,
          `${label} returned an invalid StartIndex.`);
        const countDisabled = new URL(route || '/', 'http://127.0.0.1').searchParams
          .get('EnableTotalRecordCount')?.toLowerCase() === 'false';
        if (countDisabled) {
          assert.equal(body.TotalRecordCount, body.Items.length,
            `${label} returned an inconsistent disabled-count result.`);
        } else {
          assert.ok(body.Items.length <= body.TotalRecordCount
            && body.StartIndex <= body.TotalRecordCount
            && body.StartIndex + body.Items.length <= body.TotalRecordCount,
          `${label} returned inconsistent Items pagination counts.`);
        }
        for (const [index, item] of body.Items.entries()) {
          assert.ok(item && typeof item === 'object' && !Array.isArray(item), `${label}:Items[${index}] is not an object.`);
          assert.ok(typeof item.Id === 'string' && item.Id.length > 0, `${label}:Items[${index}] has no Id.`);
          assert.ok(typeof item.Name === 'string', `${label}:Items[${index}] has no Name.`);
          assert.ok(typeof item.Type === 'string' && item.Type.length > 0, `${label}:Items[${index}] has no Type.`);
        }
      } else if (response.status === 200) {
        assert.ok(typeof response.bodyJson.Id === 'string' && response.bodyJson.Id.length > 0,
          `${label} detail response has no Id.`);
        assert.ok(typeof response.bodyJson.Name === 'string', `${label} detail response has no Name.`);
        assert.ok(typeof response.bodyJson.Type === 'string' && response.bodyJson.Type.length > 0,
          `${label} detail response has no Type.`);
      } else {
        assert.ok(Number.isInteger(response.bodyJson.status), `${label} problem body has no integer status.`);
        assert.equal(response.bodyJson.status, response.status, `${label} problem status does not match HTTP status.`);
        assert.ok(typeof response.bodyJson.title === 'string' && response.bodyJson.title.length > 0,
          `${label} problem body has no title.`);
        assert.ok(typeof response.bodyJson.type === 'string' && response.bodyJson.type.length > 0,
          `${label} problem body has no type.`);
      }
      return true;
    }

    function responseValidationNegativeControls() {
      const valid = { status: 200, contentType: 'application/json', bodyText: '{}',
        bodyJson: { Items: [], TotalRecordCount: 0, StartIndex: 0 } };
      assert.throws(() => validateResponseContract({ ...valid, status: 500 },
        { endpoint: 'items', expectedStatus: 200, label: 'negative-control-status' }), /expected 200/u);
      assert.throws(() => validateResponseContract({ ...valid, bodyJson: { Items: {}, TotalRecordCount: 0, StartIndex: 0 } },
        { endpoint: 'items', expectedStatus: 200, label: 'negative-control-body' }), /Items array/u);
      assert.throws(() => validateResponseContract({ status: 404, contentType: 'application/json', bodyText: '{}',
        bodyJson: { status: 200, title: 'Not Found', type: 'about:blank' } },
      { endpoint: 'detail', expectedStatus: 404, label: 'negative-control-problem' }), /does not match/u);
      return { badStatusRejected: true, badBodyRejected: true, badProblemBodyRejected: true };
    }

    function routeFor(endpoint, testCase, userId) {
      if (endpoint === 'detail') return `/Items/${itemByKey.get(testCase.detailKey).id}`;
      const scopeIds = testCase.scope.map(key => itemByKey.get(key).id).join(',');
      const common = [
        `Ids=${encodeURIComponent(scopeIds)}`,
        'SortBy=SortName',
        `Fields=${encodeURIComponent(descriptor.fields)}`,
        'EnableImages=false',
        'EnableUserData=false',
        testCase.query.replaceAll(originalFixture.userId, userId),
      ];
      return `${endpoint === 'items' ? '/Items' : `/Users/${userId}/Items`}?${common.join('&')}`;
    }

    function processIsGone(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try { process.kill(pid, 0); return false; }
      catch (error) { return error?.code === 'ESRCH'; }
    }

    function databaseIsUnlocked() {
      let database;
      try {
        database = new DatabaseSync(databasePath);
        database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK');
        return true;
      } catch {
        return false;
      } finally {
        try { database?.close(); } catch { /* Already closed. */ }
      }
    }

    async function confirmStopped(instance) {
      let pidGone = false;
      let portAvailable = false;
      let databaseUnlocked = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        pidGone = processIsGone(instance.child.pid);
        portAvailable = await available(instance.port);
        databaseUnlocked = databaseIsUnlocked();
        if (pidGone && portAvailable && databaseUnlocked) {
          return { pidGone, portAvailable, databaseUnlocked, attempts: attempt + 1 };
        }
        await delay(250);
      }
      return { pidGone, portAvailable, databaseUnlocked, attempts: 60 };
    }

    async function startReference(port) {
      const run = current.start({ referenceRoot, outputRoot: nativeRun, label: 'reference', origin });
      return { ...run, port };
    }
    async function stopReference(instance, token, origin, setupRecords) {
      const result = await instance.stop(async () => {
        const response = await request(origin, '/System/Shutdown', { method: 'POST', token });
        setupRecords.push({ kind: 'shutdown', status: response.status });
        return response.status;
      }, () => available(instance.port));
      return { shutdownStatus: result.cleanShutdown ? 204 : null,
        processResult: { code: result.code, signal: result.signal }, ...await confirmStopped(instance), details: result };
    }
    const selectedPort = await available(preferredPort) ? preferredPort : await choosePort(preferredPort + 1);
    const origin = `http://127.0.0.1:${selectedPort}`;
    const negativeControls = { responseValidation: responseValidationNegativeControls() };
    const preparation = { ...current.preparation, sourceDatabase: sourceDatabaseDescriptor,
      nativeSources: await current.sourceBindings(profile.sourcePaths), recorder: await describeFile(recorderPath),
      matrix: await describeFile(fileURLToPath(new URL('./scenario.js', import.meta.url))) };
    async function executionInputs() {
      const result = [];
      for (const [kind, filename] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
        const metadata = await stat(filename);
        assert.equal(metadata.isFile(), true);
        const bytes = await readFile(filename);
        result.push({ kind, filename, bytes: bytes.length, sha256: sha256Bytes(bytes) });
      }
      return result;
    }
    const nativeLaunch = { command: null, before: await executionInputs(), after: null };
    const sourceSummary = {
      initializedFromEmpty: preparation.initializedFromEmpty,
      nativeInitializationObserved: true,
      syntheticItemsSeededOffline: true,
      sourceStopped: preparation.stopped,
      sourceDatabaseSha256: sourceDatabaseDescriptor.sha256,
      preparedInputCount: preparation.inputs.length,
      jellyfinDllSha256: await sha256File(jellyfinDll),
      dotnetSha256: await sha256File(dotnet),
    };
    await prepareReference(selectedPort);

    seedDatabase();
    await writeFile(path.join(nativeRun, 'current-profile.json'), json(preparation), { flag: 'wx' });
    await writeFile(path.join(nativeRun, 'native-input-templates.json'), json({ sourceDatabase: sourceDatabaseDescriptor, ...sourceTemplates }), { flag: 'wx' });
    await writeFile(path.join(nativeRun, 'identity-mapping.json'), json({ mapping: identityMapping, allowedKinds: ['user', 'aggregate'] }), { flag: 'wx' });

    const stages = {};
    const records = [];
    const setupRecords = [];
    const fullDatabaseReadGates = [];
    let instance;
    let token;
    let basePolicy;
    let baselineDatabaseBytes;
    let fullDatabaseBaseline;
    let fullDatabaseAfterRun;
    let fullDatabaseAfterShutdown;
    let readiness = { startupComplete: false, httpReady: false, consecutiveHttpSuccesses: 0, attempts: 0 };
    let lifecycle = { shutdownStatus: null, processResult: { code: null, signal: null },
      pidGone: false, portAvailable: false, databaseUnlocked: false, attempts: 0 };
    let outcomeError;
    try {
      instance = await startReference(selectedPort);
      nativeLaunch.command = [dotnet, ...instance.arguments];
      await instance.ready();
      readiness = { httpReady: true };
      token = current.accessToken;
      const identity = await request(origin, '/Users/Me', { token });
      assert.equal(identity.status, 200, 'The actual current Native user must authenticate.');
      const userId = identity.bodyJson.Id;
      assert.equal(idKey(userId), idKey(current.userId));
      basePolicy = identity.bodyJson.Policy;
      assert.equal(basePolicy.IsAdministrator, true);
      setupRecords.push({ kind: 'current-user-identity', response: identity });
      const configRead = await request(origin, '/System/Configuration', { token });
      assert.equal(configRead.status, 200);
      assert.deepEqual(configRead.bodyJson.PluginRepositories, []);
      const taskRead = await request(origin, '/ScheduledTasks', { token });
      assert.equal(taskRead.status, 200);
      assert.ok(taskRead.bodyJson.every(task => task.State === 'Idle' && task.Triggers?.length === 0));
      const networkRead = await request(origin, '/System/Configuration/network', { token });
      assert.equal(networkRead.status, 200);
      assert.deepEqual(networkRead.bodyJson.LocalNetworkAddresses, ['127.0.0.1']);
      assert.equal(networkRead.bodyJson.AutoDiscovery, false);
      assert.equal(networkRead.bodyJson.EnableUPnP, false);
      assert.equal(networkRead.bodyJson.EnableRemoteAccess, false);
      setupRecords.push({ kind: 'actual-isolation-readback', configuration: configRead,
        tasks: taskRead, network: networkRead });
      stages.before = { database: selectedDatabaseSnapshot() };
      baselineDatabaseBytes = serializeDatabase();
      fullDatabaseBaseline = completeDatabaseSnapshot();
      for (const testCase of scenarioCases) {
        if (['official-rating-range', 'rating-permissions', 'tag-permissions'].includes(seedScenario)) {
          const policy = {
            ...basePolicy,
            ...testCase.transcodingPolicy,
            ...(seedScenario === 'rating-permissions' ? {
              AllowedTags: [],
              BlockedTags: [],
              MaxParentalRating: testCase.maxRating,
              MaxParentalSubRating: testCase.maxRating == null ? null : 0,
              BlockUnratedItems: testCase.blockUnrated,
            } : seedScenario === 'tag-permissions' ? {
              AllowedTags: testCase.allowedTags,
              BlockedTags: testCase.blockedTags,
            } : {
              MaxParentalRating: null,
              MaxParentalSubRating: null,
              BlockUnratedItems: testCase.blockUnrated,
              AllowedTags: [],
              BlockedTags: [],
            }),
          };
          const update = await request(origin, `/Users/${userId}/Policy`, { method: 'POST', token, body: policy });
          assert.equal(update.status, 204, `${testCase.name}: native policy update failed: ${update.bodyText}`);
          setupRecords.push({ name: testCase.name, kind: 'policy',
            ...(seedScenario === 'rating-permissions' ? { maxRating: testCase.maxRating, blockUnrated: testCase.blockUnrated } : {}),
            ...(seedScenario === 'tag-permissions' ? { allowedTags: testCase.allowedTags, blockedTags: testCase.blockedTags } : {}),
            ...(seedScenario === 'official-rating-range' ? { blockUnrated: testCase.blockUnrated } : {}),
            status: update.status });
        }
        const databaseBeforeCaseReads = completeDatabaseSnapshot();
        if (descriptor.policyReadback) {
          const effectiveUser = await request(origin, `/Users/${userId}`, { token });
          assert.equal(effectiveUser.status, 200);
          for (const [key, expected] of Object.entries(testCase.transcodingPolicy))
            assert.equal(effectiveUser.bodyJson.Policy[key], expected, testCase.name + ':' + key);
          setupRecords.push({ name: testCase.name, kind: 'static-source-policy-readback', status: effectiveUser.status,
            requestedPolicy: testCase.transcodingPolicy,
            effectivePolicy: Object.fromEntries(Object.keys(testCase.transcodingPolicy)
              .map(key => [key, effectiveUser.bodyJson.Policy[key]])) });
        }
        for (const endpoint of testCase.endpoints) {
          const route = routeFor(endpoint, testCase, userId);
          const method = 'GET';
          const response = await request(origin, route, { token, method });
          const expectedStatus = expectedStatusFor(testCase, endpoint);
          validateResponseContract(response, { endpoint, expectedStatus, label: `${testCase.name}:${endpoint}`, route });
          const record = {
            name: testCase.name,
            query: testCase.query,
            endpoint,
            method,
            route,
            ...(descriptor.recordScope === 'scope' ? { scope: testCase.scope } : {}),
            ...(descriptor.recordScope === 'scopeIds' ? { scopeIds: testCase.scope.map(key => itemByKey.get(key).id) } : {}),
            ...(descriptor.recordScope === 'blockUnrated' ? { blockUnrated: testCase.blockUnrated } : {}),
            ...(descriptor.recordScope === 'ratingPolicy' ? {
              maxRating: testCase.maxRating,
              blockUnrated: testCase.blockUnrated,
              ...(endpoint === 'detail' ? { detailId: itemByKey.get(testCase.detailKey).id } : {}),
            } : {}),
            ...(descriptor.recordScope === 'tagPolicy' ? {
              allowedTags: testCase.allowedTags,
              blockedTags: testCase.blockedTags,
              ...(endpoint === 'detail' ? { detailId: itemByKey.get(testCase.detailKey).id } : {}),
            } : {}),
            expectedStatus,
            response,
          };
          records.push(record);
        }
        const databaseAfterCaseReads = completeDatabaseSnapshot();
        const stableAcrossReads = stable(databaseBeforeCaseReads) === stable(databaseAfterCaseReads);
        fullDatabaseReadGates.push({ name: testCase.name,
          beforeSha256: databaseBeforeCaseReads.sha256,
          afterSha256: databaseAfterCaseReads.sha256,
          userTables: databaseBeforeCaseReads.tableSummaries.length,
          sequenceRows: databaseBeforeCaseReads.sequences.length,
          stable: stableAcrossReads });
        assert.equal(stableAcrossReads, true, `${testCase.name}: native HTTP reads mutated the complete database.`);
      }
      if (['official-rating-range', 'rating-permissions', 'tag-permissions'].includes(seedScenario)) {
        const restore = await request(origin, `/Users/${userId}/Policy`, { method: 'POST', token, body: basePolicy });
        assert.equal(restore.status, 204, `Native policy restore failed: ${restore.bodyText}`);
        setupRecords.push({ kind: 'policy-restore', status: restore.status });
      }
      stages.afterReads = { database: selectedDatabaseSnapshot() };
    } catch (error) {
      outcomeError = error;
    } finally {
      if (instance) lifecycle = await stopReference(instance, token, origin, setupRecords);
      try { fullDatabaseAfterRun = completeDatabaseSnapshot(); }
      catch (error) { outcomeError ??= error; }
      if (baselineDatabaseBytes && lifecycle.pidGone && lifecycle.portAvailable && lifecycle.databaseUnlocked) {
        try { await restoreSerializedDatabase(baselineDatabaseBytes); }
        catch (error) { outcomeError ??= error; }
      }
      stages.before ??= { database: selectedDatabaseSnapshot() };
      stages.afterReads ??= { database: selectedDatabaseSnapshot() };
      stages.afterShutdown = { database: selectedDatabaseSnapshot() };
      try { fullDatabaseAfterShutdown = completeDatabaseSnapshot(); }
      catch (error) { outcomeError ??= error; }
    }

    nativeLaunch.after = await executionInputs();
    const executionInputsUnchanged = stable(nativeLaunch.before) === stable(nativeLaunch.after);
    const recorderSha256 = await sha256File(recorderPath);
    const fixtureSha256 = sha256Bytes(fixtureBytes);
    const scenarioDefinitionSha256 = sha256Bytes(Buffer.from(stable({
      scenarioName,
      descriptor: Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== 'cases')),
      cases: scenarioCases,
    })));
    const completeDatabaseReadStable = fullDatabaseReadGates.length === scenarioCases.length
      && fullDatabaseReadGates.every(gate => gate.stable);
    const completeDatabaseRestored = Boolean(fullDatabaseBaseline && fullDatabaseAfterShutdown)
      && stable(fullDatabaseBaseline) === stable(fullDatabaseAfterShutdown);
    const completeDatabaseReadStableAndRestored = completeDatabaseReadStable && completeDatabaseRestored;
    const selectedDatabaseStable = stable(stages.before.database) === stable(stages.afterReads.database)
      && stable(stages.afterReads.database) === stable(stages.afterShutdown.database);
    const foreignKeyCheckPassedAllStages = Object.values(stages)
      .every(stage => stage.database.foreignKeyCheck.length === 0);
    const fullDatabaseSnapshots = [fullDatabaseBaseline, fullDatabaseAfterRun, fullDatabaseAfterShutdown].filter(Boolean);
    const integrityCheckPassedAllStages = fullDatabaseSnapshots.length === 3
      && fullDatabaseSnapshots.every(snapshot => snapshot.integrityCheck.every(row => Object.values(row).includes('ok'))
        && snapshot.foreignKeyCheck.length === 0);
    const sourceUnchanged = await sha256File(sourceDatabase) === sourceSummary.sourceDatabaseSha256;
    const invocation = {
      scenario: scenarioName,
      identity: 'same-workflow-current-native-filter-http',
      outputRoot: path.relative(validationOutputRoot(), destination).replaceAll('\\', '/'),
      preferredPort,
      selectedPort,
    };
    const nativeHttpPath = path.join(nativeRun, 'native-http.json');
    const setupHttpPath = path.join(nativeRun, 'setup-http.json');
    const stagesPath = path.join(nativeRun, 'stages.json');
    const summaryPath = path.join(nativeRun, 'summary.json');
    const provenancePath = path.join(nativeRun, 'provenance.json');
    await writeFile(nativeHttpPath, json({ schemaVersion: 2, invocation, origin, records }), { flag: 'wx' });
    await writeFile(setupHttpPath, json({ schemaVersion: 2, invocation, origin, records: setupRecords }), { flag: 'wx' });
    await writeFile(stagesPath, json({ schemaVersion: 2, invocation, ...stages }), { flag: 'wx' });
    const preSummaryArtifactNames = ['current-profile.json', 'native-input-templates.json', 'identity-mapping.json',
      'native-http.json', 'setup-http.json', 'stages.json', 'reference-stdout.log', 'reference-stderr.log'];
    const boundArtifacts = await artifactEntries(preSummaryArtifactNames);
    negativeControls.artifactManifest = await artifactTamperNegativeControl(boundArtifacts);
    const negativeControlsPassed = Object.values(negativeControls.responseValidation).every(Boolean)
      && Object.values(negativeControls.artifactManifest).every(Boolean);
    const summary = {
      schemaVersion: 1, identity: 'same-workflow-current-native-filter-http',
      passed: !outcomeError && records.length === descriptor.expectedRecords
        && completeDatabaseReadStableAndRestored && selectedDatabaseStable && foreignKeyCheckPassedAllStages
        && integrityCheckPassedAllStages && readiness.httpReady && lifecycle.shutdownStatus === 204
        && lifecycle.processResult?.code === 0 && lifecycle.processResult?.signal == null
        && lifecycle.pidGone && lifecycle.portAvailable && lifecycle.databaseUnlocked
        && sourceUnchanged && executionInputsUnchanged && negativeControlsPassed,
      invocation, scenario: scenarioName, cases: scenarioCases.length, httpRecords: records.length,
      completeDatabaseReadStableAndRestored, selectedDatabaseStable,
      fullDatabaseCoverage: { userTables: fullDatabaseBaseline?.tableSummaries.length ?? null,
        baselineSha256: fullDatabaseBaseline?.sha256 ?? null, afterRunSha256: fullDatabaseAfterRun?.sha256 ?? null,
        afterShutdownSha256: fullDatabaseAfterShutdown?.sha256 ?? null, readGates: fullDatabaseReadGates,
        readStable: completeDatabaseReadStable, restored: completeDatabaseRestored },
      foreignKeyCheckPassedAllStages, integrityCheckPassedAllStages, readiness,
      cleanShutdown: lifecycle.shutdownStatus === 204, processResult: lifecycle.processResult,
      selectedPort, portAvailable: lifecycle.portAvailable, pidGone: lifecycle.pidGone, databaseUnlocked: lifecycle.databaseUnlocked,
      recorderSha256, fixtureSha256, scenarioDefinitionSha256, sourceSummary, sourceUnchanged,
      nativeLaunch, executionInputsUnchanged, boundArtifacts, negativeControls,
      baselineRestoration: 'The private post-authentication baseline is restored only after Native has stopped; each real HTTP batch is checked before restoration.',
      historicalRecordingReused: false, phaseAcceptance: false, releaseAcceptance: false,
      error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
    };
    await current.finish();
    await writeFile(summaryPath, json(summary), { flag: 'wx' });
    await writeFile(provenancePath, json({ schemaVersion: 1, identity: summary.identity, invocation,
      fixture: { path: descriptor.fixture, sha256: fixtureSha256 }, recorderSha256, scenarioDefinitionSha256,
      sourceSummary, preparedInputs: preparation.inputs, historicalRecordingReused: false, artifacts: [],
      limitations: ['Offline synthetic media rows; real current Native HTTP responses.',
        'Static source declarations cover permission flags, not transcoding or playback negotiation.',
        'Historical receipts and recordings retain their own identities and remain outside this current capture.'],
    }), { flag: 'wx' });
    if (!summary.passed) throw new Error(`Current Native item-filter recording failed: ${JSON.stringify(summary.error ?? summary)}`);
  } catch (error) {
    failure = privateOutput.publicError(error);
    await mkdir(privateOutput.root, { recursive: true });
    await writeFile(path.join(privateOutput.root, 'recording-error.json'), json({ name: failure.name,
      message: failure.message, historicalRecordingReused: false, phaseAcceptance: false, releaseAcceptance: false }), { flag: 'wx' });
  }
  finally { await privateOutput.publishAndClose(); }
  if (failure) throw failure;
  return destination;
}
