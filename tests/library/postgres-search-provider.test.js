import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { queryPostgresBuiltInSearch, resolvePostgresSearchCollation } from '../../src/library/postgres-search-provider.js';
import { cleanValue } from '../../src/library/records.js';

const parentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const firstId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const secondId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const person = (Id, Name) => ({
  ...blank('BaseItems'),
  Id,
  Type: 'MediaBrowser.Controller.Entities.Person',
  Name,
  CleanName: cleanValue(Name),
  SortName: cleanValue(Name),
  PresentationUniqueKey: Id,
  Data: '{}',
});

test('PostgreSQL built-in search filters, scores and caps provider candidates in SQL', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'search_shape',
    schemaName: 'search_shape',
    client: { query: async plan => {
      calls.push(plan);
      return { rows: [{ Id: nativeTextBytes(firstId), Score: 100 }, { Id: nativeTextBytes(secondId), Score: 75 }] };
    } },
  };

  const result = await queryPostgresBuiltInSearch(database, {
    searchterm: '  Néédle  ',
    limit: 2,
    includeitemtypes: ['Movie'],
    mediatypes: ['Video'],
  }, {
    parentId,
    userId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    nameAccessTypes: ['Person'],
    visibility: { topParentIds: ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'] },
  });

  assert.deepEqual([...result], [
    [firstId.replaceAll('-', ''), 100],
    [secondId.replaceAll('-', ''), 75],
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /provider_candidates AS MATERIALIZED/u);
  assert.match(calls[0].text, /"AncestorIds"/u);
  assert.match(calls[0].text, /i\."IsVirtualItem" IS FALSE/u);
  assert.match(calls[0].text, /item\."PrimaryVersionId"/u);
  assert.match(calls[0].text, /ORDER BY "Score" DESC, .*mm_native_guid_lower.* ASC/u);
  assert.equal(calls[0].values.at(-1), 6, 'the provider receives Limit * 3');
  assert.ok(calls[0].values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextBytes('%needle%'))));
});

test('PostgreSQL built-in search stops before querying for an empty provider limit', async () => {
  let queried = false;
  const database = {
    dialect: 'postgres',
    schemaName: 'search_shape',
    client: { query: async () => { queried = true; return { rows: [] }; } },
  };
  const result = await queryPostgresBuiltInSearch(database, { searchterm: 'needle', limit: 0 });
  assert.deepEqual([...result], []);
  assert.equal(queried, false);
});

test('PostgreSQL search resolves the closest ICU collation as a quoted plan input', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'search_shape',
    connectionSession: true, connectionActive: true, inTransaction: false,
    client: { query: async plan => {
      calls.push(plan);
      if (calls.length === 1) return { rows: [{ Schema: 'pg_catalog', Name: 'da-DK-x-icu', Locale: 'da-DK', Rules: null,
        Encoding: -1, Version: 'fixture-version', ActualVersion: 'fixture-version', Owner: 'fixture-owner' }] };
      if (calls.length === 3) return { rows: [{ Provider: 'i', Deterministic: false, Encoding: -1,
        Collate: null, Ctype: null, Locale: 'da-DK', Rules: null, Version: 'fixture-version',
        ActualVersion: 'fixture-version', Owner: 'fixture-owner' }] };
      return { rows: [] };
    } },
  };
  const collation = await resolvePostgresSearchCollation(database, 'da-DK');
  assert.equal(collation.schema, 'pg_temp');
  assert.match(collation.name, /^mm_search_[a-f0-9]{32}$/u);
  assert.match(calls[1].text, /deterministic = false/u);
  assert.deepEqual(calls[0].values[0].slice(0, 2), ['da-dk-x-icu', 'da-x-icu']);
  assert.match(calls[0].text, /pg_catalog\.pg_collation/u);
  await collation.release();
  assert.match(calls.at(-1), /^DROP COLLATION IF EXISTS "pg_temp"/u);
});

test('real PostgreSQL applies the request culture before provider-result paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `search_culture_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  let library;
  t.after(async () => {
    database.queryHook = null;
    await closeLibraryNavigation(library);
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });

  const ringId = '23000000-0000-0000-0000-000000000001';
  const strokeId = '23000000-0000-0000-0000-000000000002';
  await database.insert('BaseItems', person(ringId, '\u00e5 hit'));
  await database.insert('BaseItems', person(strokeId, '\u00f8 hit'));

  const observedErrors = [];
  library = new LibraryService({fileSystem: testFileSystem,
    store: new DomainStore(database),
    serverId: 'postgres-search-culture',
    configuration: { UICulture: 'da-DK', IsStartupWizardCompleted: true },
    onError: error => observedErrors.push(error),
  });
  await attachLibraryNavigation(library);
  const query = {
    SearchTerm: 'hit',
    IncludeItemTypes: 'Person',
    StartIndex: '0',
    Limit: '1',
    EnableImages: 'false',
  };
  const plans = [];
  database.queryHook = async (...args) => {
    const result = await database.client.query(...args);
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (text.includes('search_scores("Id", "Score")')) plans.push(text);
    return result;
  };
  const first = await library.queryItems(query);
  const second = await library.queryItems({ ...query, StartIndex: '1' });
  database.queryHook = null;

  assert.deepEqual(observedErrors, [], 'the PostgreSQL provider must not silently fall back');
  assert.deepEqual(first.Items.map(item => item.Id), [strokeId.replaceAll('-', '')],
    'Danish culture orders \u00f8 before \u00e5 before the first page is selected');
  assert.deepEqual(second.Items.map(item => item.Id), [ringId.replaceAll('-', '')]);
  assert.equal(first.TotalRecordCount, 2);
  assert.equal(first.StartIndex, 0);
  assert.equal(second.StartIndex, 1);
  assert.equal(plans.length, 2);
  assert.ok(plans.every(plan => /COLLATE "pg_temp"\."mm_search_[a-f0-9]{32}"/u.test(plan)));
  assert.match(plans[0], /page AS \(SELECT "Id", __ordinal FROM ordered ORDER BY __ordinal LIMIT \$\d+\)/u);
  assert.match(plans[1], /page AS \(SELECT "Id", __ordinal FROM ordered ORDER BY __ordinal LIMIT \$\d+ OFFSET \$\d+\)/u);
});
