import { readFile } from 'node:fs/promises';
import { newNativeItemEntity, applyNativeItemValues } from '../../src/library/native-item-entity.js';
import { collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { idKey } from '../../src/library/records.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';

export const root = new URL('./fixtures/item-deletion/', import.meta.url);
export const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
export const fixtureId = index => index === 0 ? '0'.repeat(32) : idKey('a1000000-0000-0000-0000-' + String(index).padStart(12, '0'));

export function entities() {
  return native.initialItems.map(row => {
    const { Type, IsFolder, SourceType, ...values } = row;
    const item = newNativeItemEntity(Type);
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
  // The native driver explicitly sets UserRootFolder.Children. This control
  // is not a repository snapshot whose nullable OwnerId can be inferred from
  // the entity's Guid.Empty constructor default.
  for (const root of items.filter(item => item.Type === 'UserRootFolder'))
    setFolderChildren(root, items.filter(item => idKey(item.ParentId) === idKey(root.Id)));
  return { items, byId: new Map(items.map(item => [idKey(item.Id), item])), links: [], parents: [], relatedItems: () => [] };
}
export const visibilityOptions = { query: false, programDataPath: 'C:\\FixtureState', dataPath: 'C:\\FixtureState\\data', configuration: {} };
