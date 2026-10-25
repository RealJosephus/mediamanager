const lines = values => values.join('\r\n') + '\r\n';
const document = (body, { head = [], close = ['</BODY>', '</SAMI>'] } = {}) => lines([
  '<SAMI>', '<HEAD>', '<TITLE>Current SAMI boundaries</TITLE>', ...head, '</HEAD>', '<BODY>', ...body, ...close,
]);
const closed = (name, text) => ({ name, format: 'smi', text: document([
  '<SYNC Start=1180>' + text, '<SYNC Start=4250><P>&nbsp;',
]) });

export function subtitleSamiBoundaryInput() {
  const sources = [
    { name: 'attribute-after-start', format: 'smi', text: document([
      '<SYNC Start="1180" ID="first"><P>Attribute after time', '<SYNC Start="4250" ID="last"><P>&nbsp;',
    ]) },
    { name: 'attribute-before-start', format: 'smi', text: document([
      '<SYNC ID="first" Start="1180"><P>Attribute before time', '<SYNC ID="last" Start="4250"><P>&nbsp;',
    ]) },
    { name: 'lowercase-time-spacing', format: 'smi', text: document([
      '<sync start = "1180"><p>Whitespace around time attribute', '<sync start = "4250"><p>&nbsp;',
    ]) },
    { name: 'encrypted-marker-text', format: 'smi', text: document([
      '<sync encrypted="true" start="1180"><P>Ordinary text under the marker flag',
      '<sync encrypted="true" start="4250"><P>&nbsp;',
    ]) },
    closed('multiple-paragraphs-same-class', '<P Class=ENCC>First paragraph</P><P Class=ENCC>Second paragraph</P>'),
    closed('multiple-language-classes', '<P Class=ENCC>English text</P><P Class=FRCC>Texte français</P>'),
    closed('source-id-paragraph', '<P ID=Source>Source caption</P><P>Translated caption</P>'),
    closed('open-font-tag', '<P>Before <font color="#123456">Open color text'),
    closed('comment-before-paragraph', '<!-- cue note --><P>Caption after comment'),
    closed('script-and-style-text', '<P>Before<script>ordinary script text</script><style>p { color: red; }</style>After'),
    { name: 'sync-inside-comment', format: 'smi', text: document([
      '<!-- <SYNC Start=500><P>Comment marker text', '<SYNC Start=1000><P>&nbsp; -->',
      '<SYNC Start=1180><P>Body marker text', '<SYNC Start=4250><P>&nbsp;',
    ]) },
    closed('named-numeric-entities', '<P>&copy; &euro; &alpha; &rarr; &NBSP; &#160; &#xA0; &ThinSpace; end'),
    closed('entity-in-font-attribute', '<P><font face="A &amp; B" color="#123456">Font attribute and &amp; text</font>'),
    { name: 'mixed-case-body-close', format: 'smi', text: document([
      '<SYNC Start=1180><P>Body close text', '<SYNC Start=4250><P>&nbsp;',
    ], { close: ['</BoDy>', '</SaMi>'] }) },
    { name: 'repeated-sync-time', format: 'smi', text: document([
      '<SYNC Start=1180><P>First at same time', '<SYNC Start=1180><P>Second at same time', '<SYNC Start=4250><P>&nbsp;',
    ]) },
    { name: 'reverse-sync-time', format: 'smi', text: document([
      '<SYNC Start=1180><P>First cue', '<SYNC Start=500><P>Earlier marker', '<SYNC Start=4250><P>&nbsp;',
    ]) },
    closed('empty-markup-cue', '<P><i></i>'),
    { name: 'unicode-grapheme-tail', format: 'smi', text: document([
      '<SYNC Start=1180><P>👩‍👩‍👧‍👦 Cafe\u0301 is ready for another subtitle line.<br>中文与方向\u200E标记 remain ordinary text.',
    ]) },
    { name: 'long-markup-tail', format: 'smi', text: document([
      '<SYNC Start=1180><P><i>' + ('A long formatted final cue has many words while preserving the complete original source. ').repeat(18).trim() + '</i>',
    ]) },
  ];
  const windows = [
    { name: 'full', start: '0', end: '0', copy: true },
    { name: 'crop', start: '20000000', end: '80000000', copy: false },
    { name: 'preserve', start: '20000000', end: '80000000', copy: true },
  ];
  return { schemaVersion: 1, sources,
    conversions: sources.flatMap(source => ['srt', 'vtt', 'json', 'ass', 'ssa', 'ttml'].flatMap(format => windows.map(window => ({
      source: source.name, format, ...window, name: `${source.name}-${format}-${window.name}`,
    })))) };
}
