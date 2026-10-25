import legacy from '../subtitle-ass-reference.json' with { type: 'json' };

const texts = [
  ['plain', 'Text, punctuation & Unicode 中文 😀'],
  ['soft-break', 'First\\nSecond'],
  ['hard-break-and-space', 'First\\NSecond\\hword'],
  ['underline', 'Before {\\u1}under{\\u0} after'],
  ['open-italic', '{\\i1}Italic to the end'],
  ['repeated-style', '{\\i1}One {\\i1}two{\\i0} three'],
  ['combined-style', '{\\i1\\b1}Combined{\\b0\\i0}'],
  ['font-face', '{\\fnArial}One{\\fn} two'],
  ['font-size', '{\\fs24.5}One{\\fs} two'],
  ['font-color', '{\\c&H0000FF&}Red{\\c} tail'],
  ['primary-color', '{\\1c&H123456&}Color{\\1c} tail'],
  ['font-attributes', '{\\fnArial\\fs24\\c&H0000FF&\\i1\\q2}Mixed{\\i0}{\\fn}'],
  ['font-switch', '{\\fnArial}One{\\fnVerdana}Two{\\fn} tail'],
  ['color-switch', '{\\c&H0000FF&}Red{\\c&H00FF00&}Green{\\c} tail'],
  ['position', '{\\pos(400,570)}Position'],
  ['decimal-position', '{\\pos(-1,2.5)}Position'],
  ['middle-position', 'Before{\\pos(4,5)}after'],
  ['alignment', '{\\an8}Top text'],
  ['transform', '{\\t(0,1000,\\fs40)}Text'],
  ['drawing-and-text', '{\\p1}m 0 0 l 10 10{\\p0}Text'],
  ['opaque-override', 'Before{\\q2}after'],
  ['html-and-braces', 'Before {note} <b>bold</b> <angle> & after'],
  ['space-preservation', '  leading and trailing  '],
  ['empty-text', ''],
];

export function subtitleTextInput() {
  const sources = [];
  for (const format of ['ass', 'ssa']) {
    const original = Buffer.from(legacy.inputs[format], 'base64').toString('utf8');
    const header = original.slice(0, original.indexOf('Dialogue:'));
    for (const [name, text] of texts) sources.push({ name: `${format}-${name}`, format,
      text: header + `Dialogue: ${format === 'ssa' ? 'Marked=0' : '0'},0:00:01.00,0:00:05.00,Default,,0,0,0,,${text}\r\n` });
    sources.push({ name: `${format}-legacy`, format, text: original });
    sources.push({ name: `${format}-no-dialogue`, format, text: header });
    sources.push({ name: `${format}-default-columns`, format,
      text: header.replace(/^Format: (?:Layer|Marked),.*\r?\n/gmu, '') + `Dialogue: ${format === 'ssa' ? 'Marked=0' : '0'},0:00:01.00,0:00:05.00,Default,,0,0,0,,Default columns\r\n` });
    const leading = format === 'ssa' ? 'Marked=0' : '0';
    for (const [name, start, end] of [
      ['single-fraction', '0:00:01.5', '0:00:05.5'],
      ['three-fraction', '0:00:01.125', '0:00:05.125'],
      ['signed-clock', '+0:+01:-01.+5', '+0:+01:+05.+5'],
      ['normalized-clock', '0:00:61.18', '0:01:05.00'],
    ]) sources.push({ name: `${format}-${name}`, format,
      text: header + `Dialogue: ${leading},${start},${end},Default,,0,0,0,,Clock text\r\n` });
    for (const event of ['Comment', 'Dialog']) sources.push({ name: `${format}-${event.toLowerCase()}`, format,
      text: header + `${event}: ${leading},0:00:01.00,0:00:05.00,Default,,0,0,0,,Event text\r\n` });
    sources.push({ name: `${format}-changed-columns`, format,
      text: header + `Dialogue: ${leading},0:00:01.00,0:00:02.00,Default,,0,0,0,,First\r\n`
        + `Format: ${format === 'ssa' ? 'Marked' : 'Layer'}, End, Start, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n`
        + `Dialogue: ${leading},0:00:07.00,0:00:06.00,Default,,0,0,0,,Second\r\n` });
  }
  for (const [name, text] of [
    ['position', '{\\an8}Top text'], ['left-position', '{\\an1}Left text'], ['right-position', '{\\an9}Right text'],
    ['hex-color', '<font color="#ff0000">Red</font>'], ['non-primary-color', '<font color="#123456">Color</font>'],
    ['alpha-color', '<font color="#80ff0000">Color</font>'], ['named-color', '<font color=red>Red</font>'],
    ['braces', 'Before {note} {\\an8}After {note} tail'], ['escaped-text', 'One\\nTwo\\hword'],
  ]) sources.push({ name: 'srt-' + name, format: 'srt', text: `1\r\n00:00:01,000 --> 00:00:05,000\r\n${text}\r\n\r\n` });
  for (const [name, settings, text] of [
    ['position', 'line:20%', 'Top text'], ['left-position', 'position:20% line:50%', 'Middle left'],
    ['right-position', 'position:80% line:20%', 'Top right'], ['ordinary', 'align:center line:90%', 'Ordinary text'],
    ['hex-color', '', '<font color="#ff0000">Red</font>'], ['escaped-text', '', 'One\\nTwo\\hword'],
    ['extra-spaces', '', 'One  two   three'],
  ]) sources.push({ name: 'vtt-' + name, format: 'vtt', text: `WEBVTT\r\n\r\n00:00:01.000 --> 00:00:05.000 ${settings}\r\n${text}\r\n` });
  const windows = [
    { name: 'full', start: '0', end: '0', copy: true },
    { name: 'crop', start: '20000000', end: '80000000', copy: false },
    { name: 'preserve', start: '20000000', end: '80000000', copy: true },
  ];
  const conversions = sources.flatMap(source => ['srt', 'vtt', 'json'].flatMap(format => windows.map(window => ({
    source: source.name, format, ...window, name: `${source.name}-${format}-${window.name}`,
  }))));
  return { schemaVersion: 1, sources, conversions };
}

export const nativeSourcePaths = [
  'Directory.Packages.props', 'MediaBrowser.Controller/MediaEncoding/ISubtitleEncoder.cs',
  'MediaBrowser.Controller/Library/IMediaSourceManager.cs', 'MediaBrowser.MediaEncoding/Subtitles/SubtitleEditParser.cs',
  'MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs', 'MediaBrowser.MediaEncoding/Subtitles/SubtitleFormatExtensions.cs',
  'MediaBrowser.MediaEncoding/Subtitles/JsonWriter.cs', 'Jellyfin.Api/Controllers/SubtitleController.cs',
  'MediaBrowser.Controller/IO/LocalMediaProxy.cs', 'MediaBrowser.Model/Net/MimeTypes.cs', 'MediaBrowser.Model/Entities/MediaStream.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
];
