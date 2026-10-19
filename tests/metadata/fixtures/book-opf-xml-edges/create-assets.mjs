import { mkdir, writeFile } from 'node:fs/promises';
const root = 'D:/mediamanager-validation/20261016-book-stage/inputs/opf-xml-edge-1';
await mkdir(root); await mkdir(root + '/assets');
const wrap = body => '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">' + body + '</package>';
const withDtd = (dtd, body) => '<!DOCTYPE package [' + dtd + ']>' + wrap(body);
const cases = [
  ['entity-markup', withDtd('<!ENTITY a "A<b>inner</b> tail">', '<dc:title>&a;</dc:title>')],
  ['entity-markup-whitespace', withDtd('<!ENTITY a "<b>one</b> <b>two</b>">', '<dc:title>&a;</dc:title>')],
  ['entity-markup-attribute', withDtd('<!ENTITY a "<b>inner</b>">', '<meta name="calibre:series" content="&a;"/>')],
  ['entity-duplicate', withDtd('<!ENTITY a "first"><!ENTITY a "second">', '<dc:title>&a;</dc:title>')],
  ['entity-comment-literal', wrap('<dc:title><![CDATA[<!DOCTYPE package [<!ENTITY a "fake">]>]]>&a;</dc:title>')],
  ['entity-recursive', withDtd('<!ENTITY a "&b;"><!ENTITY b "&a;">', '<dc:title>&a;</dc:title>')],
  ['dtd-default-attribute', withDtd('<!ATTLIST meta name CDATA "calibre:series" content CDATA "Default series">', '<meta/>')],
  ['parameter-entity', withDtd('<!ENTITY % decl "<!ENTITY a \'Parameter\'>">%decl;', '<dc:title>&a;</dc:title>')],
  ['namespace-duplicate-attribute', '<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:a="urn:a" xmlns:b="urn:a"><dc:title a:id="1" b:id="2">Text</dc:title></package>'],
  ['namespace-invalid-xml', '<package xmlns:xml="urn:wrong"><title/></package>'],
  ['deep-xml', wrap('<dc:title>' + '<a>'.repeat(140) + 'Deep' + '</a>'.repeat(140) + '</dc:title>')],
  ['entity-long', withDtd('<!ENTITY a "' + 'a'.repeat(10001) + '">', '<dc:title>&a;</dc:title>')],
];
const readers=[];
for(const [name,xml] of cases) { const file=name+'.opf'; await writeFile(root+'/assets/'+file,xml,{flag:'wx'});readers.push({name,file}); }
await writeFile(root+'/input.json',JSON.stringify({readers,opf:[],epubs:[],archives:[]},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,cases:readers.length}));
