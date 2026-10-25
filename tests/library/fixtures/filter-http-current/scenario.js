// The request matrices retain the original neutral inputs. Native observations are captured anew.
const OFFICIAL_RATING_CASES = [
  { name: 'pg13', query: 'OfficialRatings=PG-13' },
  { name: 'r', query: 'OfficialRatings=R' },
  { name: 'pg13-or-r-pipe', query: 'OfficialRatings=PG-13%7CR' },
  { name: 'pg13-or-r-comma', query: 'OfficialRatings=PG-13,R' },
  { name: 'case-insensitive', query: 'OfficialRatings=pg-13' },
  { name: 'unknown', query: 'OfficialRatings=Unclassified' },
  { name: 'empty-omitted', query: 'OfficialRatings=' },
  { name: 'whitespace', query: 'OfficialRatings=%20' },
  { name: 'repeated-values', query: 'OfficialRatings=PG-13&OfficialRatings=R' },
  { name: 'repeated-empty', query: 'OfficialRatings=&OfficialRatings=' },
  { name: 'rating-then-empty', query: 'OfficialRatings=PG-13&OfficialRatings=' },
  { name: 'empty-then-rating', query: 'OfficialRatings=&OfficialRatings=R' },
  { name: 'pg13-only-scope', query: 'OfficialRatings=PG-13', scope: ['pg13'] },
  { name: 'r-only-scope', query: 'OfficialRatings=R', scope: ['r'] },
  { name: 'unrated-only-scope', query: 'OfficialRatings=', scope: ['empty'] },
  { name: 'physical-descendant-boundary', query: 'OfficialRatings=PG-13', scope: ['physicalRoot', 'pg13', 'empty'] },
  { name: 'aggregate-descendant-boundary', query: 'OfficialRatings=R', scope: ['aggregateRoot', 'physicalRoot', 'r'] },
];

const OFFICIAL_RATING_RANGE_CASES = [
  { name: 'minimum-pg13', query: 'MinOfficialRating=PG-13' },
  { name: 'minimum-tv14', query: 'MinOfficialRating=TV-14' },
  { name: 'minimum-tv14d', query: 'MinOfficialRating=TV-14-D' },
  { name: 'minimum-r', query: 'MinOfficialRating=R' },
  { name: 'maximum-pg13', query: 'MaxOfficialRating=PG-13' },
  { name: 'maximum-tv14', query: 'MaxOfficialRating=TV-14' },
  { name: 'maximum-tv14d', query: 'MaxOfficialRating=TV-14-D' },
  { name: 'maximum-r', query: 'MaxOfficialRating=R' },
  { name: 'bounded-tv14', query: 'MinOfficialRating=TV-14&MaxOfficialRating=TV-14' },
  { name: 'has-rating-true', query: 'HasParentalRating=true' },
  { name: 'has-rating-false', query: 'HasParentalRating=false' },
  { name: 'has-false-with-maximum', query: 'HasParentalRating=false&MaxOfficialRating=PG-13' },
  { name: 'invalid-minimum', query: 'MinOfficialRating=INVALID' },
  { name: 'invalid-maximum', query: 'MaxOfficialRating=INVALID' },
  { name: 'empty-minimum', query: 'MinOfficialRating=' },
  { name: 'repeated-minimum-first', query: 'MinOfficialRating=TV-14-D&MinOfficialRating=R' },
  { name: 'numeric-minimum', query: 'MinOfficialRating=14' },
  { name: 'numeric-maximum', query: 'MaxOfficialRating=14' },
  { name: 'block-unrated-has-false', query: 'HasParentalRating=false', blockUnrated: ['Movie'] },
  { name: 'block-unrated-maximum', query: 'MaxOfficialRating=TV-14', blockUnrated: ['Movie'] },
];

const TAG_CASES = [
  { name: 'alpha', query: 'Tags=Alpha' },
  { name: 'beta', query: 'Tags=Beta' },
  { name: 'shared', query: 'Tags=Shared' },
  { name: 'accented', query: 'Tags=Caf%C3%A9' },
  { name: 'clean-accent', query: 'Tags=Cafe' },
  { name: 'case-insensitive', query: 'Tags=alpha' },
  { name: 'column-only', query: 'Tags=ColumnOnly' },
  { name: 'stored-column-value', query: 'Tags=StoredA' },
  { name: 'pipe-values', query: 'Tags=Alpha%7CBeta' },
  { name: 'comma-value', query: 'Tags=Alpha,Beta' },
  { name: 'unknown', query: 'Tags=Missing' },
  { name: 'empty-omitted', query: 'Tags=' },
  { name: 'repeated-values', query: 'Tags=Alpha&Tags=Beta' },
  { name: 'repeated-empty', query: 'Tags=&Tags=' },
  { name: 'value-then-empty', query: 'Tags=Alpha&Tags=' },
  { name: 'empty-then-value', query: 'Tags=&Tags=Alpha' },
  { name: 'whitespace', query: 'Tags=%20' },
];

const RATING_PERMISSION_CASES = [
  { label: 'unrestricted', maxRating: null, blockUnrated: [] },
  { label: 'maximum-nine', maxRating: 9, blockUnrated: [] },
  { label: 'maximum-ten', maxRating: 10, blockUnrated: [] },
  { label: 'maximum-ten-block-unrated', maxRating: 10, blockUnrated: ['Movie'] },
].flatMap(policy => ['alpha', 'beta', 'gamma'].map(detailKey => ({
  name: `${policy.label}-${detailKey}`,
  query: 'IncludeItemTypes=Movie',
  detailKey,
  maxRating: policy.maxRating,
  blockUnrated: policy.blockUnrated,
  detailExpectedStatus: policy.label === 'unrestricted' ? 200 : 404,
  endpoints: ['items', 'legacy', 'detail'],
})));

const TAG_PERMISSION_CASES = [
  { label: 'unrestricted', allowedTags: [], blockedTags: [] },
  { label: 'allow-family', allowedTags: ['Family'], blockedTags: [] },
  { label: 'allow-missing', allowedTags: ['Missing'], blockedTags: [] },
  { label: 'block-blocked', allowedTags: [], blockedTags: ['blocked'] },
].flatMap(policy => ['alpha', 'beta', 'gamma', 'nested'].map(detailKey => ({
  name: `${policy.label}-${detailKey}`,
  query: 'IncludeItemTypes=Movie',
  detailKey,
  allowedTags: policy.allowedTags,
  blockedTags: policy.blockedTags,
  detailExpectedStatus: policy.label === 'allow-missing'
    || (policy.label === 'block-blocked' && detailKey !== 'alpha') ? 404 : 200,
  endpoints: ['items', 'legacy', 'detail'],
})));

export const catalog = {
  classification: {
    fixture: 'tests/library/fixtures/classification-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'non-root',
    expectedRecords: 48,
  },
  'extra-placeholder': {
    fixture: 'tests/library/fixtures/extra-placeholder-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'non-root',
    expectedRecords: 36,
  },
  'image-type': {
    fixture: 'tests/library/fixtures/image-type-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'all',
    expectedRecords: 40,
  },
  'navigation-date': {
    fixture: 'tests/library/fixtures/navigation-date-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'non-root',
    expectedRecords: 40,
    recordExpectedStatus: true,
  },
  'official-ratings': {
    fixture: 'tests/library/fixtures/official-rating-filters/input.json',
    fields: 'SortName',
    recordScope: 'scopeIds',
    defaultScope: 'movies',
    cases: OFFICIAL_RATING_CASES,
    expectedRecords: 34,
  },
  'official-rating-range': {
    fixture: 'tests/library/fixtures/official-rating-range/input.json',
    fields: 'SortName',
    recordScope: 'blockUnrated',
    defaultScope: 'movies',
    cases: OFFICIAL_RATING_RANGE_CASES,
    expectedRecords: 40,
  },
  tags: {
    fixture: 'tests/library/fixtures/tag-filters/input.json',
    fields: 'Tags',
    recordScope: null,
    defaultScope: 'movies',
    cases: TAG_CASES,
    expectedRecords: 34,
  },
  'rating-permissions': {
    fixture: 'tests/library/fixtures/rating-permissions/input.json',
    fields: 'SortName',
    recordScope: 'ratingPolicy',
    defaultScope: 'movies',
    cases: RATING_PERMISSION_CASES,
    expectedRecords: 36,
  },
  'tag-permissions': {
    fixture: 'tests/library/fixtures/tag-permissions/input.json',
    fields: 'SortName,Tags',
    recordScope: 'tagPolicy',
    defaultScope: 'movies',
    cases: TAG_PERMISSION_CASES,
    expectedRecords: 48,
  },
};


const staticCases = (audio) => Array.from({ length: 8 }, (_, index) => ({
  name: `${audio ? 'static-audio-source-permissions' : 'static-source-permissions'}-${index}`,
  query: `IncludeItemTypes=${audio ? 'Audio' : 'Movie'}`, scope: ['alpha'], detailKey: 'alpha',
  maxRating: null, blockUnrated: [], detailExpectedStatus: 200, endpoints: ['detail'],
  transcodingPolicy: { EnableVideoPlaybackTranscoding: Boolean(index & 1),
    EnableAudioPlaybackTranscoding: Boolean(index & 2), EnablePlaybackRemuxing: Boolean(index & 4) },
}));
for (const audio of [false, true]) {
  const name = audio ? 'static-audio-source' : 'static-source-permissions';
  catalog[name] = { ...catalog['rating-permissions'],
    fixture: audio ? 'tests/library/fixtures/filter-http-current/audio-input.json'
      : catalog['rating-permissions'].fixture,
    seedScenario: 'rating-permissions', cases: staticCases(audio), expectedRecords: 8, policyReadback: true };
}

export function currentFilterCases(descriptor, fixture) {
  const idKey = value => String(value).replaceAll('-', '').toLowerCase();
  const defaultScope = descriptor.defaultScope === 'all' ? fixture.items.map(item => item.key)
    : descriptor.defaultScope === 'movies' ? fixture.items.filter(item => item.type === 'Movie').map(item => item.key)
      : fixture.items.filter(item => idKey(item.id) !== idKey(fixture.rootId)).map(item => item.key);
  return (descriptor.cases ?? fixture.cases).map(testCase => ({ ...testCase,
    scope: testCase.scope ?? defaultScope, endpoints: testCase.endpoints ?? ['items', 'legacy'],
    blockUnrated: testCase.blockUnrated ?? [] }));
}
