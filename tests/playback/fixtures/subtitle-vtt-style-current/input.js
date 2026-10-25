const source = (name, rules, text) => ({ name, format: 'vtt', text: 'WEBVTT\r\n\r\nSTYLE\r\n'
  + rules.join('\r\n') + '\r\n\r\n00:00:01.180 --> 00:00:05.250\r\n' + text + '\r\n' });

export function subtitleVttStyleInput() {
  const tone = '::cue(.tone) { color: #123456; }';
  const sources = [
    source('whole-class', [tone], '<c.tone>Whole cue, 中文</c>'),
    source('partial-class', [tone], 'Before <c.tone>styled</c> after\r\nSecond line'),
    source('adjacent-classes', [
      '::cue(.warm) { color: #ff0000; font-weight: bold; }',
      '::cue(.cool) { color: #00ff00; font-style: italic; }',
    ], '<c.warm>Warm</c> <c.cool>Cool</c> tail'),
    source('nested-class-reset', [
      '::cue(.loud) { color: #ff0000; font-weight: bold; font-style: italic; text-decoration: underline; }',
      '::cue(.calm) { color: #123456; font-weight: normal; font-style: normal; text-decoration: none; }',
    ], '<c.loud>One <c.calm>Two</c> Three</c> tail'),
    source('font-and-colors', [
      '::cue(.tone) {',
      '  color: rgba(18,52,86,0.5);',
      '  background-color: #abcdef80;',
      '  font-family: Verdana;',
      '  font-weight: bolder;',
      '  font-style: oblique;',
      '  text-decoration: underline;',
      '}',
    ], '<c.tone>Font and colors</c>'),
    source('shadow-class', ['::cue(.shade) { color: #123456; text-shadow: #101010 3px; }'],
      'Before <c.shade>Shadow</c> tail'),
    source('standard-shadow-shape', ['::cue(.shade) { color: #123456; text-shadow: #101010 1px 1px 3px; }'],
      'Before <c.shade>Shadow</c> tail'),
    source('font-size-control', ['::cue(.tone) { color: #123456; font-size: 40px; }'], '<c.tone>Whole cue, 中文</c>'),
  ];
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
