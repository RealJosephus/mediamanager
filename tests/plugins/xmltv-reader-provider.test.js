import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createXmlTvListingsProvider } from '../../plugins/xmltv/provider.js';
import { parseXmlTvDate, readXmlTvChannels } from '../../plugins/xmltv/reader.js';
import { dateTicks } from '../../src/library/records.js';
import { clrTrim } from '../../src/metadata/whitespace.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baseFile = new URL('./fixtures/xmltv/input.json', import.meta.url);
const program = (body, attrs = 'channel="c1" start="20261021010203 +0000" stop="20261021020203 +0000"') => `<programme ${attrs}>\n${body}\n</programme>`;
const optional = '<icon src="https://example.invalid/program.png"/>\n<rating><value>TV-G</value></rating>\n';
const channel = '<channel id="c1"><display-name>Channel 1</display-name><icon src="https://example.invalid/channel.png"/></channel>';
const document = contents => '<?xml version="1.0"?><!DOCTYPE tv SYSTEM "https://example.invalid/never-load.dtd"><tv>\n' + channel + '\n' + contents + '\n</tv>';
const wire = value => {
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)
    .map(([key, entry]) => [key, ['StartDate', 'EndDate', 'OriginalAirDate'].includes(key) ? { ticks: String(dateTicks(entry)), utc: entry.endsWith('Z') } : wire(entry)]));
  return value;
};
const readerChannelValues = value => value.map(({ iconsNull: _iconsNull, icons, ...channel }) => ({ ...channel, icons: icons ?? [] }));

test('XMLTV reader and provider records match the actual designated provider and pinned reader', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async () => {
  const input = JSON.parse(await readFile(baseFile)), directory = path.join(validationOutputRoot(), 'xmltv-reader-provider-' + randomUUID());
  await mkdir(directory);
  const base = { start: '2026-10-21T00:00:00.1234567Z', end: '2026-10-22T00:00:00.7654321Z', channelId: 'c1' };
  input.dateCases = ['', '2026', '202610', '2026102', '2026102101', '20261021010203', '20240229010203', '20260229010203',
    '00000101000000', '99991231235959 -1400', '20261021010203 +0900', '20261021010203 -0030', '20261021010203 +1400',
    '20261021010203 +1401', '20261021010203 +9', '20261021010203 +090', '20261021010203 0900', '20261021010203 ++0900',
    '20261021010203\t+0000', '20261021010203\u0085+0000', '20261021010203\n', '20261021010203.1', '20261021010203 UTC'];
  input.xmlCases = [
    { ...base, name: 'complete', xml: document(program('<title>Recorded series</title>\n<sub-title>Episode name</sub-title>\n<desc>Overview 中文</desc>\n'
      + '<category>Kids</category>\n<category>Sports</category>\n<episode-num system="xmltv_ns">2 . 4 . 0</episode-num>\n'
      + '<new/><live/><premiere/>\n<date>2020</date>\n' + optional)) },
    { ...base, name: 'missing-optionals', xml: '<tv><channel id="c1"><display-name>Channel without icon</display-name></channel>'
      + program('<title>No icon or rating</title><category>sports</category>') + '</tv>' },
    { ...base, name: 'movie-overrides-series', xml: document(program('<title>Movie</title>\n<sub-title>Discarded subtitle</sub-title>\n'
      + '<episode-num system="SxxExx">S01E02</episode-num>\n<category>movie</category>\n<previously-shown/>\n' + optional)) },
    { ...base, name: 'language-groups', info: { PreferredLanguage: 'EN' }, xml: document(program('<title lang="es">Spanish</title>\n<title lang="en">English</title>\n'
      + '<category lang="EN">Kids</category>\n<category lang="en">Sports</category>\n<category>Movie</category>\n'
      + '<desc lang="es">Spanish description</desc>\n<desc>Fallback</desc>\n<sub-title/>\n<title>Later title group</title>\n' + optional)) },
    { ...base, name: 'null-server-language', serverLanguage: null, info: { PreferredLanguage: '　' },
      xml: '<tv><channel id="c1"><display-name lang="en">English</display-name><display-name>No language</display-name><icon src="channel.png"/></channel>'
        + program('<title lang="en">English</title><title>No language</title>\n' + optional) + '</tv>' },
    { ...base, name: 'display-names', xml: '<tv><channel id="c1"><display-name lang="fr">Nom</display-name>\n<display-name lang="en">English channel</display-name>'
      + '<display-name>12-3</display-name><display-name>9_8</display-name><icon width="0"/></channel>' + program('<title>Programme</title>\n' + optional) + '</tv>' },
    { ...base, name: 'offset-and-show-id', xml: document(program('<title>Offset</title>\n<episode-num system="xmltv_ns">2147483647.-1.</episode-num>\n'
      + '<previously-shown start="20261020160203 +0000"/>\n' + optional, 'channel="C1" start="20261021010203 +0900" stop="20261021220203 +0900"')) },
    { ...base, name: 'date-and-window', xml: document(program('<title>Ends before fractional start</title>\n' + optional,
      'channel="c1" start="20261020000000" stop="20261021000000"')
      + program('<title>In range</title>\n<episode-num system="dd_progid">EP123.45</episode-num>\n' + optional)
      + program('<title>At range end</title>\n' + optional, 'channel="c1" start="20261022000000" stop="20261023000000"')) },
    { ...base, name: 'exact-window-boundary', start: '2026-10-21T00:00:00.0000000Z', end: '2026-10-22T00:00:00.0000000Z',
      xml: document(program('<title>Ends exactly at start</title>\n' + optional, 'channel="c1" start="20261020000000" stop="20261021000000"')
        + program('<title>Starts exactly at end</title>\n' + optional, 'channel="c1" start="20261022000000" stop="20261023000000"')) },
    { ...base, name: 'adjacent-image-url-skip', xml: document(program('<title>Title</title><image type="still">https://example.invalid/still</image>'
      + '<category>Movie</category><image type="backdrop">https://example.invalid/backdrop</image><desc>Skipped</desc>'
      + '<url>https://example.invalid/url</url><episode-num system="xmltv_ns">0.1.</episode-num>\n' + optional)) },
    { ...base, name: 'malformed-episode', xml: document(program('<title>Title</title><episode-num system="themoviedb.org">series/</episode-num>\n' + optional)) },
    { ...base, name: 'malformed-unused-credit', xml: document(program('<title>Title</title>\n<credits><actor>Name<image><nested/></image></actor></credits>\n' + optional)) },
    { ...base, name: 'empty-genres-null-category-config', info: { KidsCategories: null }, xml: document(program('<title>No genres</title>\n' + optional)) },
    { ...base, name: 'genres-null-category-config', info: { KidsCategories: null }, xml: document(program('<title>Genres</title>\n<category>kids</category>\n' + optional)) },
    { ...base, name: 'rating-and-images', xml: document(program('<title>Images and ratings</title>\n'
      + '<image type="poster">poster.png</image>\n<image type="still">still.png</image>\n<image type="backdrop">backdrop.png</image>\n'
      + '<star-rating><value>4/5</value></star-rating>\n<star-rating><value>7.3</value></star-rating>\n' + optional)) },
    { ...base, name: 'empty-channel-argument', channelId: '　', xml: document(program('<title>Title</title>\n' + optional)) },
    { ...base, name: 'ignored-dtd-unknown-field', xml: document(program('<unknown><nested>Ignored</nested></unknown><title>Title</title>\n' + optional)) },
    { ...base, name: 'undeclared-entity', xml: '<!DOCTYPE tv [<!ENTITY custom "ignored">]><tv>' + channel + program('<title>&custom;</title>\n' + optional) + '</tv>' },
  ];
  const encodedXml = document(program('<title>Encoded 中文</title>\n' + optional));
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(encodedXml.replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="utf-16"?>'), 'utf16le')]);
  const utf32Body = encodedXml.replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="utf-32"?>');
  const utf32 = Buffer.alloc(4 + [...utf32Body].length * 4); utf32.set([0xff, 0xfe, 0, 0]);
  [...utf32Body].forEach((character, index) => utf32.writeUInt32LE(character.codePointAt(0), 4 + index * 4));
  const invalidUtf8 = Buffer.concat([Buffer.from('<tv>' + channel + '<programme channel="c1" start="20261021010000" stop="20261021020000"><title>'),
    Buffer.from([0xff]), Buffer.from('</title>' + optional + '</programme></tv>')]);
  for (const [name, bytes] of [['utf16-input', utf16], ['utf32-input', utf32], ['invalid-utf8-input', invalidUtf8]]) {
    input.xmlCases.push({ ...base, name, sourceBase64: bytes.toString('base64') });
  }
  const inputBytes = Buffer.from(JSON.stringify(input)), filename = path.join(directory, 'input.json'); await writeFile(filename, inputBytes, { flag: 'wx' });
  const recording = await recordOracle({ project: 'tests/plugins/fixtures/xmltv/Oracle.csproj', output: path.join(directory, 'native'), args: [filename, '{output}/native.json'] });
  const nativeBytes = await readFile(path.join(directory, 'native/native.json')), native = JSON.parse(nativeBytes);
  assert.equal(recording.passed, true); assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.privateInputsRemoved, true);
  assert.equal(recording.outputs.find(entry => path.basename(entry.filename) === 'native.json').sha256, sha(nativeBytes));
  const comparisons = [];
  for (const sample of native.dateCases) assert.deepEqual(parseXmlTvDate(sample.input), sample.value ?? null, 'ParseDate:' + sample.input);
  for (const sample of input.xmlCases) {
    const expected = native.xmlCases.find(entry => entry.name === sample.name), root = path.join(directory, 'node', sample.name);
    await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'source.xml'), sample.sourceBase64 ? Buffer.from(sample.sourceBase64, 'base64') : sample.xml);
    const adapter = await LocalAdapter.open({ root }), cachePath = path.join(root, 'cache', 'xmltv');
    const configuredLanguage = Object.hasOwn(sample, 'serverLanguage') ? sample.serverLanguage : 'en';
    const provider = createXmlTvListingsProvider({ cachePath, preferredMetadataLanguage: configuredLanguage,
      source: { stat: (_identity, options) => adapter.stat('/source.xml', options), openRead: (_identity, options) => adapter.openRead('/source.xml', options) } });
    try {
      const info = { ...sample.info, Id: sample.name, Path: path.join(root, 'source.xml') };
      for (const observation of expected.observations) {
        let value, error;
        try {
          if (observation.operation === 'readerChannels') value = readXmlTvChannels(sample.xml, info.PreferredLanguage && clrTrim(info.PreferredLanguage) ? info.PreferredLanguage : configuredLanguage)
            .map(channel => ({ Id: channel.Id, DisplayName: channel.DisplayName, Number: channel.Number,
              iconsNull: channel.Icons === null, icons: channel.Icons?.map(icon => icon.Source) }));
          else if (observation.operation === 'channels') value = await provider.getChannels(info);
          else if (observation.operation === 'programs') value = await provider.getPrograms(info, sample.channelId, sample.start, sample.end);
          else value = await provider.getLineups(info, 'US', 'ignored');
        } catch (caught) { error = caught; }
        comparisons.push({ name: sample.name, operation: observation.operation, value, error: error?.message,
          errorDiagnostic: error && { name: error.name, code: error.code, message: error.message, stack: error.stack },
          nativeValue: observation.value, nativeError: observation.error });
        if (observation.error) assert.ok(error, sample.name + ':' + observation.operation + ': native parse/projection failure must propagate.');
        else {
          assert.equal(error, undefined, sample.name + ':' + observation.operation + ': ' + (error?.stack ?? ''));
          const project = observation.operation === 'readerChannels' ? readerChannelValues : value => value;
          assert.deepEqual(wire(project(value)), wire(project(observation.value)), sample.name + ':' + observation.operation);
        }
      }
      const cached = await readFile(path.join(cachePath, sample.name + '.xml'));
      assert.equal(sha(cached), expected.cachedSha256); assert.equal(sha(cached), expected.sourceSha256);
      assert.deepEqual((await readdir(cachePath)).sort(), [sample.name + '.xml']);
    } finally { await provider.close(); await adapter.close(); }
  }
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ passed: true, phaseAcceptance: false, releaseAcceptance: false, comparisons }, null, 2) + '\n');
});
