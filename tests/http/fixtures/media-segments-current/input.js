export const itemId = 'cf220000000000000000000000000001', hiddenId = 'cf220000000000000000000000000002';
export const userId = 'cf220000000000000000000000000003', readerId = 'cf220000000000000000000000000004';
const id = value => 'cf22' + '0'.repeat(16) + String(value).padStart(12, '0');

export function makeInput() {
  const rows = Array.from({ length: 260 }, (_, index) => ({ id: id(1000 - index), itemId,
    provider: index % 2 ? 'Secondary' : 'Control Primary', type: index % 6,
    startTicks: String(BigInt(Math.floor(index / 3)) * 100n + 1n), endTicks: String(BigInt(Math.floor(index / 3)) * 100n + 9n) }));
  rows.push({ id: '0'.repeat(32), itemId, provider: 'Control Primary', type: 0, startTicks: '-9223372036854775808', endTicks: '-1' },
    { id: id(2000), itemId, provider: 'Control Primary', type: 99, startTicks: '9007199254740993', endTicks: '9223372036854775807' },
    { id: id(2001), itemId, provider: 'Uninstalled', type: 5, startTicks: '0', endTicks: '1' },
    { id: id(2002), itemId: hiddenId, provider: 'Control Primary', type: 5, startTicks: '0', endTicks: '1' },
    { id: id(2003), itemId, provider: 'Πρόλογος', type: 5, startTicks: '25', endTicks: '31' });
  const route = '/MediaSegments/' + itemId;
  return { itemId, hiddenId, userId, readerId, rows, cases: [
    { name: 'all enabled providers, complete result and equal-tick insertion order', path: route },
    { name: 'API key is userless', path: route, identity: 'apiKey' },
    { name: 'ordinary user retains access', path: route, identity: 'regular' },
    { name: 'anonymous precedes malformed model', path: '/MediaSegments/bad?includeSegmentTypes=bad', identity: 'anonymous', status: 401 },
    { name: 'malformed route', path: '/MediaSegments/bad', status: 400 },
    { name: 'empty item id is not a user root', path: '/MediaSegments/' + '0'.repeat(32), status: 400 },
    { name: 'missing item', path: '/MediaSegments/' + id(9000), status: 404 },
    { name: 'hidden item', path: '/MediaSegments/' + hiddenId, identity: 'regular', status: 404 },
    { name: 'disabled providers match ordinal ignore case', path: route, disabled: ['cOnTrOl PrImArY'] },
    { name: 'all providers disabled', path: route, disabled: ['CONTROL PRIMARY', 'secondary'] },
    { name: 'null disabled list acts as empty provider exclusions', path: route, disabled: null },
    { name: 'unused null disabled list has no providers to enumerate', path: route, disabled: null, providers: [] },
    { name: 'Unicode provider identity uses invariant lowercase and UTF16 MD5', path: route, providers: ['Πρόλογος'] },
    { name: 'production default has no installed segment providers', path: route, providers: [] },
    { name: 'one enum type', path: route + '?includeSegmentTypes=Intro' },
    { name: 'ordinary collection keeps repeated enum entries', path: route + '?includeSegmentTypes=Intro&includeSegmentTypes=Commercial' },
    { name: 'ordinary enum comma is one combined value', path: route + '?includeSegmentTypes=Preview,Commercial' },
    { name: 'empty enum element', path: route + '?includeSegmentTypes=', status: 400 },
    { name: 'undefined numeric enum', path: route + '?includeSegmentTypes=99', status: 400 },
    { name: 'negative numeric enum', path: route + '?includeSegmentTypes=-1', status: 400 },
    { name: 'unknown enum name', path: route + '?includeSegmentTypes=NotASegment', status: 400 },
    { name: 'route and collection errors aggregate', path: '/MediaSegments/bad?includeSegmentTypes=NotASegment', status: 400 },
    { name: 'normal enum combined undefined value', path: route + '?includeSegmentTypes=Preview,Outro', status: 400 },
    { name: 'sequential indexes', path: route + '?includeSegmentTypes[0]=Intro&includeSegmentTypes[1]=Commercial' },
    { name: 'named indexes', path: route + '?includeSegmentTypes.index=b&includeSegmentTypes.index=a&includeSegmentTypes[b]=Preview&includeSegmentTypes[a]=Outro' },
    { name: 'index gap terminates collection', path: route + '?includeSegmentTypes[0]=Intro&includeSegmentTypes[2]=Commercial' },
    { name: 'uppercase query name', path: route + '?INCLUDESEGMENTTYPES=recap' },
    { name: 'unbound paging and user id do not alter request', path: route + '?limit=1&startIndex=200&userId=bad' },
    { name: 'camel JSON profile', path: route, accept: 'application/json; profile="CamelCase"' },
    { name: 'unsupported POST', path: route, method: 'POST', status: 405 },
  ] };
}
