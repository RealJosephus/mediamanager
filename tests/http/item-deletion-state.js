import { applyNativeItemValues, nativeItemDescriptor, nativeItemTypes,
  newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { idKey } from '../../src/library/records.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';

const nativeTypeByItemType = new Map(nativeItemTypes.map(nativeType => [nativeItemDescriptor(nativeType).type, nativeType]));
const specifications = [
  { type: 'UserRootFolder', path: 'C:\\FixtureState\\root\\default', name: 'UserRootFolder' },
  { type: 'AggregateFolder', path: 'C:\\FixtureState\\root', name: 'AggregateFolder', IsRoot: true },
  { type: 'Folder', path: 'Z:\\SyntheticMedia', name: 'PhysicalRoot', ParentId: 2, IsRoot: true },
  { type: 'CollectionFolder', path: 'C:\\FixtureState\\root\\default\\Library', name: 'CollectionFolder',
    ParentId: 1, PhysicalLocationsList: ['Z:\\SyntheticMedia'] },
  { type: 'Audio' }, { type: 'Audio', name: 'SecondAudio' }, { type: 'AudioBook' }, { type: 'Book' },
  { type: 'Movie' }, { type: 'Video' }, { type: 'Trailer' }, { type: 'MusicVideo' }, { type: 'Episode' },
  { type: 'Series' }, { type: 'Season' }, { type: 'MusicAlbum' }, { type: 'Photo' }, { type: 'PhotoAlbum' },
  { type: 'Folder' }, { type: 'BoxSet' },
  { type: 'Playlist', OwnerUserId: 90, OpenAccess: true },
  { type: 'MusicArtist' }, { type: 'Person' }, { type: 'Genre' }, { type: 'MusicGenre' }, { type: 'Studio' },
  { type: 'Year' }, { type: 'UserView' }, { type: 'PlaylistsFolder', name: 'PlaylistsFolder' },
  { type: 'Folder', name: 'RootFolder', IsRoot: true },
  { type: 'MusicArtist', name: 'PhysicalArtist' },
  { type: 'MusicArtist', name: 'RemoteArtist', path: 'http://example.invalid/artist' },
  { type: 'Movie', name: 'ActiveMovie', path: 'Z:\\SyntheticMedia\\active.mkv' },
  { type: 'Audio', name: 'RemoteAudio', path: 'http://example.invalid/audio' },
  { type: 'Audio', name: 'NullAudio', path: null },
  { type: 'Playlist', name: 'PlaylistNull', path: null, OwnerUserId: 90, OpenAccess: true },
  { type: 'BoxSet', name: 'BoxSetNull', path: null },
];
const byNameTypes = new Set(['MusicArtist', 'Person', 'Genre', 'MusicGenre', 'Studio', 'Year']);
const nullPathNames = new Set(['NullAudio', 'PlaylistNull', 'BoxSetNull']);

export const fixtureId = index => index === 0 ? '0'.repeat(32)
  : idKey('a1000000-0000-0000-0000-' + String(index).padStart(12, '0'));

export function entities() {
  return specifications.map((specification, index) => {
    const nativeType = nativeTypeByItemType.get(specification.type);
    if (!nativeType) throw new TypeError('Unknown neutral deletion item type: ' + specification.type);
    const item = newNativeItemEntity(nativeType);
    const name = specification.name ?? specification.type;
    const values = { Id: fixtureId(index + 1), Name: name };
    if (Object.hasOwn(specification, 'path')) values.Path = specification.path;
    else if (index >= 4 && !nullPathNames.has(name)) values.Path = 'Z:\\SyntheticMedia\\' + name + (item.IsFolder ? '' : '.fixture');
    if (Number.isInteger(specification.ParentId)) values.ParentId = fixtureId(specification.ParentId);
    else if (index >= 4 && !nullPathNames.has(name)
      && (!byNameTypes.has(specification.type) || name === 'PhysicalArtist' || name === 'RemoteArtist')) {
      values.ParentId = fixtureId(3);
    }
    if (specification.type === 'Playlist') {
      values.ParentId = fixtureId(0);
      if (!Object.hasOwn(specification, 'path')) values.Path = 'C:\\FixtureState\\data\\playlists\\Neutral';
    }
    for (const [name, value] of Object.entries(specification)) {
      if (!['type', 'name', 'path', 'ParentId'].includes(name)) {
        values[name] = name === 'OwnerUserId' ? fixtureId(value) : value;
      }
    }
    applyNativeItemValues(item, values);
    return item;
  });
}

export function userFor(sample) {
  return { Id: sample.claim === 'other' ? fixtureId(91) : fixtureId(90), MaxParentalRatingScore: null,
    Policy: { IsAdministrator: sample.policy === 'admin', EnableContentDeletion: sample.policy === 'content',
      EnableCollectionManagement: sample.policy === 'collection', EnableAllFolders: !sample.hidden,
      EnabledFolders: [], BlockedMediaFolders: [], AllowedTags: [], BlockedTags: [], BlockUnratedItems: [],
      EnableContentDeletionFromFolders: sample.policy === 'folder' ? [fixtureId(4)] : sample.policy === 'wrong-folder' ? [fixtureId(98)] : [] } };
}

export function permissionOptions(item, state) {
  return { collectionFolders: () => collectionFoldersForItem(item, state),
    isActiveRecording: entry => entry.Path === 'Z:\\SyntheticMedia\\active.mkv' };
}

export function stateFor(items) {
  // The current Native driver and this independent Node setup explicitly set
  // UserRootFolder.Children; neither infers it from a repository snapshot.
  for (const root of items.filter(item => item.Type === 'UserRootFolder')) {
    setFolderChildren(root, items.filter(item => idKey(item.ParentId) === idKey(root.Id)));
  }
  return { items, byId: new Map(items.map(item => [idKey(item.Id), item])), links: [], parents: [], relatedItems: () => [] };
}

export const visibilityOptions = { query: false, programDataPath: 'C:\\FixtureState',
  dataPath: 'C:\\FixtureState\\data', configuration: {} };
