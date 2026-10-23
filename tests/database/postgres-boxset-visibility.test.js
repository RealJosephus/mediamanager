import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { idKey } from '../../src/library/records.js';
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { postgresExpandedPathKeyFunctionName, postgresCollectionFolderMatchFunctionName,
  postgresNativeJsonGuidKeyFunctionName } from '../../src/database/postgres-runtime-schema.js';
import { createPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from './postgres-fixture.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const id = number => `e8520000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const guidX = value => {
  const compact = idKey(value);
  return `{0x${compact.slice(0, 8)},0x${compact.slice(8, 12)},0x${compact.slice(12, 16)},{${compact.slice(16).match(/../gu).map(part => '0x' + part).join(',')}}}`;
};
const projection = (Id, values = {}) => ({ Id, OfficialRating: 'G', CustomRating: null, LibraryFolderIds: null, ...values });
const type = kind => `MediaBrowser.Controller.Entities.${kind === 'BoxSet' ? 'Movies.BoxSet' : kind === 'Movie' ? 'Movies.Movie' : kind}`;
const base = (number, kind, values = {}) => postgresTestRow('BaseItems', {
  Id: id(number), Type: type(kind), Name: `${kind} ${number}`, SortName: String(number).padStart(6, '0'),
  PresentationUniqueKey: id(number), IsFolder: kind !== 'Movie', OfficialRating: 'G', InheritedParentalRatingValue: 0,
  MediaType: kind === 'Movie' ? 'Video' : 'Unknown', Data: '{}', ...values,
});
const options = (values = {}) => ({
  userId: id(900), includeOwnedItems: true, includeAlternateVersions: true, resumableMode: 'repository',
  visibility: { itemMode: 'standalone', scopeTopParentAccess: false, boxSetStandalone: true,
    boxSetChildRatingMode: 'memory',
    boxSetUserRootIds: [id(11), id(19)], topParentIds: [id(11), id(13)],
    boxSetRootFolders: [
      { Id: id(10), Path: '/root/A', PhysicalLocations: ['/media/A'] },
      { Id: id(11), Path: '/root/B', PhysicalLocations: ['/media/B'] },
    ],
    boxSetPathExpansion: { appDataPath: '/expanded/data', metadataPath: '/expanded/metadata' },
    libraryTopParentIds: [id(10), id(11), id(12), id(13)],
    ratingContext: { defaultCountry: 'US', folders: [] }, ...values },
});

test('native visibility input has complete nullable fields, canonical unique identities and a 128-item boundary', () => {
  const database = { dialect: 'postgres', schemaName: 'media' }, query = { ids: [id(100)], limit: 1 };
  const make = entries => buildPostgresItemPageQuery(database, query,
    { ...options(), nativeVisibilityProjections: entries });
  for (const entries of [
    [projection(id(100)), projection(idKey(id(100)).toUpperCase())],
    [projection(id(100)), projection('{' + id(100) + '}')],
    [projection('e8-520000-0000-0000-0000-000000000100')],
    [{ Id: id(100), OfficialRating: 'G', LibraryFolderIds: null }],
    [projection(id(100), { CustomRating: undefined })], [projection(id(100), { CustomRating: 0 })],
    [projection(id(100), { LibraryFolderIds: ['not-a-guid'] })],
    Array.from({ length: 129 }, (_, index) => projection(id(1000 + index))),
  ]) assert.throws(() => make(entries), TypeError);
  assert.doesNotThrow(() => make(Array.from({ length: 128 }, (_, index) => projection(id(1000 + index)))));
  assert.throws(() => buildPostgresItemPageQuery(database, query,
    { nativeVisibilityProjections: [projection(id(100))] }), /standalone visibility/u);
  const { boxSetUserRootIds: _omitted, ...incomplete } = options().visibility;
  assert.throws(() => buildPostgresItemPageQuery(database, query, { visibility: incomplete }), /actual visible user-root/u);
  assert.doesNotThrow(() => buildPostgresItemPageQuery(database, query, {
    visibility: { ...incomplete, boxSetRootLookup: 'children' },
  }));
  assert.throws(() => buildPostgresItemPageQuery(database, query, {
    visibility: { boxSetRootLookup: 'children' },
  }), /requires standalone BoxSet/u);
  for (const value of [null, 0, true, false, 'true']) assert.throws(() => buildPostgresItemPageQuery(database, query,
    options({ boxSetRootLookup: value })), /must be folders or children/u);
  assert.throws(() => buildPostgresItemPageQuery(database, query,
    options({ boxSetPathExpansion: { appDataPath: '/data' } })), /complete typed appDataPath/u);
  assert.doesNotThrow(() => buildPostgresItemPageQuery(database, query, options({
    boxSetRootFolders: [{ Id: id(10), Path: '\ud800\0\u0001', PhysicalLocations: ['\udfff', '\ud801\udc28'] }],
    boxSetPathExpansion: { appDataPath: '\ud800\0', metadataPath: '\ud801\udc00' },
  })));
});

test('real PostgreSQL BoxSet visibility preserves stored/live null, empty and explicit LibraryFolderIds before SQL paging', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'boxset_live_vis');
  const functionCall = name => `${quoteIdentifier(database.schemaName)}.${quoteIdentifier(name)}`;
  const observations = [];
  const sourceBindings = [
    { path: 'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', consumer: 'IsVisible: IsParentalAllowed, LinkedChildren, nullable LibraryFolderIds, GetChildren(user,true), then child parental access' },
    { path: 'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', consumer: 'BuildMaxParentalRatingFilter checks manual member inherited ratings independently of later standalone library membership' },
    { path: 'MediaBrowser.Controller/Entities/BaseItem.cs', consumer: 'IsParentalAllowed and CustomRatingForComparison/OfficialRatingForComparison' },
    { path: 'Emby.Server.Implementations/Localization/LocalizationManager.cs', consumer: 'GetSingleRatingScore converts string zero to numeric score zero; unknown custom ratings do not fall back to the official rating' },
    { path: 'MediaBrowser.Controller/Entities/Folder.cs', consumer: 'GetChildren(user,true) produces the supplied actual user-root identities' },
    { path: 'Emby.Server.Implementations/Library/LibraryManager.cs', consumer: 'GetCollectionFolders follows Parent/Owner and compares raw user-root folder Path/PhysicalLocations' },
    { path: 'src/Jellyfin.Extensions/EnumerableExtensions.cs', consumer: 'Contains checks null source after nullable Path equality; span null and empty compare equally' },
    { path: 'Emby.Server.Implementations/ApplicationHost.cs', consumer: 'ExpandVirtualPath replaces all Data tokens before all Metadata tokens using OrdinalIgnoreCase' },
    { path: 'src/Jellyfin.Extensions/Json/Converters/JsonGuidConverter.cs', consumer: 'ReadInternal calls Guid.Parse on the JSON string, preserving N/D/B/P/X format acceptance and malformed-format rejection' },
  ];
  const report = { schemaVersion: 1, sourceBindings, nativeExecutedByThisTest: false, observations,
    actualNativeEvidence: 'The independent item-collections-current HTTP recorder runs actual native BoxSet/LibraryManager and supplies warm-state cases; this SQL component test does not claim to execute native code.',
    projectionsCover: ['OfficialRating', 'CustomRating', 'LibraryFolderIds'],
    projectionsDoNotClaimAllUnsavedEntityState: true, phaseAcceptance: false, releaseAcceptance: false };
  await database.insertBatch('BaseItems', [
    base(1, 'AggregateFolder'), base(10, 'CollectionFolder'), base(11, 'CollectionFolder'),
    base(999, 'Folder', { Type: 'PLACEHOLDER', IsFolder: false, OfficialRating: 'R', InheritedParentalRatingValue: 21 }),
    base(12, 'Folder', { ParentId: id(1), Path: '/media/A' }), base(13, 'Folder', { ParentId: id(1), Path: '/media/B' }),
    base(19, 'Movie'), // Explicit LibraryFolderIds can name a non-folder root child.
    base(20, 'Movie', { ParentId: id(12), TopParentId: id(12), Path: '/media/A/g.mkv' }),
    base(21, 'Movie', { ParentId: id(12), TopParentId: id(12), Path: '/media/A/r.mkv', OfficialRating: 'R', InheritedParentalRatingValue: 21 }),
    base(22, 'Movie', { Path: '/neutral/outside.mkv' }),
    base(23, 'Folder', { OfficialRating: 'R', InheritedParentalRatingValue: 21 }),
    base(24, 'Movie', { ParentId: id(13), TopParentId: id(12), Path: '/media/B/actual-b.mkv' }),
    base(25, 'Movie', { ParentId: id(12), TopParentId: id(13), Path: '/media/A/actual-a.mkv' }),
    base(26, 'Movie', { ParentId: id(999), OwnerId: id(13), TopParentId: id(12), Path: '/neutral/owner-b.mkv' }),
    base(27, 'Movie', { ParentId: id(12), OwnerId: id(13), TopParentId: id(13), Path: '/neutral/parent-a.mkv' }),
    base(28, 'Movie', { ParentId: id(1), OwnerId: id(12), TopParentId: id(12), Path: '/media/B' }),
    base(29, 'Movie', { TopParentId: id(13), Path: '/MEDIA/a' }),
    base(30, 'Folder', { ParentId: id(1), Path: '%aPpDaTaPaTh%/A' }),
    base(31, 'Folder', { ParentId: id(1), Path: '%mEtAdAtApAtH%/B' }),
    base(32, 'Movie', { ParentId: id(30), Path: '/not-the-root/movie.mkv' }),
    base(33, 'Movie', { ParentId: id(31), Path: '/not-the-root/other.mkv' }),
    base(34, 'Movie', { Path: '/media/A\0x' }),
    base(35, 'Movie', { Path: '/media/A\u0001x' }),
    base(36, 'Movie', { Path: '/media/A\ufffd' }),
  ]);
  const stored = [
    [100, null], [101, []], [102, [id(10)]], [103, [id(11)]], [104, [id(19)]],
    [105, []], [106, [id(11)]], [107, null], [108, []], [109, null], [110, [id(999)]],
    ...Array.from({ length: 6 }, (_, index) => [111 + index, null]),
    ...Array.from({ length: 5 }, (_, index) => [117 + index, null]),
    [122, [id(11)]],
    ...[idKey(id(11)).toUpperCase(), id(11).toUpperCase(), '{' + id(11) + '}', '(' + id(11) + ')', guidX(id(11))]
      .map((value, index) => [200 + index, [value]]),
  ];
  await database.insertBatch('BaseItems', stored.map(([number, LibraryFolderIds]) => base(number, 'BoxSet', {
    Data: JSON.stringify({ LibraryFolderIds }),
    ...(number === 108 ? { OfficialRating: 'R', InheritedParentalRatingValue: 21 } : {}),
    ...(number === 109 ? { ParentId: id(23) } : {}),
  })));
  const links = stored.filter(([number]) => number !== 109).map(([number]) => ({
    ParentId: id(number), ChildId: id(number === 122 ? 999 : number >= 117 && number <= 121 ? number - 85
      : number >= 111 && number <= 116 ? number - 87 : [105, 106].includes(number) ? 21 : number === 107 ? 22 : 20), ChildType: 0, SortOrder: 0,
  }));
  await database.insertBatch('LinkedChildren', links);
  const persistedRows = async () => (await database.rows('BaseItems', { whereIn: { Id: stored.map(([number]) => id(number)) } }))
    .sort((a, b) => idKey(a.Id).localeCompare(idKey(b.Id)));
  const before = await persistedRows();
  const observe = async (name, numbers, expected, { live = null, visibility = {}, startIndex = 0, limit = 128 } = {}) => {
    const configuration = options(visibility);
    if (live !== null) configuration.nativeVisibilityProjections = live;
    const result = await queryPostgresItemPage(database, { ids: numbers.map(id), startindex: startIndex, limit }, configuration);
    const actual = result.rows.map(row => idKey(row.Id));
    observations.push({ name, numbers, expected: expected.map(idKey), actual, total: result.total, startIndex: result.startIndex,
      live, planSha256: createHash('sha256').update(result.plan.text).digest('hex') });
    assert.deepEqual(actual, expected.map(idKey), name); return result;
  };
  try {
    await observe('standalone empty membership bypasses its own later child rating consumer', [105], [id(105)], {
      visibility: { maxRating: 5, boxSetChildRatingMode: 'memory' },
    });
    await observe('repository member rating remains required before standalone empty membership', [105], [], {
      visibility: { maxRating: 5, boxSetChildRatingMode: 'both' },
    });
    const folders = await observe('raw-folder lookup keeps unknown membership unresolved after the own parental and link prefix',
      [20, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 122],
      [100, 102, 103, 104, 106, 107, 110, 122].map(id), {
        visibility: { maxRating: 5, boxSetRootLookup: 'folders', boxSetUserRootIds: undefined,
          boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
      });
    assert.equal(folders.total, 8);
    await observe('raw-folder lookup rejects own rating before considering unknown membership', [100], [], {
      live: [projection(id(100), { OfficialRating: 'R' })],
      visibility: { maxRating: 5, boxSetRootLookup: 'folders', boxSetUserRootIds: undefined,
        boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
    });
    await observe('raw-folder lookup skips empty links and explicit empty membership without reading raw folders', [100, 109], [], {
      live: [projection(id(100), { LibraryFolderIds: [] }), projection(id(109), { LibraryFolderIds: [id(11)] })],
      visibility: { maxRating: 5, boxSetRootLookup: 'folders', boxSetUserRootIds: undefined,
        boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
    });
    const lookup = await observe('root lookup preflight returns only own-allowed nonempty memberships with raw links',
      [20, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 122],
      [100, 102, 103, 104, 106, 110, 122].map(id), {
        visibility: { maxRating: 5, boxSetRootLookup: 'children', boxSetUserRootIds: undefined },
      });
    assert.equal(lookup.total, 7);
    await observe('root lookup preflight does not consume user-root identities or later child parental checks', [106], [id(106)], {
      visibility: { maxRating: 5, boxSetChildRatingMode: 'both', boxSetRootLookup: 'children',
        boxSetUserRootIds: ['not-an-observed-root-guid'] },
    });
    await observe('own parental denial precedes null raw-root source in lookup preflight', [100], [], {
      live: [projection(id(100), { OfficialRating: 'R' })],
      visibility: { maxRating: 5, boxSetRootLookup: 'children', boxSetUserRootIds: undefined,
        boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
    });
    await observe('no raw links and typed empty membership avoid root lookup and null source', [100, 109], [], {
      live: [projection(id(100), { LibraryFolderIds: [] }), projection(id(109), { LibraryFolderIds: [id(11)] })],
      visibility: { maxRating: 5, boxSetRootLookup: 'children', boxSetUserRootIds: undefined,
        boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
    });
    await observe('live null membership still derives a nonempty lookup before root access', [103], [id(103)], {
      live: [projection(id(103))], visibility: { boxSetRootLookup: 'children', boxSetUserRootIds: undefined },
    });
    await assert.rejects(queryPostgresItemPage(database, { ids: [id(100)], limit: 1 }, options({
      boxSetRootLookup: 'children', boxSetUserRootIds: undefined,
      boxSetRootFolders: [{ Id: id(10), Path: '/media/A', PhysicalLocations: [] },
        { Id: id(11), Path: '/different', PhysicalLocations: null }],
    })), error => error.status === 400 && error.nativeException === 'ArgumentNullException' && error.parameterName === 'source');
    observations.push({ name: 'lookup preflight consumes every raw-folder comparison before root access', nativeException: 'ArgumentNullException', status: 400 });
    const membership = await observe('stored nonnull identities override child membership; null derives it', [100, 101, 102, 103, 104], [id(101), id(103), id(104)]);
    assert.equal(membership.total, 3);
    await observe('an unresolved placeholder is absent from linked-child parental checks', [122], [id(122)], {
      visibility: { maxRating: 5 },
    });
    await observe('derived parent and owner roots override conflicting TopParentId and use raw OIC paths',
      [111, 112, 113, 114, 115, 116], [id(111), id(113), id(115)]);
    await observe('persisted Data token expands to the typed root path before matching', [117], [], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/EXPANDED/data/A', PhysicalLocations: [] }] },
    });
    await observe('persisted Metadata token expands to typed physical locations', [118], [], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: ['/expanded/metadata/B'] }] },
    });
    await observe('Data replacement containing Metadata token is expanded in the second phase', [117], [], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/expanded/metadata/data/A', PhysicalLocations: [] }],
        boxSetPathExpansion: { appDataPath: '%MetadataPath%/data', metadataPath: '/expanded/metadata' } },
    });
    await observe('typed and stored NUL path bytes remain a real hidden membership', [119], [], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/media/A\0x', PhysicalLocations: [] }] },
    });
    await observe('typed and stored SOH path bytes cannot alias projection escape text', [120], [], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: ['/media/A\u0001x'] }] },
    });
    await observe('isolated UTF16 surrogate in a typed path never aliases replacement character', [121], [id(121)], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/media/A\ud800', PhysicalLocations: [] }] },
    });
    await observe('physical policy access cannot grant a folder removed from actual visible root children', [100], [], {
      visibility: { topParentIds: [id(10), id(11), id(12), id(13)] },
    });
    await observe('empty stored array bypasses child rating but never own rating', [105, 106, 108], [id(105)], { visibility: { maxRating: 5 } });
    await observe('null inferred membership empty bypasses child rating', [107], [id(107)], { visibility: { maxRating: 5 } });
    await observe('live empty array supersedes stored null', [100], [id(100)], { live: [projection(id(100), { LibraryFolderIds: [] })] });
    await observe('live null restores derivation instead of falling back to stored explicit IDs', [103], [], { live: [projection(id(103))] });
    await observe('stored unknown root identity does not use descendant membership', [110], []);
    const guidFormats = [idKey(id(11)).toUpperCase(), id(11).toUpperCase(), '{' + id(11) + '}', '(' + id(11) + ')', guidX(id(11))];
    for (const [index, spelling] of guidFormats.entries()) {
      const format = ['N', 'D', 'B', 'P', 'X'][index];
      const actual = (await database.client.query(`SELECT ${functionCall(postgresNativeJsonGuidKeyFunctionName)}($1::json) AS key`,
        [JSON.stringify(spelling)])).rows[0].key;
      assert.equal(actual, idKey(id(11)), format + ' native JSON GUID reader');
      observations.push({ name: 'native JSON GUID reader ' + format, spelling, actual, expected: idKey(id(11)) });
      await observe('stored typed GUID array ' + format, [200 + index], [id(200 + index)]);
    }
    const invalidX = guidX(id(11)).slice(0, -1);
    await assert.rejects(database.client.query(`SELECT ${functionCall(postgresNativeJsonGuidKeyFunctionName)}($1::json)`,
      [JSON.stringify(invalidX)]), { code: 'MM001' });
    observations.push({ name: 'X spelling missing its outer closing brace remains invalid', spelling: invalidX, errorCode: 'MM001' });
    await observe('stored typed GUID arrays consume N D B P X forms using the native JSON Guid reader',
      [200, 201, 202, 203, 204], [200, 201, 202, 203, 204].map(id));
    await observe('live unknown root identity does not fall back to stored empty array', [101], [], {
      live: [projection(id(101), { LibraryFolderIds: [id(999)] })],
    });
    await assert.rejects(queryPostgresItemPage(database, { ids: [id(100)], limit: 1 }, options({
      boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }],
    })), error => error.status === 400 && error.nativeException === 'ArgumentNullException' && error.parameterName === 'source');
    observations.push({ name: 'raw inaccessible folder null PhysicalLocations preserves late native source error', nativeException: 'ArgumentNullException', status: 400 });
    await assert.rejects(queryPostgresItemPage(database, { ids: [id(100)], limit: 1 }, options({
      boxSetUserRootIds: [id(10)], boxSetRootFolders: [
        { Id: id(10), Path: '/media/A', PhysicalLocations: [] },
        { Id: id(11), Path: '/different', PhysicalLocations: null },
      ],
    })), error => error.status === 400 && error.nativeException === 'ArgumentNullException' && error.parameterName === 'source');
    observations.push({ name: 'a matching raw root cannot skip a later mismatching null source', nativeException: 'ArgumentNullException', status: 400 });
    await observe('own parental denial precedes raw-root null source consumption', [100], [], {
      live: [projection(id(100), { OfficialRating: 'R' })],
      visibility: { maxRating: 5, boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
    });
    await observe('no links and explicit empty membership precede raw-root null source consumption', [101, 109], [id(101), id(109)], {
      visibility: { boxSetRootFolders: [{ Id: id(10), Path: '/different', PhysicalLocations: null }] },
    });
    const keyHex = value => value === null ? null : Buffer.from(ordinalIgnoreCaseKey(value), 'utf16le').swap16().toString('hex');
    const hiddenByteToken = '\u1200' + [...'%APPDATAPATH%'].map(character => String.fromCharCode(character.charCodeAt(0) << 8)).join('');
    const keyCases = [
      { name: 'all repeated tokens expand', source: '%appdatapath%/%APPDATAPATH%/%metadatapath%', data: '/d', metadata: '/m', expected: '/d//d//m' },
      { name: 'token bytes at an odd codeunit boundary do not match', source: hiddenByteToken, data: '/d', metadata: '/m', expected: hiddenByteToken },
      { name: 'replacement keeps isolated and paired UTF16 units', source: '%appdatapath%/%MetadataPath%', data: '\ud800\0', metadata: '\ud801\udc28', expected: '\ud800\0/\ud801\udc28' },
    ];
    for (const sample of keyCases) {
      const result = await database.client.query(`SELECT encode(${functionCall(postgresExpandedPathKeyFunctionName)}($1::bytea,$2::jsonb),'hex') AS key`,
        [nativeTextBytes(sample.source), JSON.stringify([keyHex(sample.data), keyHex(sample.metadata)])]);
      assert.equal(result.rows[0].key, keyHex(sample.expected), sample.name);
      observations.push({ name: sample.name, actualKeyHex: result.rows[0].key, expectedKeyHex: keyHex(sample.expected) });
    }
    for (const [name, input, expected] of [
      ['nullable Path equality skips null source', [null, null, null], true],
      ['span null equals an empty location', [null, keyHex('/different'), ['']], true],
      ['span empty equals a null location', ['', keyHex('/different'), [null]], true],
      ['isolated UTF16 units compare without replacement', [keyHex('\ud800'), keyHex('\ufffd'), [keyHex('\ud800')]], true],
      ['surrogate pair retains native OIC scalar mapping', [keyHex('\ud801\udc28'), keyHex('\ud801\udc00'), null], true],
    ]) {
      const result = await database.client.query(`SELECT ${functionCall(postgresCollectionFolderMatchFunctionName)}($1::jsonb) AS matched`, [JSON.stringify(input)]);
      assert.equal(result.rows[0].matched, expected, name); observations.push({ name, matched: result.rows[0].matched });
    }
    await observe('live nonempty IDs supersede stored empty early return', [105], [], {
      live: [projection(id(105), { LibraryFolderIds: [id(11)] })], visibility: { maxRating: 5 },
    });
    await observe('live empty membership bypasses child rating', [106], [id(106)], {
      live: [projection(id(106), { LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await observe('live own official rating is still checked before empty membership', [101], [], {
      live: [projection(id(101), { OfficialRating: 'R', LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await observe('an unknown projection identity cannot change another row or its count', [101], [id(101)], {
      live: [projection(id(999), { OfficialRating: 'R', LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await observe('live custom rating overrides higher stored official rating', [108], [id(108)], {
      live: [projection(id(108), { OfficialRating: 'R', CustomRating: 'G', LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await observe('live CustomRating string zero overrides stored R with actual numeric score zero', [108], [id(108)], {
      live: [projection(id(108), { OfficialRating: 'R', CustomRating: '0', LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await observe('known numeric score zero is allowed even when unrated Movies are blocked', [108], [id(108)], {
      live: [projection(id(108), { OfficialRating: 'R', CustomRating: '0', LibraryFolderIds: [] })],
      visibility: { maxRating: 5, blockUnratedTypes: ['Movie'] },
    });
    await observe('unknown live custom rating is not a stored R fallback', [108], [id(108)], {
      live: [projection(id(108), { OfficialRating: 'R', CustomRating: 'not-a-rating', LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await observe('unknown live custom rating still respects BlockUnratedItems', [108], [], {
      live: [projection(id(108), { OfficialRating: 'R', CustomRating: 'not-a-rating', LibraryFolderIds: [] })],
      visibility: { maxRating: 5, blockUnratedTypes: ['Movie'] },
    });
    await observe('explicit null live ratings inherit the actual parent instead of stored G', [109], [], {
      live: [projection(id(109), { OfficialRating: null, LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await database.update('BaseItems', { Id: id(108) }, { CustomRating: 'G' });
    await observe('explicit null live custom clears stored permissive override', [108], [], {
      live: [projection(id(108), { OfficialRating: 'R', CustomRating: null, LibraryFolderIds: [] })], visibility: { maxRating: 5 },
    });
    await database.update('BaseItems', { Id: id(108) }, { CustomRating: null });
    assert.deepEqual(await persistedRows(), before,
      'SQL visibility projections must not write their live values back to BaseItems.');
    report.persistentRowsUnchanged = true;

    // The complete count remains in SQL and the consumer hydrates <=128 rows.
    const bulk = Array.from({ length: 131 }, (_, index) => base(1000 + index, 'BoxSet', { Data: '{"LibraryFolderIds":[]}' }));
    await database.insertBatch('BaseItems', bulk);
    const first = await observe('131-row SQL count first bounded page', bulk.map((_, index) => 1000 + index),
      bulk.slice(0, 128).map(row => row.Id));
    const last = await observe('131-row SQL count last bounded page', bulk.map((_, index) => 1000 + index),
      bulk.slice(128).map(row => row.Id), { startIndex: 128 });
    const zero = await observe('zero page preserves full visible SQL count', bulk.map((_, index) => 1000 + index), [], { limit: 0 });
    assert.equal(first.total, 131); assert.equal(first.rows.length, 128);
    assert.equal(last.total, 131); assert.equal(last.rows.length, 3); assert.equal(zero.total, 131);
  } finally {
    const output = path.join(validationOutputRoot(), 'postgres-boxset-visibility'); assertValidationOutputChild(output);
    await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
});
