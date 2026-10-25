import { subtitleWriterInput } from '../subtitle-writers-current/input.js';

export function subtitleTtmlInput() {
  const { sources } = subtitleWriterInput();
  for (let alignment = 1; alignment <= 9; alignment++) sources.push({ name: 'srt-ttml-alignment-' + alignment, format: 'srt',
    text: `1\r\n00:00:01,180 --> 00:00:05,250\r\n{\\an${alignment}}Position text\r\n\r\n` });
  sources.push({ name: 'srt-ttml-xml-text', format: 'srt', text:
    '1\r\n00:00:01,000 --> 00:00:05,000\r\nText & ampersand &amp; literal &lt;tag&gt; 中文 😀\r\n\r\n'
    + '2\r\n00:00:06,000 --> 00:00:09,000\r\n<font face="Verdana" size="25" color="#123456">Font text</font> and <u>underlined</u>\r\n\r\n' });
  sources.push({ name: 'srt-ttml-open-markup', format: 'srt', text:
    '1\r\n00:00:01,000 --> 00:00:05,000\r\n<i>Open italic\r\n\r\n'
    + '2\r\n00:00:06,000 --> 00:00:09,000\r\n<b>Invalid bold <angle> and a second line\r\nMore text\r\n\r\n' });
  const windows = [
    { name: 'full', start: '0', end: '0', copy: true },
    { name: 'crop', start: '20000000', end: '80000000', copy: false },
    { name: 'preserve', start: '20000000', end: '80000000', copy: true },
  ];
  const conversions = sources.flatMap(source => windows.map(window => ({ source: source.name, format: 'ttml',
    ...window, name: `${source.name}-ttml-${window.name}` })));
  return { schemaVersion: 1, sources, conversions };
}
