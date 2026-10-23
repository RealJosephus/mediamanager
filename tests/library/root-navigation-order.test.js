import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { LibraryService } from '../../src/library/library-service.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { idKey } from '../../src/library/records.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import { cachedFolderChildrenSnapshot } from '../../src/library/folder-cache.js';
import { postgresFolderChildIds } from '../../src/library/postgres-folder-child-ids.js';

export const requiredValidationServices = ['postgres'];
const id = number => `d12f0000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const row = (number, kind, values = {}) => postgresTestRow('BaseItems', {
  Id: id(number), Type: `MediaBrowser.Controller.Entities.${kind === 'BoxSet' ? 'Movies.BoxSet' : kind === 'Movie' ? 'Movies.Movie' : kind}`,
  Name: kind + ' ' + number, SortName: String(number).padStart(6, '0'), Data: '{}',
  IsFolder: kind !== 'Movie', OfficialRating: 'G', InheritedParentalRatingValue: 0,
  MediaType: kind === 'Movie' ? 'Video' : 'Unknown', ...values,
});
const describeError = error => ({ name: error.name, message: error.message, status: error.status ?? null,
  code: error.code ?? null, nativeException: error.nativeException ?? null });
async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((one, two) => one.name < two.name ? -1 : one.name > two.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).replaceAll('\\', '/');
      assert.equal(entry.isSymbolicLink(), false, 'The order fixture owns no linked filesystem entries.');
      if (entry.isDirectory()) { result.push({ path: relative, kind: 'directory' }); await visit(filename); }
      else { const bytes = await readFile(filename); result.push({ path: relative, kind: 'file', bytes: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await visit(root); return result;
}

test('real PostgreSQL root navigation preserves controller and BoxSet early-return order before a null live root relation', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'root-navigation-order-' + randomUUID());
  await mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
    sourceBindings: [
      { path: 'Jellyfin.Api/Controllers/ItemsController.cs', consumer: 'GetParentItem and IsVisible reject before Artists/Albums/Studios selectors and root children' },
      { path: 'Emby.Server.Implementations/Library/LibraryManager.cs', consumer: 'GetParentItem rejects a missing supplied identity' },
      { path: 'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', consumer: 'IsVisible checks own parental access, raw link length and complete membership before GetChildren(user,true)' },
      { path: 'MediaBrowser.Controller/Entities/Folder.cs', consumer: 'GetChildren consumes the captured linked sequence after direct/virtual child materialization' },
    ], cases: [], cleanup: {} };
  let database, root, library, rootOwner, originalPlan, failure;
  try {
    database = await createPostgresTestDatabase(null, 'root_order');
    root = await mkdtemp(path.join(os.tmpdir(), 'mm-root-navigation-order-'));
    const media = path.join(root, 'media'), data = path.join(root, 'data'), metadata = path.join(root, 'metadata');
    for (const directory of [media, data, metadata]) await mkdir(directory);
    const rootRow = row(1, 'UserRootFolder', { Data: '{"IsRoot":true}', Path: path.join(root, 'root', 'default') });
    await database.insertBatch('BaseItems', [rootRow,
      row(2, 'AggregateFolder', { Data: '{"IsRoot":true}', Path: path.join(root, 'physical-root') }),
      row(10, 'CollectionFolder', { ParentId: id(1), Path: path.join(root, 'root', 'default', 'Movies'),
        Data: JSON.stringify({ CollectionType: 'movies', PhysicalLocationsList: [media] }) }),
      row(12, 'Folder', { ParentId: id(2), TopParentId: id(12), Path: media }),
      row(11, 'Folder', { Name: 'Denied parent', ParentId: id(12), Path: path.join(media, 'denied'), OfficialRating: 'R', InheritedParentalRatingValue: 21 }),
      row(13, 'Folder', { Name: 'Denied own-country parent', ParentId: id(12), Path: path.join(media, 'denied-own-country'),
        OfficialRating: 'R', InheritedParentalRatingValue: 21, PreferredMetadataCountryCode: 'US' }),
      row(20, 'Movie', { ParentId: id(12), TopParentId: id(12), Path: path.join(media, 'member.mkv') }),
      ...[100, 101, 102, 103, 104].map(number => row(number, 'BoxSet', {
        Path: path.join(data, 'collections', String(number)),
        Data: JSON.stringify({ LibraryFolderIds: number === 102 ? [] : number === 104 ? null : [id(10)] }),
        ...(number === 100 ? { OfficialRating: 'R', InheritedParentalRatingValue: 21 } : {}),
      })),
    ]);
    await database.insertBatch('LinkedChildren', [100, 102, 103, 104].map(number => ({ ParentId: id(number), ChildId: id(20), ChildType: 0, SortOrder: 0 })));
    library = new LibraryService({ store: new DomainStore(database), serverId: 'root-order', fileSystem: testFileSystem,
      programDataPath: root, dataPath: data, metadataPath: metadata, userRoot: rootRow,
      configuration: { MetadataCountryCode: 'US', CacheSize: 64 } });
    await attachLibraryNavigation(library);
    const liveRoot = await library.itemCreation.getItemById(id(1));
    rootOwner = library.itemCreation.retainItem(liveRoot);
    liveRoot.LinkedChildren = null;
    await library.options.linkedChildren.flushReleases();
    const links = library.options.linkedChildren;
    let nullRootPlans = 0;
    originalPlan = links.plan;
    links.plan = function (handle) { if (handle === null) nullRootPlans++; return originalPlan.call(this, handle); };
    const user = { Id: id(900), Username: 'Order reader', MaxParentalRatingScore: 5, MaxParentalRatingSubScore: null,
      Configuration: {}, Policy: { EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
    const snapshot = async () => ({ rows: await database.rows('BaseItems', { orderBy: [{ column: 'Id', direction: 'ASC' }] }), files: await files(root) });
    const before = await snapshot();
    let expectedCacheRows = { states: 0, cohorts: 0 };
    const unchanged = async () => {
      assert.equal(library.itemCreation.getCachedItemById(id(1)), liveRoot);
      assert.equal(liveRoot.LinkedChildren, null, 'The live null relation must not be replaced by persisted links.');
      assert.deepEqual(await snapshot(), before, 'Rejected reads cannot create selector rows or state directories.');
      const state = (await database.client.query(`SELECT
        (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states,
        (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts`)).rows[0];
      assert.deepEqual(state, expectedCacheRows, 'Only the native country fallback may populate the persistent cold Children cache.');
    };
    async function rejects(name, operation, expected, rootReads, cacheRows = expectedCacheRows) {
      const previous = nullRootPlans; let observed;
      await assert.rejects(async () => { try { await operation(); } catch (error) { observed = describeError(error); throw error; } }, expected);
      assert.equal(nullRootPlans - previous, rootReads, name + ': captured null-root consumers');
      expectedCacheRows = cacheRows;
      await unchanged(); report.cases.push({ name, error: observed, rootReads: nullRootPlans - previous,
        coldChildrenRows: { ...expectedCacheRows } });
    }
    const selectors = { Artists: 'Must not create artist', Albums: 'Must not resolve album', Studios: 'Must not create studio',
      EnableImages: false, EnableUserData: false };
    await rejects('missing parent precedes null-root resolution and all selectors',
      () => library.queryItems({ ...selectors, ParentId: id(999) }, { user }),
      { status: 400, message: 'Error processing request.' }, 0);
    await rejects('own-country denied parent precedes cold Children and all selectors',
      () => library.queryItems({ ...selectors, ParentId: id(13) }, { user }),
      { status: 401, message: 'Order reader is not permitted to access Library Denied own-country parent.' }, 0);
    // GetPreferredMetadataCountryCode consults collection folders before it
    // falls back to configured country. That warms Children, not root links.
    await rejects('denied parent precedes null-root resolution and all selectors',
      () => library.queryItems({ ...selectors, ParentId: id(11) }, { user }),
      { status: 401, message: 'Order reader is not permitted to access Library Denied parent.' }, 0,
      { states: 1, cohorts: 1 });
    await rejects('own BoxSet rating denial precedes root resolution', () => library.getItemRecord(id(100), { user }),
      { status: 404, message: 'Item not found.' }, 0);
    for (const [number, name] of [[101, 'no links'], [102, 'typed empty membership']]) {
      const previous = nullRootPlans;
      assert.equal(idKey((await library.getItemRecord(id(number), { user })).Id), idKey(id(number)));
      assert.equal(nullRootPlans, previous); await unchanged(); report.cases.push({ name: name + ' bypasses root resolution', id: idKey(id(number)), rootReads: 0 });
    }
    for (const [number, name] of [[103, 'explicit nonempty membership'], [104, 'derived nonempty membership']]) {
      await rejects(name + ' reaches the real null-root failure', () => library.getItemRecord(id(number), { user }),
        { status: 500, nativeException: 'NullReferenceException' }, 1);
    }
    report.persistedAndStateBytesUnchanged = true;
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = [], attempt = async (name, operation) => { try { await operation(); report.cleanup[name] = true; } catch (error) { errors.push(error); report.cleanup[name] = describeError(error); } };
    if (originalPlan) library.options.linkedChildren.plan = originalPlan;
    rootOwner?.release();
    await attempt('libraryAndOwnedNavigationClosed', () => closeLibraryNavigation(library));
    await attempt('postgresSchemaAndConnectionClosed', () => dropPostgresTestDatabase(database));
    if (root) await attempt('privateStateRemoved', async () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mm-root-navigation-order-'));
      await rm(root, { recursive: true, force: false });
    });
    report.error = failure ? describeError(failure) : null;
    await writeFile(path.join(output, 'report.json'), stringifyNativeJson(report) + '\n');
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? 'Root order fixture cleanup failed.', failure ? { cause: failure } : undefined);
  }
});

// Each prefix owns a fresh database, relation runtime and exact root receiver.
// An earlier country fallback must not prepare Children for a later BoxSet.
const coldBoxSetPrefixes = [
  { name: 'own-country parental denial', rating: 'R', links: true, membership: 'nonempty', outcome: 'denied', rootReads: 0 },
  { name: 'own-country allowed empty links', rating: 'G', links: false, membership: 'nonempty', outcome: 'visible', rootReads: 0 },
  { name: 'own-country allowed typed empty membership', rating: 'G', links: true, membership: 'empty', outcome: 'visible', rootReads: 0 },
  { name: 'own-country allowed nonempty membership', rating: 'G', links: true, membership: 'nonempty', outcome: 'root-error', rootReads: 1 },
];

for (const control of coldBoxSetPrefixes) test(`real PostgreSQL cold modern BoxSet ${control.name} preserves Native root consumption`, {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'root-navigation-cold-boxset-' + randomUUID());
  await mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
    control, sourceBindings: [
      { path: 'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', lines: '50-65,155-202,233-247',
        consumer: 'A path below DataPath is modern even with no links; own parental access precedes empty links, empty membership and user root navigation.' },
      { path: 'MediaBrowser.Controller/Entities/BaseItem.cs', lines: '1806-1834,1865-1913,1951-1958',
        consumer: 'Empty tag policy and an explicit own country evaluate parental access without collection folders or UserRoot.Children.' },
      { path: 'MediaBrowser.Controller/Entities/Folder.cs', lines: '138-141,283-287',
        consumer: 'Children is a separate cold LoadChildren cache; a null linked relation is consumed only by later linked navigation.' },
      { path: 'MediaBrowser.Controller/Entities/UserRootFolder.cs', lines: '55-67',
        consumer: 'The first Children load also captures child identities; a new receiver must start with neither cache.' },
    ], observations: {}, cleanup: {} };
  let database, root, library, liveRoot, rootOwner, originalPlan, failure;
  let nullRootPlans = 0;
  try {
    database = await createPostgresTestDatabase(null, 'cold_boxset');
    root = await mkdtemp(path.join(os.tmpdir(), 'mm-root-cold-boxset-'));
    const media = path.join(root, 'media'), data = path.join(root, 'data'), metadata = path.join(root, 'metadata');
    const boxPath = path.join(data, 'collections', 'cold');
    for (const directory of [media, data, metadata]) await mkdir(directory);
    // Native IsLegacyBoxSet reads Path and raw link length first. The empty-link
    // control must remain below this exact DataPath instead of entering Folder.
    assert.ok(boxPath.startsWith(data + path.sep));
    const rootRow = row(1, 'UserRootFolder', { Data: '{"IsRoot":true}', Path: path.join(root, 'root', 'default') });
    const libraryFolderIds = control.membership === 'empty' ? [] : [id(10)];
    await database.insertBatch('BaseItems', [rootRow,
      row(2, 'AggregateFolder', { Data: '{"IsRoot":true}', Path: path.join(root, 'physical-root') }),
      row(10, 'CollectionFolder', { ParentId: id(1), Path: path.join(root, 'root', 'default', 'Movies'),
        PreferredMetadataCountryCode: 'US', Data: JSON.stringify({ CollectionType: 'movies', PhysicalLocationsList: [media] }) }),
      row(12, 'Folder', { ParentId: id(2), TopParentId: id(12), Path: media }),
      row(20, 'Movie', { ParentId: id(12), TopParentId: id(12), Path: path.join(media, 'member.mkv'), PreferredMetadataCountryCode: 'US' }),
      row(100, 'BoxSet', { Path: boxPath, PreferredMetadataCountryCode: 'US', OfficialRating: control.rating,
        InheritedParentalRatingValue: control.rating === 'R' ? 21 : 0,
        Data: JSON.stringify({ LibraryFolderIds: libraryFolderIds }) }),
    ]);
    if (control.links) await database.insertBatch('LinkedChildren', [
      { ParentId: id(100), ChildId: id(20), ChildType: 0, SortOrder: 0 },
    ]);
    library = new LibraryService({ store: new DomainStore(database), serverId: 'cold-boxset-order', fileSystem: testFileSystem,
      programDataPath: root, dataPath: data, metadataPath: metadata, userRoot: rootRow,
      configuration: { MetadataCountryCode: 'US', CacheSize: 64 } });
    await attachLibraryNavigation(library);
    liveRoot = await library.itemCreation.getItemById(id(1));
    rootOwner = library.itemCreation.retainItem(liveRoot);
    // A real nullable live property is authoritative over the persisted empty
    // relation. The observing wrapper delegates to the actual SQL link reader.
    liveRoot.LinkedChildren = null;
    await library.options.linkedChildren.flushReleases();
    const links = library.options.linkedChildren;
    originalPlan = links.plan;
    links.plan = function (handle) { if (handle === null) nullRootPlans++; return originalPlan.call(this, handle); };
    const user = { Id: id(900), Username: 'Cold BoxSet reader', MaxParentalRatingScore: 5, MaxParentalRatingSubScore: null,
      Configuration: {}, Policy: { EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
    const snapshot = async () => ({
      rows: await database.rows('BaseItems', { orderBy: [{ column: 'Id', direction: 'ASC' }] }),
      links: await database.rows('LinkedChildren', { orderBy: [{ column: 'ParentId', direction: 'ASC' }, { column: 'SortOrder', direction: 'ASC' }] }),
      files: await files(root),
    });
    const cacheState = async () => ({ ...(await database.client.query(`SELECT
      (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states,
      (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts,
      (SELECT count(*) FROM ${q(links.schemaName)}.folder_child_ids)::integer AS "childIds"`)).rows[0],
      assignedChildren: cachedFolderChildrenSnapshot(liveRoot) !== undefined,
      childIdCache: postgresFolderChildIds(liveRoot) !== null,
    });
    const before = await snapshot();
    report.fixture = { databaseSchema: database.schemaName, relationSchema: links.schemaName, rootId: liveRoot.Id,
      boxPath, dataPath: data, preferredCountry: 'US', libraryFolderIds, rawLinkCount: control.links ? 1 : 0,
      rootLinkedChildren: liveRoot.LinkedChildren };
    report.observations.before = { cache: await cacheState(), nullRootPlans };
    assert.deepEqual(report.observations.before, { cache: { states: 0, cohorts: 0, childIds: 0,
      assignedChildren: false, childIdCache: false }, nullRootPlans: 0 }, 'Each BoxSet prefix starts before any actual root Children consumption.');

    let visibleItem, operationError;
    try { visibleItem = await library.getItemRecord(id(100), { user }); }
    catch (error) { operationError = error; }
    // Preserve actual observations before asserting the cold-prefix contract so
    // a red run still publishes the unwanted cache population and exact error.
    report.observations.after = { cache: await cacheState(), nullRootPlans,
      returnedId: visibleItem?.Id ?? null, error: operationError ? describeError(operationError) : null };
    report.observations.persistedAndFilesUnchanged = false;
    assert.equal(library.itemCreation.getCachedItemById(id(1)), liveRoot);
    assert.equal(liveRoot.LinkedChildren, null);
    assert.deepEqual(await snapshot(), before, 'Only the actual root cache may change; persisted input and private files stay unchanged.');
    report.observations.persistedAndFilesUnchanged = true;
    if (control.outcome === 'visible') {
      if (operationError) throw operationError;
      assert.equal(idKey(visibleItem.Id), idKey(id(100)));
    } else if (control.outcome === 'denied') {
      assert.ok(operationError, 'Own parental denial must reject the real item read.');
      assert.equal(operationError.status, 404);
      assert.equal(operationError.message, 'Item not found.');
    } else {
      assert.ok(operationError, 'Nonempty membership must reach the real null root relation.');
      assert.equal(operationError.status, 500);
      assert.equal(operationError.nativeException, 'NullReferenceException');
    }
    assert.equal(nullRootPlans, control.rootReads);
    assert.deepEqual(report.observations.after.cache, control.rootReads === 0
      ? { states: 0, cohorts: 0, childIds: 0, assignedChildren: false, childIdCache: false }
      : { states: 1, cohorts: 1, childIds: 1, assignedChildren: false, childIdCache: true },
    'Only the nonempty-membership positive control consumes and caches the exact root Children.');
    report.nativePrefixPreserved = true;
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = [], attempt = async (name, operation) => { try { await operation(); report.cleanup[name] = true; } catch (error) { errors.push(error); report.cleanup[name] = describeError(error); } };
    if (originalPlan) library.options.linkedChildren.plan = originalPlan;
    rootOwner?.release();
    await attempt('libraryAndOwnedNavigationClosed', () => closeLibraryNavigation(library));
    await attempt('postgresSchemaAndConnectionClosed', () => dropPostgresTestDatabase(database));
    if (root) await attempt('privateStateRemoved', async () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mm-root-cold-boxset-'));
      await rm(root, { recursive: true, force: false });
    });
    report.error = failure ? describeError(failure) : null;
    await writeFile(path.join(output, 'report.json'), stringifyNativeJson(report) + '\n');
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? 'Cold BoxSet order fixture cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
