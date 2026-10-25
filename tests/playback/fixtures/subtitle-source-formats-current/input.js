const lines = values => values.join('\r\n') + '\r\n';

const sami = body => lines([
  '<SAMI>', '<HEAD>', '<TITLE>Current source text</TITLE>', '</HEAD>', '<BODY>', ...body, '</BODY>', '</SAMI>',
]);

export function subtitleSourceFormatInput() {
  const sources = [
    { name: 'smi-plain-multiple', format: 'smi', text: sami([
      '<SYNC Start=1180><P Class=ENCC>First cue, 中文',
      '<SYNC Start=4250><P Class=ENCC>&nbsp;',
      '<SYNC Start=6000><P Class=ENCC>Second cue',
      '<SYNC Start=9250><P Class=ENCC>&nbsp;',
      '<SYNC Start=10000><P Class=ENCC>After the playback window',
      '<SYNC Start=12000><P Class=ENCC>&nbsp;',
    ]) },
    { name: 'smi-breaks-and-entities', format: 'smi', text: sami([
      '<SYNC Start="1180"><P Class="ENCC">First<br>Second &amp; third&nbsp;word',
      '<SYNC Start="5250"><P Class="ENCC">&nbsp;',
      '<SYNC Start="6000"><P Class="ENCC">Before  spaces &lt;literal&gt; after',
      '<SYNC Start="9250"><P Class="ENCC">&nbsp;',
    ]) },
    { name: 'smi-inline-markup', format: 'smi', text: sami([
      '<SYNC Start=1180><P Class=ENCC>Before <i>italic</i> <b>bold</b> <u>underlined</u> after',
      '<SYNC Start=5250><P Class=ENCC>&nbsp;',
      '<SYNC Start=6000><P Class=ENCC><font color="#123456">Color text</font><br>Second line',
      '<SYNC Start=9250><P Class=ENCC>&nbsp;',
    ]) },
    { name: 'smi-no-dialogue', format: 'smi', text: sami([]) },
    { name: 'sub-microdvd-default-fps', format: 'sub', text: lines([
      '{25}{60}First cue, 中文',
      '{75}{125}Second cue',
      '{200}{250}After the playback window',
    ]) },
    { name: 'sub-microdvd-frame-rate-header', format: 'sub', text: lines([
      '{1}{1}23.976',
      '{25}{60}First cue, 中文',
      '{75}{125}Second cue',
      '{200}{250}After the playback window',
    ]) },
    { name: 'sub-microdvd-markup-lines', format: 'sub', text: lines([
      '{25}{125}{y:i}Italic line|{y:b}Bold line|{c:$563412}Color text',
      '{150}{225}{Y:u}Underlined first|Underlined second',
    ]) },
    { name: 'sub-microdvd-no-dialogue', format: 'sub', text: lines(['{25}{60}']) },
    { name: 'sub-subviewer-1-bracketed-times', format: 'sub', text: lines([
      '[INFORMATION]', '[TITLE]', 'Current source text', '[BEGIN]', '******** START SCRIPT ********',
      '[00:00:01]', 'First line|Second line, 中文', '[00:00:04]', '',
      '[00:00:06]', 'Another cue', '[00:00:09]', '', '[END]', '******** END SCRIPT ********',
    ]) },
    { name: 'sub-subviewer-2-times-and-markup', format: 'sub', text: lines([
      '[INFORMATION]', '[TITLE]Current source text', '[END INFORMATION]', '[SUBTITLE]', '',
      '00:00:01.18,00:00:04.25', 'First line[br]Second line, 中文', '',
      '00:00:06.00,00:00:09.25', '{\\i1}Italic{\\i0} and {\\b1}bold{\\b0}', '',
    ]) },
    { name: 'smi-tail-short', format: 'smi', text: sami([
      '<SYNC Start=1180><P Class=ENCC>Short tail.',
    ]) },
    { name: 'smi-tail-markup-entities-unicode', format: 'smi', text: sami([
      '<SYNC Start=1180><P Class=ENCC><i>最后一行，中文</i><br>Before &amp; after <b>bold</b>.',
    ]) },
    { name: 'smi-tail-long', format: 'smi', text: sami([
      '<SYNC Start=1180><P Class=ENCC>' + ('A longer final cue contains many words and several sentences. '
        + 'The reader has no following synchronization marker to supply an explicit end time. '
        + 'This text remains one ordinary subtitle cue for the public reader to handle. ').repeat(6).trim(),
    ]) },
  ];
  const windows = [
    { name: 'full', start: '0', end: '0', copy: true },
    { name: 'crop', start: '20000000', end: '80000000', copy: false },
    { name: 'preserve', start: '20000000', end: '80000000', copy: true },
  ];
  const conversions = sources.flatMap(source => ['srt', 'vtt', 'json', 'ass', 'ssa', 'ttml'].flatMap(format => windows.map(window => ({
    source: source.name, format, ...window, name: `${source.name}-${format}-${window.name}`,
  }))));
  return { schemaVersion: 1, sources, conversions };
}
