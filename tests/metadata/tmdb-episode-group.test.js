import test from 'node:test';
import assert from 'node:assert/strict';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { createExternalProviders, tmdbExternalUrls } from '../../plugins/tmdb/external.js';

test('episode lookup honors a persisted series TMDB episode group', async (t) => {
  const paths = [];
  const client = new TmdbClient({
    apiKey: 'fixture-key',
    fetch: async (address) => {
      const p = new URL(address).pathname;
      paths.push(p);
      if (p.endsWith('/configuration'))
        return Response.json({
          images: {
            secure_base_url: 'https://images.invalid/',
            poster_sizes: ['original'],
            backdrop_sizes: ['original'],
          },
        });
      if (p.endsWith('/tv/episode_group/selected-group'))
        return Response.json({ groups: [{ order: 2, episodes: [{ order: 0, season_number: 3, episode_number: 4 }] }] });
      if (p.endsWith('/season/2/episode/1')) return Response.json({ id: 201, name: 'Default S02E01' });
      if (p.endsWith('/season/3/episode/4'))
        return Response.json({
          id: 304,
          name: 'Selected S03E04',
          images: { stills: [{ file_path: '/selected.jpg' }] },
        });
      return new Response(null, { status: 404 });
    },
  });
  const { providers } = createTmdbPlugin({ client });
  const provider = providers.find((entry) => entry.id === 'TmdbEpisodeProvider');
  const result = await provider.getMetadata({
    SeriesProviderIds: { Tmdb: '10', TmdbEpisodeGroup: 'selected-group' },
    IndexNumber: 1,
    ParentIndexNumber: 2,
    MetadataLanguage: 'en',
  });
  assert.equal(result.HasMetadata, true);
  t.diagnostic(JSON.stringify(paths));
  assert.equal(result.Item.Name, 'Selected S03E04');
  const ordinary = await provider.getMetadata({
    SeriesProviderIds: { Tmdb: '10' },
    IndexNumber: 1,
    ParentIndexNumber: 2,
    MetadataLanguage: 'en',
  });
  assert.equal(ordinary.Item.Name, 'Default S02E01');
  const imageProvider = providers.find((entry) => entry.id === 'TmdbEpisodeImageProvider');
  const images = await imageProvider.getImages({
    Type: 'Episode',
    SeriesProviderIds: { tmdb: '10', tmdbepisodegroup: 'selected-group' },
    IndexNumber: 1,
    ParentIndexNumber: 2,
  });
  assert.equal(images.length, 1);
  assert.ok(images[0].Url.endsWith('/selected.jpg'));
  assert.ok(paths.some((path) => path.endsWith('/tv/episode_group/selected-group')));
});
test('series and seasons expose the episode-group external ID in metadata editors', () => {
  const ids = createExternalProviders().filter(
    (provider) => provider.kind === 'externalId' && provider.getExternalIdInfo().Key === 'TmdbEpisodeGroup'
  );
  assert.deepEqual(
    ids.map((provider) => [provider.getExternalIdInfo().Type, provider.itemTypes]),
    [['ReleaseGroup', ['Series', 'Season']]]
  );
});
test('series and season details link to the selected episode group', () => {
  const base = 'https://www.themoviedb.org/tv/10';
  const series = { Tmdb: '10', TmdbEpisodeGroup: 'selected-group' };
  const links = [
    tmdbExternalUrls({ Type: 'Series', ProviderIds: series }),
    tmdbExternalUrls({
      Type: 'Season',
      IndexNumber: 2,
      SeriesProviderIds: series,
      ProviderIds: { TmdbEpisodeGroup: 'season-group' },
    }),
  ];
  assert.deepEqual(links, [
    [base, base + '/episode_group/selected-group'],
    [base + '/season/2', base + '/episode_group/selected-group/group/season-group'],
  ]);
});
