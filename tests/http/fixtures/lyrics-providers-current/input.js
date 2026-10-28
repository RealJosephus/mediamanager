import path from 'node:path';
import { lyricProviderId } from '../../../../src/lyrics/providers.js';

export function lyricProviderInput(root) {
  const itemId = 'fa6e1000000000000000000000000001', bookId = 'fa6e1000000000000000000000000002',
    missingId = 'fa6e1000000000000000000000000003', bytes = value => Buffer.from(value).toString('base64');
  const providers = [
    { name: 'Later Provider', order: 7, entries: [{ id: 'late', providerName: 'Public later label', format: 'lrc',
      bytes: bytes('[00:02.00] Later provider original\n'), metadata: { Artist: 'Provider supplied Artist', Length: '9223372036854775807',
        Offset: '-9223372036854775808', IsSynced: true, Title: 'traceId', Creator: 'ServerId' } }] },
    { name: 'Earlier Straße 😀', order: -3, entries: [
      { id: 'plain_under_score', providerName: 'Public first label', format: 'TXT', bytes: bytes(' Original plain lyric \r\n\r\n'), metadata: null },
      { id: 'unsupported', providerName: 'Public skipped label', format: 'srt', bytes: bytes('unsupported original text'), metadata: {} },
      { id: 'malformed', providerName: 'Public fallback label', format: 'lrc', bytes: bytes('[00:01] Original fallback text\n'), metadata: { Album: 'Literal album', By: 'Literal author' } },
      { id: 'empty', providerName: 'Public empty label', format: 'lrc', bytes: bytes(''), metadata: {} },
      { id: 'download', providerName: 'Public download label', format: 'lrc', bytes: bytes('[00:03.45] Downloaded original\n'), metadata: {} },
      { id: 'download-disconnect', providerName: 'Public admitted download label', format: 'txt', bytes: bytes('Committed after client disconnect.\n'), metadata: {} },
    ] },
    { name: 'Throwing Provider', order: -1, searchError: true, entries: [] },
    { name: 'Same Provider', order: 2, entries: [{ id: 'shared', providerName: 'First same-name public label', format: 'lrc',
      bytes: bytes('[00:01.00] First same-name original\n'), metadata: {} }] },
    { name: 'Same Provider', order: 3, entries: [{ id: 'shared', providerName: 'Second same-name public label', format: 'lrc',
      bytes: bytes('[00:09.00] Second same-name original\n'), metadata: {} }] },
  ];
  // Routes are ordinary inputs. Native derives IDs independently from actual
  // provider names; a wrong Node ID derivation also fails the search result.
  const remoteId = (name, id) => lyricProviderId(name) + '_' + id;
  const get = (name, id, options = {}) => ({ name: options.name ?? id, path: '/Providers/Lyrics/' + encodeURIComponent(remoteId(name, id)), ...options });
  const audio = '/Audio/' + itemId, first = providers[1].name;
  const cases = [
    { name: 'anonymous search denied', path: audio + '/RemoteSearch/Lyrics', identity: 'anonymous' },
    { name: 'regular denied permission', path: audio + '/RemoteSearch/Lyrics', identity: 'denied' },
    { name: 'malformed item binding', path: '/Audio/not-a-guid/RemoteSearch/Lyrics' },
    { name: 'absent item', path: '/Audio/' + missingId + '/RemoteSearch/Lyrics' },
    { name: 'wrong media kind', path: '/Audio/' + bookId + '/RemoteSearch/Lyrics' },
    { name: 'all providers retain order metadata nulls ticks and fallback', path: audio + '/RemoteSearch/Lyrics' },
    { name: 'permitted regular provider search', path: audio + '/RemoteSearch/Lyrics', identity: 'manager' },
    { name: 'API key provider search', path: audio + '/RemoteSearch/Lyrics', identity: 'apiKey' },
    get(first, 'plain_under_score'), get(first, 'unsupported'), get(first, 'malformed'), get(first, 'missing'),
    get(first, 'error'), get('Same Provider', 'shared'),
    { name: 'unknown provider', path: '/Providers/Lyrics/unknown_provider' },
    { name: 'whitespace provider id binding', path: '/Providers/Lyrics/%20' },
    { name: 'download unsupported leaves no saved file', method: 'POST', path: audio + '/RemoteSearch/Lyrics/' + encodeURIComponent(remoteId(first, 'unsupported')) },
    { name: 'download uses original bytes and queues refresh', method: 'POST', path: audio + '/RemoteSearch/Lyrics/' + encodeURIComponent(remoteId(first, 'download')) },
    { name: 'admitted download survives HTTP client disconnect', method: 'POST', disconnect: true,
      path: audio + '/RemoteSearch/Lyrics/' + encodeURIComponent(remoteId(first, 'download-disconnect')) },
  ];
  return { itemId, bookId, missingId, providers, cases, mediaPath: path.join(root, 'audio', 'track.flac'),
    metadataPath: path.join(root, 'program', 'metadata'), songName: 'Controlled original audio', albumName: 'Literal album',
    albumArtistsNames: ['Album Artist A', 'Album Artist B'], artistNames: ['Artist A', 'Artist B'], duration: '9223372036854775807' };
}
