import assert from 'node:assert/strict';

export async function captureHomeSections({ call, reader, other, token, otherToken, items, report, restart }) {
  const user = '/Users/' + reader.Id, target = '/Users/' + other.Id;
  const read = (label, suffix = '?IsEditMode=true', options = {}) => call(label, user + '/HomeSections' + suffix, { token, ...options });
  const save = (label, body, options = {}) => call(label, user + '/HomeSections', { token, method: 'POST', body, ...options });
  const mutation = (label, action, body, options = {}) => call(label, user + '/HomeSections/' + action, { token, method: 'POST', body, ...options });
  const sectionItems = (label, id, suffix = '', options = {}) => {
    const query = new URLSearchParams({ Fields: 'CanDownload', Limit: '10' });
    for (const [key, value] of new URLSearchParams(suffix)) query.set(key, value);
    return call(label, user + '/Sections/' + encodeURIComponent(id) + '/Items?' + query, { token, ...options });
  };
  const initial = await read('home-default-edit');
  assert.equal(initial.status, 200);
  assert.ok(initial.bodyJson.length > 0);
  for (const [label, suffix] of [['home-default-expanded', ''], ['home-default-desktop', '?DisplayMode=desktop'],
    ['home-default-tv', '?DisplayMode=tv'], ['home-invalid-edit', '?IsEditMode=invalid'], ['home-unknown-mode', '?DisplayMode=unknown']]) await read(label, suffix);
  const expanded = await read('home-expanded-sections', '?DisplayMode=mobile,desktop');
  const latest = expanded.bodyJson.find(section => section.SectionType === 'latestmedia');
  assert.ok(latest?.ParentId, 'The scanned library must produce a real expanded latest-media section.');
  report.identities.homeLibraryId = latest.ParentId;
  report.identities.itemNames = Object.fromEntries(items.map(item => [item.Id, item.Name]));
  await call('home-views', user + '/Views', { token });
  for (const section of initial.bodyJson) await sectionItems('home-items-' + section.Id, section.Id);
  await sectionItems('home-items-latest-expanded', latest.Id);
  await sectionItems('home-items-latest-page', latest.Id, '&StartIndex=1&Limit=1');
  await sectionItems('home-items-latest-count-disabled', latest.Id, '&EnableTotalRecordCount=false');
  await sectionItems('home-items-unknown', 'unknown-section');
  await call('home-cross-read', target + '/HomeSections?IsEditMode=true', { token });
  await call('home-anonymous-read', user + '/HomeSections', { token: null });
  await call('home-anonymous-save', user + '/HomeSections', { token: null, method: 'POST', body: initial.bodyJson[0] });

  const first = initial.bodyJson[0];
  await save('home-save-custom-default', { ...first, CustomName: 'Unicode 設定', Subtitle: 'Controlled subtitle',
    CardSizeOffset: 2, DisplayMode: 'desktop', ScrollDirection: 'vertical', UnknownProperty: 'unbound' });
  await read('home-after-custom-default');
  await read('home-custom-default-mobile', '?DisplayMode=mobile');
  await read('home-custom-default-desktop', '?DisplayMode=desktop');
  await read('home-custom-default-tv', '?DisplayMode=tv');
  await save('home-update-unknown-id', { Id: 'controlled-audio', SectionType: 'items', CustomName: 'Unknown section' });
  await save('home-add-audio-query', { SectionType: 'items', CustomName: 'Controlled audio query',
    ItemTypes: ['Audio'], SortBy: 'SortName', SortOrder: 'Descending', Query: {}, IncludeNextUpInResume: false });
  const custom = await read('home-after-audio-query');
  const audioSection = custom.bodyJson.find(section => section.CustomName === 'Controlled audio query');
  assert.ok(audioSection?.Id, 'The real server must generate the new query section identity.');
  report.identities.controlledSectionId = audioSection.Id;
  if (audioSection) {
    await sectionItems('home-audio-query-items', audioSection.Id);
    await sectionItems('home-audio-query-page', audioSection.Id, '&StartIndex=1&Limit=1');
    await sectionItems('home-audio-query-no-count', audioSection.Id, '&StartIndex=1&Limit=1&EnableTotalRecordCount=false');
    await call('home-favorite-audio', user + '/FavoriteItems/' + items[0].Id, { token, method: 'POST' });
    await save('home-update-audio-favorites', { ...audioSection, Query: { ...audioSection.Query, IsFavorite: true } });
    await read('home-after-query-filter');
    await sectionItems('home-audio-query-favorites', audioSection.Id);
    await save('home-update-audio-exclude-library', { ...audioSection, ExcludedFolders: [latest.ParentId] });
    await sectionItems('home-audio-query-excluded', audioSection.Id);
    await save('home-restore-audio-query', audioSection);
  }
  await save('home-add-generated-id', { SectionType: 'items', ItemTypes: ['Audio'], CustomName: 'Generated section', Query: {} });
  const generated = await read('home-after-generated-id');
  report.identities.generatedSectionIds = generated.bodyJson.filter(section => section.CustomName === 'Generated section').map(section => section.Id);
  await call('home-cross-save', target + '/HomeSections', { token, method: 'POST', body: { ...first, CustomName: 'Cross-path owner' } });
  await read('home-source-after-cross-save');
  await call('home-target-after-cross-save', target + '/HomeSections?IsEditMode=true', { token: otherToken });
  await mutation('home-move-sections', 'Move', { Ids: [audioSection.Id, first.Id], NewIndex: 1 });
  await read('home-after-move');
  await mutation('home-move-unknown', 'Move', { Ids: ['unknown-section'], NewIndex: 0 });
  await read('home-after-unknown-move');
  await mutation('home-move-negative', 'Move', { Ids: [first.Id], NewIndex: -1 });
  await read('home-after-negative-move');
  await mutation('home-delete-unknown', 'Delete', { Ids: ['unknown-section'] });
  await mutation('home-delete-empty', 'Delete', { Ids: [] });
  await mutation('home-delete-null', 'Delete', { Ids: null });
  await read('home-before-copy');
  await call('home-copy-configuration', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: ['userconfiguration'] } });
  await call('home-target-after-copy', target + '/HomeSections?IsEditMode=true', { token: otherToken });
  await call('home-restrict-folders', user + '/Policy', { method: 'POST', body: { ...reader.Policy, EnableAllFolders: false, EnabledFolders: [] } });
  await read('home-without-library-access', '?DisplayMode=desktop');
  await sectionItems('home-latest-without-library-access', latest.Id);
  await call('home-restore-folders', user + '/Policy', { method: 'POST', body: reader.Policy });
  await restart();
  const persisted = await read('home-after-restart');
  if (audioSection) await sectionItems('home-audio-query-after-restart', audioSection.Id);
  await mutation('home-delete-all', 'Delete', { Ids: persisted.bodyJson.map(section => section.Id) });
  await read('home-after-delete-all');
  await read('home-expanded-after-delete-all', '?DisplayMode=desktop');
}
