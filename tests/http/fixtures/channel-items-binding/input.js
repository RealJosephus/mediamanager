export const userId = 'cf100000000000000000000000000001', channelId = 'cf100000000000000000000000000002', otherId = 'cf100000000000000000000000000003';
export function makeInput() {
  const items = '/Channels/' + channelId + '/Items', latest = '/Channels/Items/Latest';
  return { userId, channelId, otherId, requests: [
    { name: 'Items default authenticated controller query', path: items },
    { name: 'Items API key remains userless', path: items, identity: 'apiKey' },
    { name: 'Latest default authenticated controller query', path: latest },
    { name: 'Latest API key remains userless', path: latest, identity: 'apiKey' },
    { name: 'empty user Guid resolves authenticated user', path: items + '?userId=' + '0'.repeat(32) },
    { name: 'empty query values are nullable defaults', path: items + '?userId=%20&folderId=%20&startIndex=%20&limit=' },
    { name: 'signed paging and scalar first repeated value', path: items + '?startIndex=-2&limit=-1&limit=3' },
    { name: 'zero limit and empty folder Guid', path: items + '?limit=0&folderId=' + '0'.repeat(32) },
    { name: 'all Items scalar binding errors aggregate', path: '/Channels/bad/Items?folderId=bad-folder&userId=bad-user&startIndex=bad-start&limit=2147483648', status: 400 },
    { name: 'all Latest scalar binding errors aggregate', path: latest + '?userId=bad-user&startIndex=bad-start&limit=2147483648', status: 400 },
    { name: 'anonymous authentication precedes invalid binding', path: items + '?userId=bad&limit=bad', identity: 'anonymous', status: 401 },
    { name: 'regular cross-user is forbidden', path: items + '?userId=' + otherId, identity: 'regular', status: 403, diagnostic: 'SecurityException' },
    { name: 'unknown admin user is a userless manager query', path: items + '?userId=' + otherId },
    { name: 'case insensitive query and comma enum collections', path: items + '?SoRtBy=Name,DateCreated&SoRtOrder=Descending&Fields=Path,MediaSources&Filters=IsNotFolder,IsFavorite' },
    { name: 'unknown enum names are dropped before filters', path: items + '?sortBy=NotASort,Name&sortOrder=Unknown,Descending&fields=NoField,Overview&filters=Unknown,IsFolder' },
    { name: 'defined numeric enums bind to their actual names', path: items + '?sortBy=11&sortOrder=1&fields=27&filters=2' },
    { name: 'repeated enum values are not comma split again', path: items + '?sortBy=Name,DateCreated&sortBy=SortName&fields=Path,Overview&fields=Tags' },
    { name: 'folder filters conflict in actual action', path: items + '?filters=IsFolder,IsNotFolder', status: 400, diagnostic: 'ArgumentException' },
    { name: 'played filters conflict in actual action', path: latest + '?filters=IsUnplayed,IsPlayed', status: 400, diagnostic: 'ArgumentException' },
    { name: 'liked filters conflict in actual action', path: items + '?filters=Likes,Dislikes', status: 400, diagnostic: 'ArgumentException' },
    { name: 'all independent user-data filters survive action', path: items + '?filters=IsResumable,IsFavoriteOrLikes,Likes,IsPlayed' },
    { name: 'empty sortBy ignores extra order values', path: items + '?sortOrder=Ascending,Descending' },
    { name: 'too many explicit sort orders overruns actual fixed array', path: items + '?sortBy=Name&sortOrder=Ascending,Descending', status: 400, diagnostic: 'ArgumentOutOfRangeException' },
    { name: 'Latest ignores unrelated invalid sort parameters', path: latest + '?sortBy=bad&sortOrder=bad&folderId=bad' },
    { name: 'Latest discards invalid channel ids and keeps order duplicates', path: latest + '?channelIds=bad,' + channelId + ',' + otherId + ',' + channelId },
    { name: 'repeated Latest Guid arrays discard combined entries', path: latest + '?channelIds=' + channelId + ',' + otherId + '&channelIds=' + otherId },
    { name: 'braced route and parent GUID forms', path: '/Channels/%7Bcf100000-0000-0000-0000-000000000002%7D/Items?folderId=%28cf100000-0000-0000-0000-000000000003%29' },
    { name: 'Latest paging whitespace and unknown numeric sorts unused', path: latest + '?startIndex=%20%2B2%20&limit=-2147483648&channelIds=&fields=Overview' },
  ] };
}
