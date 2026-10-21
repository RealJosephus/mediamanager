import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { queryPostgresDtoChildCounts } from '../../../../src/database/postgres-item-query.js';
import { transferDatabase } from '../../../../src/migration/database-transfer.js';
import { LibraryService } from '../../../../src/library/library-service.js';
import { loadPostgresRowsByIds } from '../../../../src/library/postgres-library-query.js';
import { idKey } from '../../../../src/library/records.js';
import { UserService } from '../../../../src/users/user-service.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from '../../navigation-fixture.js';
import { errorRecord, rows, sha } from '../../../http/fixtures/item-collections-current/scenario.js';

export { errorRecord, rows, sha };
export async function openMergedCountScenario(input, seedFilename, report) {
  let database, source, store, library, closing, currentCase, originalQuery;
  const owners = [], errors = report.runtimeErrors = [], queries = report.queries = [];
  const close = () => closing ??= (async () => {
    const failures = [];
    for (const action of [async () => { for (const owner of owners.splice(0)) await owner.release(); },
      () => library && closeLibraryNavigation(library), () => source?.close(), () => store?.close(),
      () => dropPostgresTestDatabase(database)]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Merged count component owners failed to close.');
  })();
  try {
    source = new SqliteDatabase(seedFilename, { readOnly: true, requireMigrationHistory: true });
    database = await createPostgresTestDatabase(null, 'merged_count');
    report.transfer = await transferDatabase(source, database, {
      instanceBinding: { serverId: input.serverId, originIdentityDigest: sha(await readFile(seedFilename)) },
      portableMountContract: { mounts: [{ mountId: 'merged-count', identityRoot: input.root, accessRoot: '/merged-count',
        pathStyle: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] },
    });
    source.close(); source = undefined;
    store = new DomainStore(database);
    library = new LibraryService({ store, fileSystem: testFileSystem, serverId: input.serverId, configuration: {},
      onError: error => errors.push({ case: currentCase, ...errorRecord(error) }) });
    await attachLibraryNavigation(library);
    const users = new UserService({ store, serverId: input.serverId });
    const authoritativeUsers = new Map();
    for (const definition of input.users) authoritativeUsers.set(definition.name, await users.getUser(definition.id));
    originalQuery = database.client.query;
    database.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const result = await originalQuery(...args);
      if (text.includes('/* dto-child-counts */')) queries.push({ case: currentCase, text,
        returned: result.rows.length, values: typeof args[0] === 'string' ? args[1] : args[0].values });
      return result;
    };
    return {
      database, library, errors, snapshot: () => rows(database), close,
      async run(sample) {
        currentCase = sample.name;
        const user = sample.user === 'anonymous' ? null : authoritativeUsers.get(sample.user);
        assert.ok(sample.user === 'anonymous' || user, sample.user);
        return store.run(async session => {
          const ids = [...new Map(sample.ids.map(id => [idKey(id), id])).values()];
          let counts;
          if (sample.lane === 'repository') {
            const requests = ids.map(id => ({ key: idKey(id), parentIds: [id], linkEligible: true }));
            const hideMissing = user && !(user.DisplayMissingEpisodes ?? user.Configuration?.DisplayMissingEpisodes);
            counts = await queryPostgresDtoChildCounts(session, requests, hideMissing ? { ismissing: false } : {}, {
              userId: user?.Id,
              visibility: user ? { maxRating: user.MaxParentalRatingScore ?? user.Policy.MaxParentalRating,
                maxSubRating: user.MaxParentalRatingSubScore ?? user.Policy.MaxParentalSubRating,
                blockedTags: user.Policy.BlockedTags, allowedTags: user.Policy.AllowedTags,
                blockUnratedTypes: user.Policy.BlockUnratedItems } : undefined,
            });
          } else {
            const state = await library.load(session, user, { includeUserData: false,
              baseRows: await loadPostgresRowsByIds(session, ids) });
            try {
              if (sample.warm) {
                const item = await library.itemCreation.getItemById(sample.warm.id); assert.ok(item);
                owners.push(library.itemCreation.retainItem(item)); item.PresentationUniqueKey = sample.warm.presentationKey;
                library.adoptLiveItem(state, item);
              }
              counts = new Map();
              for (const id of ids) {
                const item = state.byId.get(idKey(id)); assert.ok(item?.IsFolder, id);
                counts.set(idKey(id), await library.getDtoChildCount(item, state, user));
              }
            } finally { await state.dispose({ session }); }
          }
          assert.ok(queries.filter(query => query.case === currentCase).every(query => query.returned <= Math.max(ids.length, 1)),
            'Only aggregate count rows cross the SQL boundary, irrespective of merged child count.');
          return { name: sample.name, lane: sample.lane, user: sample.user,
            counts: [...counts].map(([id, count]) => ({ id, count })) };
        });
      },
    };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
