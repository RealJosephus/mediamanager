import { randomUUID } from 'node:crypto';
import { md5Guid } from '../core/identity.js';
import { nativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { domainError, nativeGuid } from './native.js';

export const homeSectionClient = 'emby-home-sections';
export const homeSectionItemId = nativeGuid(md5Guid('homescreen'));
const layoutKey = 'layout';
const queryDefaults = () => ({ StudioIds: [], TagIds: [], GenreIds: [], CollectionTypes: [] });
const sectionDefaults = () => ({ Monitor: [], ItemTypes: [], ExcludedFolders: [], CardSizeOffset: 0,
  IncludeNextUpInResume: true, Query: queryDefaults() });
const names = { userviews: 'My Media', resume: 'Continue Watching', resumeaudio: 'Continue Listening',
  onnow: 'On Now', latestmediablock: 'Latest Media', nextup: 'Next Up', collections: 'Collections', playlists: 'Playlists' };

function defaultLayout(user) {
  return [
    { Id: 'smalllibrarytiles', SectionType: 'userviews', CardSizeOffset: -1 },
    { Id: 'resume', SectionType: 'resume', Monitor: ['videoplayback', 'markplayed'] },
    { Id: 'resumeaudio', SectionType: 'resumeaudio', Monitor: ['audioplayback', 'markplayed'] },
    { Id: 'onnow', SectionType: 'onnow', CollectionType: 'livetv', PremiumFeature: 'livetv',
      PremiumMessage: 'Emby Live TV & DVR require an active Emby Premiere subscription.', RefreshInterval: 300000 },
    { Id: 'latestmediablock', SectionType: 'latestmediablock', Query: { ...queryDefaults(),
      ...(user.Configuration.HidePlayedInLatest ? { IsPlayed: false } : {}) } },
  ].map(section => ({ ...sectionDefaults(), ...section }));
}

const identity = userId => ({ UserId: nativeGuid(userId), ItemId: homeSectionItemId, Client: homeSectionClient, Key: layoutKey });
async function readLayout(database, user) {
  const row = (await database.rows('CustomItemDisplayPreferences', { where: identity(user.Id), columns: ['Id', 'Value'], limit: 1 }))[0];
  return { row, sections: row ? JSON.parse(row.Value) : defaultLayout(user) };
}
async function writeLayout(database, user, sections, row) {
  const Value = JSON.stringify(sections);
  if (row) await database.update('CustomItemDisplayPreferences', { Id: row.Id }, { Value });
  else await database.insert('CustomItemDisplayPreferences', { ...identity(user.Id), Value });
}
function publicSection(section) {
  const CollectionType = section.CollectionType ?? (section.ItemTypes?.length && section.ItemTypes.every(type => ['Audio', 'MusicAlbum', 'MusicArtist'].includes(type)) ? 'music' : undefined);
  return { ...section, Name: section.CustomName || names[section.SectionType] || section.Name,
    ...(CollectionType && { CollectionType }) };
}
async function requireUser(users, database, userId) {
  const user = await users.loadUser(database, nativeGuid(userId));
  if (!user) throw domainError(500, 'Object reference not set to an instance of an object.');
  return user;
}

export async function getHomeSections({ store, users, library }, userId, { isEditMode = false, displayMode } = {}) {
  const { user, sections } = await store.run(async database => {
    const user = await requireUser(users, database, userId), { sections } = await readLayout(database, user);
    return { user, sections: sections.length ? sections : defaultLayout(user) };
  }, { readOnly: true });
  const result = [];
  let views;
  for (const original of sections) {
    const section = publicSection(original);
    if (!isEditMode && displayMode && section.DisplayMode && !displayMode.split(',').some(mode => section.DisplayMode.split(',').includes(mode))) continue;
    if (isEditMode || section.SectionType !== 'latestmediablock') { result.push(section); continue; }
    views ??= (await library.getViews({}, { user })).Items;
    const excluded = new Set([...section.ExcludedFolders, ...user.Configuration.LatestItemsExcludes]);
    for (const parent of views) {
      if (excluded.has(parent.Id) || excluded.has(parent.Id.replaceAll('-', ''))) continue;
      result.push({ ...section, Name: section.CustomName || `Latest ${parent.Name}`, Id: 'latestmedia_' + parent.Id,
        SectionType: 'latestmedia', CollectionType: parent.CollectionType, Monitor: ['markplayed'], ParentId: parent.Id, ParentItem: parent });
    }
  }
  return result;
}

export async function saveHomeSection({ store, users }, userId, input) {
  return store.transaction(async database => {
    const user = await requireUser(users, database, userId), state = await readLayout(database, user);
    const sections = state.sections.length ? state.sections : defaultLayout(user);
    const id = input.Id || randomUUID().replaceAll('-', '');
    const index = sections.findIndex(section => section.Id === id);
    if (input.Id && index < 0) throw domainError(404, "Exception of type 'MediaBrowser.Common.Extensions.ResourceNotFoundException' was thrown.");
    const section = { ...sectionDefaults(), ...input, Id: id,
      Query: { ...queryDefaults(), ...input.Query },
      Monitor: input.Monitor ?? (input.SectionType === 'resume' ? ['videoplayback', 'markplayed']
        : input.SectionType === 'resumeaudio' ? ['audioplayback', 'markplayed'] : []),
    };
    // UserId is request context in the original in-memory DTO, not layout
    // state. Keeping identities on the scoped row also makes copies portable.
    delete section.UserId;
    delete section.Name;
    if (index < 0) sections.push(section); else sections[index] = section;
    await writeLayout(database, user, sections, state.row);
    return id;
  });
}

export async function changeHomeSections({ store, users }, userId, action, input) {
  if (input.Ids === null) throw domainError(400, "Value cannot be null. (Parameter 'source')");
  return store.transaction(async database => {
    const user = await requireUser(users, database, userId), state = await readLayout(database, user);
    const sections = state.sections.length ? state.sections : defaultLayout(user), selected = new Set(input.Ids);
    const remaining = sections.filter(section => !selected.has(section.Id));
    if (action === 'Move') {
      const position = Math.max(0, Math.min(sections.length, input.NewIndex));
      const removedBefore = sections.slice(0, position).filter(section => selected.has(section.Id)).length;
      remaining.splice(position - removedBefore, 0, ...sections.filter(section => selected.has(section.Id)));
    }
    await writeLayout(database, user, remaining, state.row);
  });
}

export async function copyHomeSections(database, sourceId, targetId) {
  const source = identity(sourceId), target = identity(targetId);
  await database.deleteWhere('CustomItemDisplayPreferences', target);
  await database.client.query(`INSERT INTO ${q(database.schemaName)}."CustomItemDisplayPreferences" ("UserId", "ItemId", "Client", "Key", "Value")
    SELECT $2::bytea, "ItemId", "Client", "Key", "Value" FROM ${q(database.schemaName)}."CustomItemDisplayPreferences"
    WHERE "UserId" = $1::bytea AND "ItemId" = $3::bytea AND "Client" = $4::bytea AND "Key" = $5::bytea`,
  [nativeTextBytes(source.UserId), nativeTextBytes(target.UserId), nativeTextBytes(source.ItemId), nativeTextBytes(homeSectionClient), nativeTextBytes(layoutKey)]);
}
