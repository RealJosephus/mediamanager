import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { tableDefinition } from '../../src/database/model.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { projectItemBody } from '../helpers/http-body-projection.js';
import { projectPersistedItemData } from '../helpers/persisted-item-data-projection.js';
import { makeInput } from './fixtures/year-channel-source/input.js';
import { openYearChannelScenario, tableNames } from './fixtures/year-channel-source/scenario.js';
import { removeOwned } from './fixtures/channel-items/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const json = value => stringifyNativeJson(value) + '\n';
const sort = rows => [...rows].sort((left, right) => json(left).localeCompare(json(right), 'en'));
const yearType = 'MediaBrowser.Controller.Entities.Year';
const temporary = async db => (await db.client.query('SELECT oid::text,relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() ORDER BY oid')).rows;
const backend = async db => (await db.client.query('SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];

test('actual UserView Channel Years preserves provider/cache effects, complete output, live relationships and owned SQL pages', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'year-channel-source-' + randomUUID());
  const privateRoot = path.join(output, 'private'); await mkdir(privateRoot, { recursive: true });
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input)), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, bytes);
  const report = { schemaVersion: 1, phaseAcceptance: false, releaseAcceptance: false, comparisons: [], differences: [], cleanup: {},
    boundary: 'Actual designated YearsController, UserView/ChannelManager, LibraryManager/GetYear, EF SQLite and DtoService versus real Node HTTP/PluginHost/PostgreSQL. Provider inputs, metadata execution and authorization principal are explicit controls. Complete domain tables, existing Data TEXT, new typed Data reader values and literal unknown occurrences, complete Year DTOs, actual Year directory dates, persistent cache/media JSON and live consumer values are compared. Full original Data is retained. Callback owner lifetime and backend recovery run against actual SQL; no object identity or private query-count gates.' };
  let current, body;
  t.after(async () => {
    if (body) await outcome(body);
    try { if (current) { await current.finish(); report.cleanup.nativeReference = true; } }
    finally { await writeFile(path.join(output, 'report.json'), json(report)); }
  });
  body = (async () => {
    current = await currentNativeReference(); t.signal.throwIfAborted(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/YearsController.cs',
      'MediaBrowser.Controller/Entities/UserView.cs', 'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
      'MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Channels/Channel.cs',
      'src/Jellyfin.LiveTv/Channels/ChannelManager.cs', 'MediaBrowser.Controller/Entities/Year.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs',
      'src/Jellyfin.Extensions/Json/Converters/JsonDateTimeConverter.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonStringConverter.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Dto/DtoService.cs',
      'Emby.Server.Implementations/Library/UserDataManager.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/year-channel-source/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] });
    assert.equal(receipt.passed, true); t.signal.throwIfAborted();
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const assembly of [...native.assemblies, native.sqliteNative]) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.equal(native.results.length, input.cases.length);
    const compare = (name, actual, expected) => {
      try { assert.deepEqual(actual, expected, name); }
      catch (reason) { report.differences.push({ name, message: reason.message }); }
    };
    const projectPath = (value, root) => typeof value === 'string' && (value === root || value.startsWith(root + path.sep))
      ? '$fixture-root' + value.slice(root.length) : value;
    const projectTables = (tables, root, directories, originalIds) => Object.fromEntries(tableNames.map(table => [table, sort(tables[table].map(row =>
      Object.fromEntries(tableDefinition(table).columns.filter(column => Object.hasOwn(row, column.name)).map(column => {
        let value = row[column.name]; const type = column.clrType.replace('?', '');
        if (table === 'BaseItems' && row.Type === yearType && ['DateCreated', 'DateModified'].includes(column.name)) {
          const directory = directories.find(value => idKey(value.id) === idKey(row.Id)); assert.ok(directory, row.Name);
          assert.equal(dateTicks(value), BigInt(column.name === 'DateCreated' ? directory.createdTicks : directory.modifiedTicks));
          value = '$directory-time';
        } else if (table === 'BaseItems' && column.name === 'Data') value = projectPersistedItemData(value, row.Type,
          { created: !originalIds.has(idKey(row.Id)), path: value => projectPath(value, root) });
        else if (value != null) {
          if (type === 'Guid') value = idKey(value);
          else if (type === 'bool') value = Boolean(value);
          else if (type === 'long' || type === 'uint') value = String(value);
          else if (type === 'DateTime') value = dateText(value);
          else if (column.name === 'Path' && ['BaseItems', 'BaseItemImageInfos'].includes(table)) value = projectPath(value, root);
        }
        return [column.name, value];
      }))))]));
    const projectWarm = (rows, root) => sort(rows.map(({ type: _runtimeType, ...row }) => ({ ...row, Path: projectPath(row.Path, root),
      RunTimeTicks: row.RunTimeTicks == null ? null : String(row.RunTimeTicks) })));
    const projectBody = (value, root, tables) => projectItemBody(value, { path: entry => projectPath(entry, root),
      date: (entry, { field, owner }) => {
        const row = tables.BaseItems.find(row => row.Type === yearType && idKey(row.Id) === idKey(owner.Id));
        if (row && field === 'DateCreated') { assert.equal(dateTicks(entry), dateTicks(row.DateCreated)); return '$directory-time'; }
        return dateText(entry);
      },
    });
    const cache = files => sort(files.map(file => ({ path: file.path, value: (() => {
      try { return parseLosslessJson(file.text); } catch { return file.text; }
    })() })));
    for (const [index, sample] of input.cases.entries()) {
      t.signal.throwIfAborted();
      const expected = native.results[index], f = await openYearChannelScenario(sample, expected, path.join(privateRoot, 'node-' + index));
      const originalIds = new Set(expected.beforeTables.BaseItems.map(row => idKey(row.Id)));
      const observations = [];
      try {
        compare(sample.name + ':input', projectTables(await f.tables(), f.root, [], originalIds), projectTables(expected.beforeTables, expected.root, [], originalIds));
        for (const [stepIndex, step] of sample.steps.entries()) {
          t.signal.throwIfAborted();
          const actual = await f.step(step, t.signal), reference = expected.steps[stepIndex];
          observations.push(actual); assert.equal(reference.name, step.name);
          assert.ok(Object.hasOwn(reference.action, 'value'), 'Native source/control failed at ' + sample.name + ':' + step.name);
          assert.ok(Object.hasOwn(actual.action, 'value'), 'Node source/control failed at ' + sample.name + ':' + step.name);
          compare(sample.name + ':' + step.name + ':body', projectBody(actual.action.value, f.root, actual.tables),
            projectBody(reference.action.value, expected.root, reference.tables));
          if (step.kind === 'years') { assert.equal(actual.wire.status, 200); assert.equal(actual.wire.contentType, 'application/json; charset=utf-8'); }
          compare(sample.name + ':' + step.name + ':tables', projectTables(actual.tables, f.root, actual.directories, originalIds),
            projectTables(reference.tables, expected.root, reference.directories, originalIds));
          compare(sample.name + ':' + step.name + ':live values', projectWarm(actual.warm, f.root), projectWarm(reference.warm, expected.root));
          compare(sample.name + ':' + step.name + ':cache', cache(actual.cacheFiles), cache(reference.cacheFiles));
          compare(sample.name + ':' + step.name + ':media cache', cache(actual.mediaFiles), cache(reference.mediaFiles));
        }
        const value = name => observations.find(value => value.name === name);
        if (index === 0) {
          assert.deepEqual(value('cold zero window commits all distinct years').action.value.Items, []);
          assert.equal(value('cold zero window commits all distinct years').tables.BaseItems.filter(row => row.Type === yearType).length, 130);
          assert.equal(value('cached complete year list').action.value.Items.length, 130);
          assert.equal(value('recursive movie count includes nonpositive year occurrences').action.value.TotalRecordCount, 132);
          assert.deepEqual(value('recursive audio source filter').action.value.Items.map(item => item.Name), ['1999']);
          const included = value('recursive included types take precedence over exclusions').action.value;
          assert.equal(included.TotalRecordCount, 133);
          assert.deepEqual(included.Items, value('cached complete year list').action.value.Items);
          assert.deepEqual(value('userless Years does not dispatch the UserView').action.value.Items, []);
        } else if (index === 1) {
          assert.deepEqual(value('live folder display parent refreshes its own provider cache').action.value.Items.map(item => item.Name), ['2002']);
          assert.deepEqual(value('cached recursive root includes descendants').action.value.Items.map(item => item.Name), ['2002', '2001']);
          const refreshed = value('recursive provider miss deletes stale direct children and retains descendants');
          assert.deepEqual(refreshed.action.value.Items.map(item => item.Name), ['2002']);
          assert.equal(refreshed.action.value.TotalRecordCount, 1);
          assert.ok(!refreshed.tables.BaseItems.some(row => row.ExternalId === 'root-movie'));
          assert.ok(refreshed.tables.BaseItems.some(row => row.ExternalId === 'child-movie' && row.ProductionYear === 2002));
        } else if (index === 2) {
          const failed = observations[0], recovered = observations[1];
          assert.deepEqual(failed.action.value.Items, []); assert.ok(failed.tables.BaseItems.some(row => row.ExternalId === 'first'));
          assert.ok(!failed.tables.BaseItems.some(row => row.Type === yearType)); assert.ok(failed.cacheFiles.length > 0);
          assert.deepEqual(recovered.action.value.Items.map(item => item.Name), ['2020']);
        } else if (index === 4) {
          const last = observations.at(-1), warm = last.warm.find(row => row.ExternalId === 'same'), persisted = last.tables.BaseItems.find(row => row.ExternalId === 'same');
          assert.equal(warm.ProductionYear, 2021); assert.equal(persisted.ProductionYear, 2020);
          assert.deepEqual(last.action.value.Items.map(item => item.Name), ['2020']);
        }
      } finally {
        await writeFile(path.join(output, 'node-' + index + '.json'), json({ observations, diagnostics: f.diagnostics }));
        await f.close(); report.cleanup['scenario-' + index] = true;
      }
      report.comparisons.push({ name: sample.name, steps: observations.length });
    }

    // Exercise the same installed provider and actual selection owner directly:
    // callback failure values, empty TEMP state and subsequent public reads are
    // real contracts. No private callback/query-count identity is asserted.
    t.signal.throwIfAborted();
    const f = await openYearChannelScenario(input.cases[0], native.results[0], path.join(privateRoot, 'owner'));
    try {
      const channel = native.results[0].identities[0].id;
      await f.channels.getChannelItems({ User: f.user, ParentId: channel, ChannelIds: [channel], Fields: [] });
      const reader = f.channels.admitOperation();
      try {
        await f.store.run(async db => {
          const before = await temporary(db), physical = await backend(db);
          for (const marker of [false, 0, '', null, undefined]) {
            t.signal.throwIfAborted();
            const failed = await outcome(reader.withChannelItems({ User: f.user, ParentId: channel, ChannelIds: [channel] }, async selected => {
              const page = await selected.page({ offset: 0, limit: 128 }); assert.equal(page.rows.length, 128);
              assert.ok(page.rows.some(row => row.ProductionYear > 0)); throw marker;
            }));
            assert.equal(failed.failed, true); assert.equal(failed.reason, marker);
            assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), physical);
            const recovered = await f.channels.getChannelItems({ User: f.user, ParentId: channel, ChannelIds: [channel], Limit: 1, Fields: [] });
            assert.equal(recovered.Items.length, 1);
          }
          const execute = db.client.query, queried = Promise.withResolvers(), release = Promise.withResolvers();
          let armed = false, pendingPage, operation, settled = false;
          db.client.query = async (...args) => {
            const result = await execute.apply(db.client, args);
            const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
            if (armed && typeof text === 'string' && text.includes('"mm_channel_items_') && /\bOFFSET\b/u.test(text)) {
              armed = false; queried.resolve(); await release.promise;
            }
            return result;
          };
          try {
            operation = reader.withChannelItems({ User: f.user, ParentId: channel, ChannelIds: [channel] }, selected => {
              armed = true; pendingPage = selected.page({ offset: 0, limit: 128 }); return 'callback returned';
            }).finally(() => { settled = true; });
            await Promise.race([queried.promise, operation.then(() => { throw new Error('The SQL page was not retained.'); })]);
            // A real round trip lets any prematurely queued DROP finish. The
            // owner still must wait for the admitted page's actual promise.
            assert.deepEqual((await db.client.query('SELECT 1 AS held_page_fence')).rows, [{ held_page_fence: 1 }]);
            assert.equal(settled, false);
            release.resolve(); assert.equal(await operation, 'callback returned'); assert.equal((await pendingPage).rows.length, 128);
            assert.deepEqual(await temporary(db), before); assert.deepEqual(await backend(db), physical);
            report.admittedPageDrained = true;
          } finally {
            release.resolve(); if (operation) await outcome(operation); if (pendingPage) await outcome(pendingPage);
            db.client.query = execute;
          }
          report.ownerRecovery = { original: physical, after: await backend(db), temporaryBefore: before, temporaryAfter: await temporary(db) };
        });
      } finally { await reader.release(); }
      const heldReader = f.channels.admitOperation(), entered = Promise.withResolvers(), proceed = Promise.withResolvers();
      let pending, channelClosing, libraryClosing, channelClosed = false, libraryClosed = false;
      try {
        pending = heldReader.withChannelItems({ User: f.user, ParentId: channel, ChannelIds: [channel] }, async selected => {
          const first = await selected.page({ offset: 0, limit: 128 }); assert.equal(first.rows.length, 128);
          entered.resolve(); await proceed.promise;
          const rest = await selected.page({ offset: 128, limit: 128 }); assert.equal(rest.rows.length, 6);
          return first.rows.length + rest.rows.length;
        });
        await Promise.race([entered.promise, pending.then(() => { throw new Error('The source ended before its held page.'); })]);
        channelClosing = f.channels.close().then(() => { channelClosed = true; });
        libraryClosing = f.library.close().then(() => { libraryClosed = true; });
        await Promise.resolve(); assert.equal(channelClosed, false); assert.equal(libraryClosed, false);
        const rejected = await outcome(f.channels.getChannelItems({ ChannelIds: [channel] }));
        assert.equal(rejected.failed, true); assert.equal(rejected.reason.status, 503);
        proceed.resolve(); assert.equal(await pending, 134);
        await heldReader.release(); await Promise.all([channelClosing, libraryClosing]);
        assert.equal(channelClosed, true); assert.equal(libraryClosed, true);
        report.heldOwner = { selectedRows: 134, channelClosed, libraryClosed };
      } finally {
        proceed.resolve(); if (pending) await outcome(pending);
        await heldReader.release(); await Promise.allSettled([channelClosing, libraryClosing].filter(Boolean));
      }
    } finally { await f.close(); report.cleanup.owner = true; }
    assert.deepEqual(report.differences, []);
    await removeOwned(output, privateRoot); report.cleanup.privateSourceRemoved = true;
  })();
  await body;
});
