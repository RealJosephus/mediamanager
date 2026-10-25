const list = '/FallbackFont/Fonts', file = name => list + '/' + encodeURIComponent(name);
const request = (name, path = list, values = {}) => ({ name, method: 'GET', path, ...values });

// These are ordinary byte fixtures, not generated or decoded audio/video.
export const fallbackFontFiles = [
  { path: 'fonts-A/zero.ttf', bytes: '' },
  { path: 'fonts-A/tiny.WoFf2', bytes: 'AQID' },
  { path: 'fonts-A/Body.TTF', bytes: 'AAECAwQFBgcICQoLDA0ODw==' },
  { path: 'fonts-A/a.woff', bytes: 'YWJjZA==' },
  { path: 'fonts-A/Z.otf', bytes: 'ZWZnaA==' },
  { path: 'fonts-A/ä.ttf', bytes: 'aWprbA==' },
  { path: 'fonts-A/Å.ttf', bytes: 'bW5vcA==' },
  { path: 'fonts-A/ı.ttf', bytes: 'cXJzdA==' },
  { path: 'fonts-A/Font notes.txt', bytes: 'eHl6' },
  { path: 'fonts-A/nested/hidden.ttf', bytes: 'bm90IGltbWVkaWF0ZQ==' },
  { path: 'fonts-A/.hidden.otf', bytes: 'aGlkZGVu' },
  { path: 'fonts-A/.ttf', bytes: 'ZG90' },
  { path: 'fonts-A/stream.woff', length: 64 * 1024 * 1024 },
  { path: 'fonts-B/Body.TTF', bytes: 'bmV3LXJvb3QtYnl0ZXM=' },
  { path: 'fonts-B/other.otf', bytes: 'bmV3' },
  { path: 'one-below/large.ttf', length: 20 * 1024 * 1024 - 1 },
  { path: 'exact/large.ttf', length: 20 * 1024 * 1024 },
  { path: 'sum-exact/first.ttf', length: 10 * 1024 * 1024 },
  { path: 'sum-exact/second.ttf', length: 10 * 1024 * 1024 },
  { path: 'sum-exact/third.ttf', length: 10 * 1024 * 1024 + 1 },
  { path: 'not-a-directory', bytes: 'ZmlsZQ==' },
];

export function fallbackFontInput() {
  const modified = 'Sun, 02 Jun 2024 12:34:56 GMT';
  return [
    { name: 'files-and-http', root: 'fonts-A', steps: [
      request('ordered-list'), request('case-insensitive-file', file('bOdY.tTf')),
      request('arbitrary-extension', file('font NOTES.txt')), request('empty-file', file('ZERO.TTF')),
      request('missing-file', file('missing.ttf')), request('nested-file-not-listed', file('hidden.ttf')),
      request('range-is-ignored', file('Body.TTF'), { headers: { Range: 'bytes=2-5' } }),
      request('invalid-range-is-ignored', file('Body.TTF'), { headers: { Range: 'bytes=1000000-' } }),
      request('if-range-is-ignored', file('Body.TTF'), { headers: { Range: 'bytes=1-2', 'If-Range': modified } }),
      request('modified-since-equal', file('Body.TTF'), { headers: { 'If-Modified-Since': modified } }),
      request('modified-since-old', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Sat, 01 Jun 2024 12:34:56 GMT' } }),
      request('modified-since-future', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Sun, 01 Jan 2090 00:00:00 GMT' } }),
      request('unmodified-since-old', file('Body.TTF'), { headers: { 'If-Unmodified-Since': 'Sat, 01 Jun 2024 12:34:56 GMT' } }),
      request('unmodified-since-equal', file('Body.TTF'), { headers: { 'If-Unmodified-Since': modified } }),
      request('both-date-conditions-permit-the-body', file('Body.TTF'), { headers: { 'If-Modified-Since': modified, 'If-Unmodified-Since': modified } }),
      request('both-date-conditions-fail-before-reading', file('Body.TTF'), { headers: { 'If-Modified-Since': modified, 'If-Unmodified-Since': 'Sat, 01 Jun 2024 12:34:56 GMT' } }),
      request('date-without-weekday', file('Body.TTF'), { headers: { 'If-Modified-Since': '2 Jun 2024 12:34:56 GMT' } }),
      request('date-without-zone-assumes-utc', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Sun, 2 Jun 2024 12:34:56' } }),
      request('date-with-offset', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Sun, 2 Jun 2024 14:34:56 +02:00' } }),
      request('rfc850-date', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Sunday, 02-Jun-24 12:34:56 GMT' } }),
      request('asctime-date', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Sun Jun  2 12:34:56 2024' } }),
      request('invalid-date-weekday', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Mon, 02 Jun 2024 12:34:56 GMT' } }),
      request('invalid-date-rollover', file('Body.TTF'), { headers: { 'If-Modified-Since': 'Fri, 31 Feb 2025 12:34:56 GMT' } }),
      request('invalid-dates', file('Body.TTF'), { headers: { 'If-Modified-Since': 'invalid', 'If-Unmodified-Since': 'invalid' } }),
      request('no-etag-if-match', file('Body.TTF'), { headers: { 'If-Match': '"not-a-tag"' } }),
      request('no-etag-if-none-match', file('Body.TTF'), { headers: { 'If-None-Match': '*' } }),
      request('head-is-not-a-get-route', file('Body.TTF'), { method: 'HEAD' }),
      request('post-is-not-a-get-route', file('Body.TTF'), { method: 'POST' }),
      request('ordinary-user', file('Body.TTF'), { identity: 'regular' }),
      request('api-key', file('Body.TTF'), { identity: 'apiKey' }),
      request('anonymous-list', list, { identity: 'anonymous' }),
      request('anonymous-file', file('Body.TTF'), { identity: 'anonymous' }),
      request('camel-case-list', list, { accept: 'application/json; profile="CamelCase"' }),
      request('swedish-list', list + '?culture=sv-SE'), request('turkish-list', list + '?culture=tr-TR'),
    ] },
    ...['one-below', 'exact', 'sum-exact'].map(root => ({ name: root, root, steps: [request('list')] })),
    ...['missing', 'not-a-directory', null, '', ' '].map((root, index) => ({ name: 'unavailable-root-' + index, root,
      steps: [request('list'), request('file', file('Body.TTF'))] })),
    { name: 'hot-current-and-alias', root: 'fonts-A', steps: [
      request('initial-A'), request('replace-with-B', list, { replaceRoot: 'fonts-B' }),
      request('old-alias-mutation-keeps-B', file('Body.TTF'), { mutateHeldRoot: '' }),
      request('new-alias-mutation-disables-current-only', list, { mutateCurrentRoot: '' }),
      request('new-current-empty-file', file('Body.TTF')),
    ] },
    { name: 'cancel-physical-reader', root: 'fonts-A', steps: [
      request('disconnect-after-prefix', file('stream.woff'), { cancelAfterFirstRead: true }),
    ] },
  ];
}
