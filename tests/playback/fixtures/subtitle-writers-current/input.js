import { subtitleTextInput } from '../subtitle-text-current/input.js';

const assHeader = [
  '[Script Info]', 'Title: Current writer text 中文', 'ScriptType: v4.00+', 'PlayResX: 640', 'PlayResY: 360', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  'Style: Top,Verdana,30.5,&H2000FF00,&H00FF0000,&H400000FF,&H80010203,-1,-1,-1,0,90,110,1.5,-2,3,2.5,3.5,8,12,13,14,1',
  '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
].join('\r\n') + '\r\n';

export function subtitleWriterInput() {
  const { sources } = subtitleTextInput();
  sources.push({ name: 'ass-event-fields', format: 'ass', text: assHeader
    + 'Dialogue: 5,0:00:01.18,0:00:04.99,Top,Alice,0012,0013,0014,Banner;10,{\\an8}First\\N{\\i1}second{\\i0}\r\n'
    + 'Comment: 7,0:00:05.00,0:00:06.00,Top,Bob,21,22,23,Scroll up;4;5,Comment text\r\n'
    + 'Dialog: -2,0:00:07.00,0:00:09.25,Missing,Charlie,0,0,0,,Unknown style text\r\n' });
  sources.push({ name: 'ass-reordered-event-fields', format: 'ass', text: assHeader
    + 'Format: End, Start, Style, Layer, Actor, MarginV, MarginR, MarginL, Effect, Text\r\n'
    + 'Dialogue: 0:00:06.00,0:00:01.00,Top,9,Actor,24,23,22,Karaoke,Text, comma\r\n' });
  sources.push({ name: 'ass-style-fallback', format: 'ass', text: assHeader.replace('Style: Default,', 'Style: First,')
    + 'Dialogue: 0,0:00:01.00,0:00:05.00,,,0,0,0,,No event style\r\n' });
  sources.push({ name: 'ass-attachment-text', format: 'ass', text: assHeader
    + 'Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,Attachment sections stay text\r\n'
    + '\r\n[Fonts]\r\nfontname: fixture.txt\r\n!!!!\r\n\r\n[Graphics]\r\nfilename: fixture.txt\r\n!!!!\r\n' });
  sources.push({ name: 'srt-centisecond-boundaries', format: 'srt', text:
    '1\r\n00:00:01,994 --> 00:00:01,995\r\nRound or truncate\r\n\r\n'
    + '2\r\n00:00:59,995 --> 00:01:00,999\r\nCarry into the next minute\r\n\r\n'
    + '3\r\n01:59:59,999 --> 02:00:00,001\r\nCarry into the next hour\r\n\r\n' });
  sources.push({ name: 'srt-html-fonts', format: 'srt', text:
    '1\r\n00:00:01,000 --> 00:00:05,000\r\n<font face="Verdana" size="24.5" color="#123456">First</font> tail\r\n\r\n'
    + '2\r\n00:00:06,000 --> 00:00:09,000\r\n<i><b><u>Mixed</u></b></i> <font color=red>red</font>\r\n\r\n'
    + '3\r\n00:00:10,000 --> 00:00:13,000\r\n<font color="#ff000080">Alpha text</font> tail\r\n\r\n' });
  sources.push({ name: 'vtt-inline-classes', format: 'vtt', text:
    'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:05.000\r\n<c.red>Red</c> <c.lime.b>green bold</c> tail\r\n\r\n'
    + '00:00:06.000 --> 00:00:09.000 line:20%\r\n<i>Italic</i> and <b>bold</b>\r\n' });
  const windows = [
    { name: 'full', start: '0', end: '0', copy: true },
    { name: 'crop', start: '20000000', end: '80000000', copy: false },
    { name: 'preserve', start: '20000000', end: '80000000', copy: true },
  ];
  const conversions = sources.flatMap(source => ['ass', 'ssa'].flatMap(format => windows.map(window => ({
    source: source.name, format, ...window, name: `${source.name}-${format}-${window.name}`,
  }))));
  return { schemaVersion: 1, sources, conversions };
}
