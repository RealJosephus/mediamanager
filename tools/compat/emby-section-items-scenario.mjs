import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function captureSectionItems({ call, reader, other, token, otherToken, items, report, instance, restart }) {
  const user = '/Users/' + reader.Id;
  const primary = items.find(item => item.Name === 'Controlled audio A');
  assert.ok(primary?.Path);
  const actualSource = await realpath(primary.Path), actualInstance = await realpath(instance);
  assert.ok(actualSource.startsWith(actualInstance + path.sep));
  const media = path.join(instance, 'controlled-secondary-music');
  await mkdir(media);
  await writeFile(path.join(media, 'Controlled outside audio D.wav'), await readFile(actualSource));
  const added = await call('section-add-second-library', '/Library/VirtualFolders?name=Controlled%20secondary%20music&collectionType=music&refreshLibrary=true', {
    method: 'POST', body: { LibraryOptions: { PathInfos: [{ Path: media }], EnableRealtimeMonitor: false,
      EnableInternetProviders: false, SaveLocalMetadata: false, MetadataSavers: [],
      TypeOptions: ['Audio', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] })) } },
  });
  assert.ok(added.status < 300);
  const deadline = Date.now() + 60000;
  let all;
  while (true) {
    all = await call('section-await-second-library', user + '/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path&Limit=10', { token });
    if (all.bodyJson?.Items?.length === 4) break;
    assert.ok(Date.now() < deadline, 'The second real audio library was not scanned.');
    await delay(500);
  }
  report.identities.itemNames = Object.fromEntries(all.bodyJson.Items.map(item => [item.Id, item.Name]));
  const views = await call('section-views', user + '/Views', { token });
  report.identities.libraryNames = Object.fromEntries(views.bodyJson.Items.map(item => [item.Id, { name: item.Name, guid: item.Guid }]));
  const library = views.bodyJson.Items.find(item => item.Name === 'Controlled music');
  assert.ok(library?.Id);
  const original = await call('section-read-editable-audio', user + '/Items/' + primary.Id + '?Fields=Tags,Genres,Studios,ProviderIds', { token });
  assert.equal(original.status, 200);
  const edit = await call('section-set-metadata', '/Items/' + primary.Id, { method: 'POST', body: {
    ...original.bodyJson, TagItems: ['Sports', 'Repeat', 'Controlled tag'].map(Name => ({ Name })), GenreItems: [{ Name: 'Controlled genre' }],
  } });
  assert.equal(edit.status, 204);
  await call('section-audio-after-metadata', user + '/Items/' + primary.Id + '?Fields=Tags,Genres,Studios', { token });
  await call('section-favorite-audio', user + '/FavoriteItems/' + primary.Id, { token, method: 'POST' });
  await call('section-played-audio', user + '/PlayedItems/' + primary.Id, { token, method: 'POST' });
  const moviePath = path.join(instance, 'controlled-filter-movies');
  await mkdir(moviePath);
  // A valid PCM WAV at a video filename exercises metadata classification;
  // this fixture has no video stream and makes no playback assertion.
  await writeFile(path.join(moviePath, 'Controlled metadata movie.mkv'), await readFile(actualSource));
  assert.ok((await call('section-add-movie-library', '/Library/VirtualFolders?name=Controlled%20movies&collectionType=movies&refreshLibrary=true', {
    method: 'POST', body: { LibraryOptions: { PathInfos: [{ Path: moviePath }], EnableRealtimeMonitor: false,
      EnableInternetProviders: false, SaveLocalMetadata: false, MetadataSavers: [],
      TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }] } },
  })).status < 300);
  let movie;
  const movieDeadline = Date.now() + 60000;
  while (true) {
    const scanned = await call('section-await-movie', user + '/Items?Recursive=true&IncludeItemTypes=Movie&Limit=4', { token });
    movie = scanned.bodyJson?.Items?.find(item => item.Name === 'Controlled metadata movie');
    if (movie) break;
    assert.ok(Date.now() < movieDeadline, 'The metadata-only Movie fixture was not scanned.');
    await delay(500);
  }
  const movieBefore = await call('section-read-editable-movie', user + '/Items/' + movie.Id + '?Fields=Studios', { token });
  assert.equal((await call('section-set-movie-studio', '/Items/' + movie.Id, { method: 'POST', body: {
    ...movieBefore.bodyJson, Studios: [{ Name: 'Controlled studio' }],
  } })).status, 204);
  await call('section-movie-after-metadata', user + '/Items/' + movie.Id + '?Fields=Studios', { token });
  report.identities.itemNames[movie.Id] = movie.Name;
  report.metadataMovie = { name: movie.Name, bytes: 'Exact copy of the controlled PCM WAV input.',
    limitation: 'Metadata query classification only; no video stream, generation or playback validation.' };
  const allViews = await call('section-all-views', user + '/Views', { token });
  report.identities.libraryNames = Object.fromEntries(allViews.bodyJson.Items.map(item => [item.Id, { name: item.Name, guid: item.Guid }]));
  const selectors = {};
  for (const [route, name] of [['Tags', 'Controlled tag'], ['MusicGenres', 'Controlled genre'], ['Studios', 'Controlled studio']]) {
    const result = await call('section-selectors-' + route, `/${route}?UserId=${reader.Id}&Recursive=true&IncludeItemTypes=Audio,Movie`, { token });
    assert.equal(result.status, 200);
    const key = route === 'MusicGenres' ? 'Genres' : route;
    selectors[key] = (result.bodyJson.Items ?? result.bodyJson).find(item => item.Name === name);
    assert.ok(selectors[key]?.Id, 'The actual metadata selector must be nonempty: ' + route);
  }
  report.identities.selectors = selectors;
  const base = { SectionType: 'items', CustomName: 'Controlled section items', ItemTypes: ['Audio', 'Movie'], SortBy: 'SortName', SortOrder: 'Descending', Query: {} };
  assert.equal((await call('section-create', user + '/HomeSections', { token, method: 'POST', body: base })).status, 204);
  const layout = await call('section-created-layout', user + '/HomeSections?IsEditMode=true', { token });
  const section = layout.bodyJson.find(item => item.CustomName === base.CustomName);
  assert.ok(section?.Id); report.identities.sectionId = section.Id;
  const read = (label, extra = {}, options = {}) => call(label, user + '/Sections/' + section.Id + '/Items?' + new URLSearchParams({ Limit: '10', ...extra }), { token, ...options });
  const save = (label, changes) => call(label, user + '/HomeSections', { token, method: 'POST', body: { ...base, Id: section.Id, ...changes } });
  await read('section-items-default');
  await read('section-items-page', { StartIndex: '1', Limit: '2' });
  await read('section-items-no-count', { StartIndex: '1', Limit: '2', EnableTotalRecordCount: 'false' });
  await read('section-items-request-sort', { SortBy: 'SortName', SortOrder: 'Ascending' });
  await read('section-items-request-types', { IncludeItemTypes: 'Movie' });
  await read('section-items-request-favorite', { IsFavorite: 'true' });
  for (const key of ['IsFavorite', 'IsPlayed', 'IsResumable', 'IsMovie', 'IsSeries', 'IsSports', 'IsNews', 'IsRepeat']) {
    for (const value of [true, false]) {
      await save(`section-save-${key}-${value}`, { Query: { [key]: value } });
      await read(`section-items-${key}-${value}`);
    }
  }
  for (const [field, value] of [['StudioIds', [selectors.Studios.Id]], ['GenreIds', [selectors.Genres.Id]],
    ['TagIds', [selectors.Tags.Id]], ['CollectionTypes', ['music']], ['CollectionTypes', ['movies']]]) {
    const label = field === 'CollectionTypes' ? field + '-' + value[0] : field;
    await save('section-save-' + label, { Query: { [field]: value } }); await read('section-items-' + label);
  }
  await save('section-save-favorite-precedence', { Query: { IsFavorite: true } });
  await read('section-items-favorite-precedence', { IsFavorite: 'false' });
  await save('section-save-excluded-primary', { ExcludedFolders: [library.Id] });
  await read('section-items-excluded-primary');
  await save('section-save-parent-primary', { ParentId: library.Id });
  await read('section-items-parent-primary');
  await save('section-save-reset', {});
  await call('section-items-cross-user', `/Users/${other.Id}/Sections/${section.Id}/Items?Limit=10`, { token });
  await call('section-items-target-own', `/Users/${other.Id}/Sections/${section.Id}/Items?Limit=10`, { token: otherToken });
  await call('section-restrict-primary-only', user + '/Policy', { method: 'POST', body: { ...reader.Policy,
    EnableAllFolders: false, EnabledFolders: [library.Guid ?? library.Id] } });
  await read('section-items-primary-access-only');
  await save('section-save-excluded-with-restricted-access', { ExcludedFolders: [library.Id] });
  await read('section-items-excluded-with-restricted-access');
  await call('section-restore-policy', user + '/Policy', { method: 'POST', body: reader.Policy });
  await save('section-save-before-restart', {});
  await restart();
  await read('section-items-after-restart');
}
