const probes = {
  'probe-unknown-credit': {
    name: 'artists-unknown-name-creates-selector-and-matches-orphan-credit',
    query: 'ArtistIds=73000000-0000-0000-0000-000000000002&Artists=NativeMissingArtist',
    scope: ['unknownNameOrphanCredit', 'artistBob', 'noCredit'],
  },
  'probe-bom-credit': {
    name: 'artists-bom-name-creates-empty-clean-selector-and-matches-orphan-credit',
    query: 'Artists=%EF%BB%BF',
    scope: ['bomEmptyCleanOrphanCredit', 'artistAlice', 'noCredit'],
  },
  'probe-request-order': {
    name: 'artists-repeated-name-then-whitespace-observes-request-local-created-selector',
    query: 'Artists=Alice&Artists=%20%20',
    scope: ['artistAlice', 'artistBob'],
  },
  'probe-bom-order': {
    name: 'artists-bom-then-whitespace-observes-created-selector-but-prefers-bob-sort',
    query: 'Artists=%EF%BB%BF&Artists=%20%20',
    scope: ['bomEmptyCleanOrphanCredit', 'artistBob'],
  },
};

/** The controlled requests and initial graph, independent of native results. */
export function artistFilterInput(input, mode) {
  if (mode === 'main' || mode === 'discover') return structuredClone(input);
  const probe = probes[mode];
  if (!probe) throw new Error(`Unknown artist filter mode: ${mode}.`);
  const fixture = { ...structuredClone(input), cases: [structuredClone(probe)] };
  if (!['probe-request-order', 'probe-bom-order'].includes(mode)) return fixture;
  const keys = new Set(['root', 'requestOrderByNameBobSelector', ...probe.scope]);
  fixture.items = fixture.items.filter(item => keys.has(item.key));
  const ids = new Set(fixture.items.map(item => item.id.replaceAll('-', '').toLowerCase()));
  fixture.itemValueLinks = fixture.itemValueLinks.filter(link => keys.has(link.itemKey));
  const values = new Set(fixture.itemValueLinks.map(link => link.valueKey));
  fixture.itemValues = fixture.itemValues.filter(value => values.has(value.key));
  fixture.links = fixture.links.filter(link => ids.has(link.parentId.replaceAll('-', '').toLowerCase())
    && ids.has(link.childId.replaceAll('-', '').toLowerCase()));
  return fixture;
}
