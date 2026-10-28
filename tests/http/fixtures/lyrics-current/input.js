import path from 'node:path';

const id = value => 'fa6e0000000000000000' + String(value).padStart(12, '0');
const utf32 = (text, be = false) => {
  const points = [...text].map(character => character.codePointAt(0)), bytes = Buffer.alloc(4 + points.length * 4);
  bytes[be ? 'writeUInt32BE' : 'writeUInt32LE'](0xfeff, 0);
  points.forEach((value, index) => bytes[be ? 'writeUInt32BE' : 'writeUInt32LE'](value, 4 + index * 4)); return bytes;
};

export function lyricInput(root, { metadataPath } = {}) {
  const files = [], items = [], cases = [];
  const file = (name, extension, bytes, options = {}) => {
    const filename = options.filename ?? path.join(root, name + extension), http = options.http === true,
      identity = options.identity ?? (http ? 'http://127.0.0.1:5244/lyrics/' + encodeURIComponent(name) + extension : filename);
    const entry = { name, filename, identity, base64: (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).toString('base64'), ...options };
    files.push(entry); return identity;
  };
  const item = (name, streams = [], options = {}) => {
    const entry = { id: id(items.length + 1), name, streams: streams.map((value, index) =>
      typeof value === 'string' ? { index, path: value, type: 5 } : value), type: 'Audio', ...options };
    items.push(entry); return entry;
  };
  const sample = (name, target, options = {}) => {
    cases.push({ name, path: '/Audio/' + (typeof target === 'string' ? target : target.id) + '/Lyrics', status: 200, ...options });
  };
  const lrc = file('ordered', '.LRC', '[ar:Ignored metadata]\r\n[offset:-900]\r\n[00:03.12] Last\r[00:01.234] First\n[00:01.234] Same start\n');
  const simple = item('ordered LRC', [lrc]); sample('sorted lines and ignored metadata', simple);
  sample('leading-dot lyric filename keeps its extension', item('dotfile', [file('', '.lrc', '[00:01.25] Dotfile lyric')]));
  if (metadataPath) sample('stored virtual metadata path resolves before lyric consumption', item('virtual metadata path', [
    file('virtual metadata path', '.lrc', '[00:01.25] Stored internal lyric', {
      filename: path.join(metadataPath, 'lyrics-private', 'virtual.lrc'),
      identity: path.join('%MetadataPath%', 'lyrics-private', 'virtual.lrc'),
    }),
  ]));
  const enhanced = file('cues 空白', '.elrc', '[00:01.00]<00:01.00>  One <00:01.20>  <00:01.40>😀 字 <00:01.70> end<00:02.00>\n[00:03.00] prefix <00:03.20>next\n[00:04.00]<00:04.10>last');
  sample('ELRC UTF16 positions, spaces, explicit ends and next-line end', item('enhanced', [enhanced]));
  for (const [name, text] of [
    ['multiple starts retain word tags', '[00:03.00][00:01.00]<00:01.00> unchanged <00:01.20>tags'],
    ['tags anywhere in a line', '  Before [00:02.34] middle [00:01.23] after  '],
    ['malformed timestamps fall back to TXT', '[00:01] no fraction\r\n[00:02.1] short\nplain'],
    ['parse failure falls back for the complete file', '[2147483648:00.00] too large\n[00:01.00] otherwise valid'],
    ['unchecked Int32 arithmetic', '[2147483647:99.999] wrapped\n[00:01.00] ordinary'],
    ['BMP decimal digits fail Int32 parsing', '[٠٠:٠١.٠٠] invalid integer\n[00:01.00] otherwise valid'],
    ['astral decimal digits are not CLR regex digits', '[𝟎𝟎:𝟎𝟏.𝟎𝟎] ignored\n[00:01.00] retained'],
    ['empty timed lines are returned', '[00:02.00]\n[00:01.00]<00:01.10><00:01.20>'],
    ['duplicate tags and same time cues', '[00:01.00]<00:01.00>A<00:01.10><00:01.20>B<00:01.20>'],
    ['whitespace and metadata only use TXT', '\u0085 [ti:kept in fallback] \u0085\r\n\r\n'],
  ]) sample(name, item(name, [file(name, '.lrc', text)]));
  for (const [name, text] of [
    ['plain text preserves blank lines and CLR trim', '\u0085 first \u0085\r\n\r second\n\uFEFFlast\u200b \n'],
    ['empty text has one empty line', ''],
    ['TXT timestamps remain text', '[00:01.00] literal'],
  ]) sample(name, item(name, [file(name, '.txt', text)]));
  const timed = '[00:01.23] 編碼 😀\n';
  for (const [name, bytes] of [
    ['UTF8 BOM', Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(timed)])],
    ['double UTF8 BOM', Buffer.concat([Buffer.from([239, 187, 191, 239, 187, 191]), Buffer.from(timed)])],
    ['UTF16LE BOM', Buffer.concat([Buffer.from([255, 254]), Buffer.from(timed, 'utf16le')])],
    ['UTF16BE BOM', Buffer.concat([Buffer.from([254, 255]), Buffer.from(timed, 'utf16le').swap16()])],
    ['UTF32LE BOM', utf32(timed)],
    ['UTF32BE without charset stays UTF8', utf32(timed, true)],
    ['invalid UTF8 replacement', Buffer.concat([Buffer.from('[00:01.00] '), Buffer.from([0xe2, 0x28, 0xa1, 0xc0, 0xaf])])],
  ]) sample(name, item(name, [file(name, '.lrc', bytes)]));
  const txt = file('first TXT', '.txt', 'first TXT wins');
  sample('first recognized stream wins regardless of default/language', item('TXT first', [
    { index: 9, path: lrc, type: 5, isDefault: true, language: 'eng' },
    { index: 3, path: txt, type: 5, isDefault: false, language: 'zho' },
    { index: 0, path: path.join(root, 'not-read.mp3'), type: 0 },
  ]));
  const malformed = file('first malformed', '.lrc', '[bad] first fallback wins');
  sample('malformed first LRC uses TXT before later valid LRC', item('fallback first', [malformed, lrc]));
  const unsupported = file('unsupported', '.bin', '[00:00.00] unsupported extension');
  sample('continues after 129 readable unsupported streams', item('many descriptors', [
    ...Array.from({ length: 129 }, (_, index) => ({ index, path: unsupported, type: 5 })), { index: 129, path: lrc, type: 5 },
  ]));
  sample('only unsupported extensions return 404', item('unsupported only', [unsupported]), { status: 404 });
  const absent = path.join(root, 'absent.lrc');
  sample('read failure does not fall through to later stream', item('missing first', [absent, lrc]), { status: 500 });
  sample('empty lyric path is a bad request before fallback', item('empty path', [{ index: 0, path: '', type: 5 }, { index: 1, path: lrc, type: 5 }]), { status: 400 });
  sample('null lyric path fails before fallback', item('null path', [{ index: 0, path: null, type: 5 }, { index: 1, path: lrc, type: 5 }]), { status: 500 });
  sample('zero lyric streams', item('none'), { status: 404 });
  sample('non-Audio item', item('book', [lrc], { type: 'Book' }), { status: 404 });
  sample('AudioBook inherits Audio', item('audiobook', [lrc], { type: 'AudioBook' }));
  const hidden = item('hidden', [lrc], { hidden: true }); sample('administrator can read hidden', hidden);
  sample('regular user cannot read hidden', hidden, { identity: 'regular', status: 404 });
  sample('regular user can read lyrics without management permission', simple, { identity: 'regular' });
  for (const [name, content, options] of [
    ['HTTP declared Latin1', Buffer.from('[00:01.23] caf\xe9', 'latin1'), { contentType: 'text/plain; charset=iso-8859-1' }],
    ['HTTP quoted UTF16BE', Buffer.concat([Buffer.from([254, 255]), Buffer.from(timed, 'utf16le').swap16()]), { contentType: 'text/plain; charset="utf-16BE"' }],
    ['HTTP declared UTF8 overrides UTF16 BOM', Buffer.concat([Buffer.from([255, 254]), Buffer.from(timed, 'utf16le')]), { contentType: 'text/plain; charset=utf-8' }],
    ['HTTP declared UTF32BE', utf32(timed, true), { contentType: 'text/plain; charset=utf-32BE' }],
    ['HTTP invalid charset fails before parsing', timed, { contentType: 'text/plain; charset=invalid-lyrics-charset', status: 500 }],
    ['HTTP 404 is a manager failure', timed, { sourceStatus: 404, status: 500 }],
  ]) {
    const { status, ...source } = options;
    sample(name, item(name, [file(name, '.lrc', content, { http: true, ...source }), lrc]), { status: status ?? 200 });
  }
  sample('API key has userless access', simple, { identity: 'apiKey' });
  sample('anonymous request', simple, { identity: 'anonymous', status: 401 });
  sample('invalid token request', simple, { identity: 'invalid', status: 401 });
  sample('missing item', id(999999), { status: 404 });
  sample('empty GUID', '0'.repeat(32), { status: 400 });
  sample('malformed GUID', 'bad-guid', { status: 400 });
  sample('HEAD has no action', simple, { method: 'HEAD', status: 405 });
  sample('CamelCase profile', simple, { accept: 'application/json; profile="CamelCase"' });
  sample('fr-FR parsing', simple, { culture: 'fr-FR' });
  sample('tr-TR parsing', simple, { culture: 'tr-TR' });
  sample('unbound query does not select a different user or stream', simple, { suffix: '?userId=invalid&index=9&startPositionTicks=9000000' });
  return { files, items, cases };
}
