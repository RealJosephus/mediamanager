import { rootLinkInput, rootLinkId as id } from './input.js';

/** Separate neutral ID-replay input. The original root/folder inputs and their
 * captures retain their existing identities. UserRoot's public null assignment
 * clears Children while its original LoadChildren ID list remains populated. */
export function rootChildIdInput(root) {
  const input = rootLinkInput(root);
  input.cases = [
    { name: 'cold UserRoot records its child identities', lane: 'root', user: 'all', direct: 'stored', virtual: [], replaceLinks: [] },
    { name: 'warm manager changes do not replace populated Children', lane: 'root', user: 'all',
      warm: { id: id(10), name: 'Zulu manager first', sort: 'zzzz', parentId: id(14) } },
    { name: 'UserRoot null Children replays the current manager instance', lane: 'root', user: 'all', direct: 'stored' },
    { name: 'raw collection membership reads the replayed instance', lane: 'raw', user: 'all' },
    { name: 'explicit warm Children override the replay list', lane: 'root', user: 'all', direct: [{ id: id(10), name: 'Private warm first' }] },
    { name: 'releasing explicit Children restores original IDs through manager', lane: 'root', user: 'all', direct: 'stored',
      warm: { id: id(11), name: 'Alpha manager second', sort: 'aaaa' } },
    { name: 'complete root DTO consumes replayed manager values', lane: 'dto', user: 'all' },
    { name: 'replayed Children remain available with a linked shutdown source', lane: 'root', user: 'all', direct: 'stored',
      replaceLinks: [{ ItemId: id(20), Type: 0, Path: null, LibraryItemId: null }] },
  ];
  input.scope = 'Current actual UserRoot child-ID replay, raw GetCollectionFolders and complete root DTO values, independently captured; PostgreSQL production navigation and queryItems. Private Children graph and GC restoration are outside this input.';
  return input;
}
