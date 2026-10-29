import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DomainStore } from '../../src/database/domain-store.js';
import { nativeModel } from '../../src/database/model.js';
import { queryPostgresDtoChildCounts } from '../../src/database/postgres-item-query.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { LibraryService } from '../../src/library/library-service.js';
import { childCountSourceIds } from '../../src/library/child-counts.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { cloneNativeItemEntity } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';

export const requiredValidationServices = ['postgres'];
const id = number => `9f740000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const nativeType = kind => kind === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie'
  : kind === 'PlaylistsFolder' ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder'
    : `MediaBrowser.Controller.Entities.${kind}`;
const row = (number, kind, values = {}) => postgresTestRow('BaseItems', {
  Id: id(number), Type: nativeType(kind), Name: `${kind} ${number}`, SortName: String(number).padStart(4, '0'),
  PresentationUniqueKey: id(number), IsFolder: kind !== 'Movie', IsVirtualItem: false,
  OfficialRating: 'G', InheritedParentalRatingValue: 0, Data: '{}', ...values,
});
const sourceBindings = [
  { path: 'Emby.Server.Implementations/Dto/DtoService.cs', consumer: 'GetChildCountSourceIds gives UserRoot its own persisted ID; AddUserSpecificInfo requires a user, Library SourceType and the selected ChildCount field' },
  { path: 'Jellyfin.Server.Implementations/Item/ItemCountService.cs', consumer: 'GetChildCountBatch counts accessible link rows before hierarchy, excludes virtual only from hierarchy, and sums repeated requested source IDs in DtoService' },
  { path: 'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', consumer: 'ApplyAccessFiltering applies parental/tags, owned and same-library alternate-version access without PrepareFilterQuery or root scope' },
  { path: 'MediaBrowser.Controller/Entities/InternalItemsQuery.cs', consumer: 'SetUser leaves TopParentIds empty' },
  { path: 'src/Jellyfin.Database/Jellyfin.Database.Implementations/DescendantQueryHelper.cs', consumer: 'IsDistinctLibraryItem requires PrimaryVersionId null for a userless batch' },
  { path: 'MediaBrowser.Controller/Entities/UserRootFolder.cs', consumer: 'The entity virtual GetChildCount counts navigation; it is not the DTO batch consumer' },
];
const snapshot = async database => Object.fromEntries(await Promise.all(nativeModel.tables.map(async table => [table.name,
  await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })])));
const errorInfo = error => ({ name: error.name, message: error.message, code: error.code ?? null });

test('production PostgreSQL UserRoot DTO counts persisted sources instead of virtual navigation, with exact linked and userless batch access', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'user-root-dto-child-count-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, sourceBindings, nativeExecutedByThisTest: false,
    actualNativeEvidence: 'The independent recordings full-host recorder observes native ChildCount=2 for a user root with two persisted children and a virtual playlist. This regression executes the production PostgreSQL/library/DTO consumers; it does not record a new native oracle.',
    scope: 'Persisted UserRoot DTO child counts, relation multiplicity, hierarchy-only virtual filtering, user access and SourceType gating.',
    unmetPrerequisites: ['Merged presentation-key Series/Season child counts and a new full native DTO recorder are outside this component.'],
    observations: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  const save = () => writeFile(path.join(output, 'report.json'), stringifyNativeJson(report) + '\n');
  let database, store, library, failure;
  const owners = [], errors = [];
  report.runtimeErrors = errors;
  try {
    database = await createPostgresTestDatabase(null, 'root_dto_count');
    await database.insertBatch('BaseItems', [
      row(1, 'UserRootFolder', { Data: '{"IsRoot":true}' }), row(2, 'AggregateFolder', { Data: '{"IsRoot":true}' }),
      row(10, 'CollectionFolder', { ParentId: id(1), Data: JSON.stringify({ PhysicalFolderIds: [id(12)] }) }),
      row(11, 'CollectionFolder', { ParentId: id(1), Data: JSON.stringify({ PhysicalFolderIds: [id(13)] }) }),
      row(12, 'Folder', { ParentId: id(2), TopParentId: id(12) }),
      row(13, 'Folder', { ParentId: id(2), TopParentId: id(13) }),
      row(14, 'PlaylistsFolder', { ParentId: id(2) }),
      row(20, 'Movie', { ParentId: id(12), TopParentId: id(12) }),
      row(21, 'Movie', { ParentId: id(12), TopParentId: id(12), IsVirtualItem: true }),
      row(22, 'Movie', { ParentId: id(13), TopParentId: id(13), InheritedParentalRatingValue: 21, OfficialRating: 'R' }),
      row(23, 'Movie', { ParentId: id(12), TopParentId: id(12), OwnerId: id(20) }),
      row(24, 'Movie', { ParentId: id(12), TopParentId: id(12), OwnerId: id(20), ExtraType: 1 }),
      // A real primary exists in a different library: user access keeps this
      // row, while the native userless IsDistinctLibraryItem always drops it.
      row(25, 'Movie', { ParentId: id(12), TopParentId: id(12), PrimaryVersionId: id(22) }),
      row(26, 'Movie', { ParentId: id(12), TopParentId: id(12), PrimaryVersionId: id(20) }),
    ]);
    store = new DomainStore(database);
    library = new LibraryService({ store, serverId: 'root-dto-count', fileSystem: testFileSystem,
      configuration: {}, onError: error => errors.push(errorInfo(error)) });
    await attachLibraryNavigation(library);
    const user = { Id: id(900), Username: 'Count reader', MaxParentalRatingScore: 5,
      MaxParentalRatingSubScore: 0, DisplayMissingEpisodes: false, Configuration: {},
      Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
        BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
    const root = await library.itemCreation.getItemById(id(1));
    const aggregate = await library.itemCreation.getItemById(id(2));
    const virtual = await library.itemCreation.getItemById(id(14));
    for (const item of [root, aggregate, virtual]) owners.push(library.itemCreation.retainItem(item));
    aggregate.VirtualChildren.splice(0, aggregate.VirtualChildren.length, virtual);
    const before = await snapshot(database); report.before = before;
    await store.run(async session => {
      const state = await library.loadNavigation(session, user, { includeUserData: false });
      try {
        const navigation = library.rootChildren(state, user).map(item => idKey(item.Id));
        assert.deepEqual(navigation, [10, 11, 14].map(number => idKey(id(number))));
        assert.deepEqual(childCountSourceIds(root, state, user), [root.Id]);
        assert.equal(await library.getDtoChildCount(root, state, user), 2);
        report.navigation = { itemIds: navigation, dtoSourceIds: [root.Id], navigationChildCount: navigation.length, dtoChildCount: 2 };
        let calls = 0;
        const actualCount = state.getChildCount;
        state.getChildCount = item => { calls++; return actualCount(item); };
        const selected = dtoOptions({ fields: ['ChildCount'], enableimages: false, enableuserdata: false });
        const wire = await projectItem(root, state, user, selected, library.options);
        assert.equal(wire.ChildCount, 2); assert.equal(calls, 1);
        const anonymous = await projectItem(root, state, null, selected, library.options);
        assert.equal(Object.hasOwn(anonymous, 'ChildCount'), false); assert.equal(calls, 1);
        const channel = cloneNativeItemEntity(root); owners.push(library.itemCreation.retainItem(channel)); channel.ChannelId = id(700);
        assert.equal(channel.SourceType, 'Channel');
        const external = await projectItem(channel, state, user, selected, library.options);
        assert.equal(Object.hasOwn(external, 'ChildCount'), false); assert.equal(calls, 1);
        const omitted = await projectItem(root, state, user,
          dtoOptions({ fields: [], enableimages: false, enableuserdata: false }), library.options);
        assert.equal(Object.hasOwn(omitted, 'ChildCount'), false); assert.equal(calls, 1);
        report.dtoGates = { libraryWithUser: wire.ChildCount, userlessOmitted: true, channelSourceOmitted: true,
          unselectedFieldOmitted: true, actualCountCalls: calls };
      } finally { await state.dispose({ session }); }
    });
    const publicDto = await library.getItem(id(1), { user, Fields: 'ChildCount', EnableImages: false, EnableUserData: false });
    assert.equal(publicDto.ChildCount, 2); report.publicDto = publicDto;
    assert.deepEqual(await snapshot(database), before, 'Virtual navigation and DTO reads do not mutate native business tables.');

    const request = { key: idKey(id(1)), parentIds: [id(1)], linkEligible: true };
    const access = { userId: user.Id, visibility: { maxRating: 5, maxSubRating: 0,
      // These ordinary prepared-query scopes are deliberately inapplicable to
      // ItemCountService's fresh InternalItemsQuery(user), even when empty.
      topParentIds: [], libraryTopParentIds: [id(13)] } };
    const count = async (name, expected, options = access, requests = [request], query = { ismissing: false }) => {
      const beforeRead = await snapshot(database);
      const actual = await queryPostgresDtoChildCounts(database, requests, query, options);
      assert.deepEqual([...actual], expected, name);
      assert.deepEqual(await snapshot(database), beforeRead, name + ': complete business rows remain unchanged');
      report.observations.push({ name, userId: options.userId ?? null, query, requests, counts: [...actual] });
    };
    const links = async entries => {
      for (const entry of await database.rows('LinkedChildren', { where: { ParentId: id(1) } })) {
        await database.delete('LinkedChildren', { ParentId: entry.ParentId, SortOrder: entry.SortOrder });
      }
      await database.insertBatch('LinkedChildren', entries.map(([number, type], index) => ({
        ParentId: id(1), ChildId: id(number), ChildType: type, SortOrder: index,
      })));
    };
    await count('persisted hierarchy counts two sources despite blocked root scope', [[request.key, 2]]);
    await count('repeated physical source occurrences sum once each', [['repeat', 6], ['single', 2]], access,
      [{ ...request, key: 'repeat', parentIds: [id(1), id(1), id(1)] }, { ...request, key: 'single' }]);
    await links([[20, 3]]);
    await count('a nonmanual persisted link replaces the two hierarchical children', [[request.key, 1]]);
    const linkedPublic = await library.getItem(id(1), { user, Fields: 'ChildCount', EnableImages: false, EnableUserData: false });
    assert.equal(linkedPublic.ChildCount, 1); report.publicLinkedChildCount = linkedPublic.ChildCount;
    await links([[20, 0], [20, 0], [20, 3], [21, 1], [22, 0], [23, 0], [24, 0], [25, 0], [26, 0]]);
    await count('duplicate relation rows, all link types, virtual links and accessible extras retain exact multiplicity', [[request.key, 6]]);
    await links([[22, 0]]);
    await count('only inaccessible links fall back to the hierarchy', [[request.key, 2]]);
    await count('a userless count does not apply user parental or root restrictions', [[request.key, 1]],
      { userId: null, visibility: { maxRating: 5, topParentIds: [] } });
    await links([[21, 1]]);
    await count('a virtual linked row survives hidden-missing hierarchy policy', [[request.key, 1]]);
    await count('explicit link-ineligible fallback remains hierarchical', [['fallback', 2]], access,
      [{ ...request, key: 'fallback', linkEligible: false }]);
    await links([[25, 3]]);
    await count('a user retains a linked alternate whose primary belongs to another library', [[request.key, 1]]);
    await count('a userless batch strictly drops every linked PrimaryVersionId', [[request.key, 2]], { userId: null });
    await links([]);
    await database.insert('BaseItems', row(30, 'Movie', { ParentId: id(1), IsVirtualItem: true }));
    await count('a hidden virtual hierarchical child is excluded for this user', [[request.key, 2]]);
    await count('DisplayMissingEpisodes includes the virtual hierarchical child', [[request.key, 3]], access, [request], {});
    await count('a userless batch includes virtual hierarchy even with a caller missing-item hint', [[request.key, 3]], { userId: null });
  } catch (error) { failure = error; throw error; }
  finally {
    const failures = [];
    const checkpoint = async () => { try { await save(); } catch (error) { failures.push(error); } };
    report.error = failure ? errorInfo(failure) : null;
    await checkpoint();
    for (const [name, action] of [
      ['typedOwnersReleased', async () => { for (const owner of owners.splice(0)) await owner.release(); }],
      ['libraryNavigationClosed', () => library && closeLibraryNavigation(library)],
      ['domainStoreClosed', () => store?.close()],
      ['isolatedSchemasRemoved', () => dropPostgresTestDatabase(database)],
    ]) {
      report.cleanupPending = name; await checkpoint();
      try { await action(); report.cleanup[name] = true; }
      catch (error) { failures.push(error); report.cleanup[name] = errorInfo(error); }
      delete report.cleanupPending; await checkpoint();
    }
    report.componentPassed = !failure && !failures.length;
    await checkpoint();
    if (failures.length) throw new AggregateError(failure ? [failure, ...failures] : failures,
      failure?.message ?? 'User-root child-count cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
