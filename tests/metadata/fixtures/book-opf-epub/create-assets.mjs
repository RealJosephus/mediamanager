import { mkdir, writeFile, utimes, readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
const root='D:/mediamanager-validation/20261016-book-stage/inputs/'+(process.argv[2]??'opf-epub-1');
await mkdir(root,{recursive:true}); await mkdir(root+'/assets');
const assets=root+'/assets', readers=[], opf=[], epubs=[];
const wrap=body=>`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>${body}</metadata></package>`;
const rich=wrap('<dc:title id="short">First title</dc:title><dc:title id="main"> Rich title </dc:title><meta property="title-type" refines="#main">MAIN</meta><meta property="file-as" refines="#main"> Sort title </meta><dc:description>Overview <b>nested</b> tail &amp; value</dc:description><dc:publisher> Publisher </dc:publisher><dc:language> zh-TW </dc:language><dc:identifier opf:scheme="AMAZON"> A1 </dc:identifier><dc:identifier opf:scheme="GOOGLE">g1</dc:identifier><dc:identifier opf:scheme="ISBN">978-123</dc:identifier><dc:date>2024-03-02T23:04:05Z</dc:date><dc:subject>Fiction / History &amp; Art,Science; Adventure - Fantasy</dc:subject><dc:subject>fiction</dc:subject><dc:creator opf:role="aut">Tolkien, J.R.R.; Other Author</dc:creator><dc:creator opf:role="ill"> Artist </dc:creator><meta name="calibre:series" content=" Series "/><meta name="calibre:series_index" content="2.5"/><meta name="calibre:rating" content="3.5"/>');
async function file(name,bytes){const target=assets+'/'+name;await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});return name;}
async function reader(name,xml,options={}){const filename=await file('reader/'+name+'.opf',Buffer.isBuffer(xml)?xml:Buffer.from(xml));readers.push({name,file:filename,...options});}
await reader('rich',rich);
await reader('empty','<anything/>'); await reader('wrong-namespace','<package><metadata><title>Ignored</title></metadata></package>');
await reader('alternate-prefix',`<p:package xmlns:p="http://www.idpf.org/2007/opf" xmlns:d="http://purl.org/dc/elements/1.1/"><d:title>Alias</d:title><d:creator p:role="edt">Editor, Alice</d:creator><d:identifier p:scheme="ISBN">123</d:identifier></p:package>`);
await reader('last-main-first-sort',wrap('<dc:title id="a">One</dc:title><dc:title id="b">Two</dc:title><meta property="title-type" refines="##a">main</meta><meta property="title-type" refines="#b">main</meta><meta property="file-as" refines="#missing">Skip</meta><meta property="file-as" refines="#a">Sort One</meta><meta property="file-as" refines="#b">Sort Two</meta>'));
await reader('empty-main-fallback',wrap('<dc:title id="a">Fallback</dc:title><dc:title id="b"/><meta property="title-type" refines="#b">main</meta><meta name="calibre:title_sort" content="Calibre sort"/>'));
await reader('creator-roles',wrap(['arr','art','aut','aqt','aft','aui','edt','ill','lyr','mus','nrt','oth','trl','EDT',''].map((role,index)=>`<dc:creator opf:role="${role}">Last${index}, A.B.</dc:creator>`).join('')+'<dc:creator>𝔄.B.; É.F.; John ; john; Doe,, Jane; ;</dc:creator>'));
await reader('first-whitespace',wrap('<dc:title> </dc:title><dc:title>Later</dc:title><dc:description> </dc:description><dc:description>Later</dc:description><dc:publisher> </dc:publisher><dc:publisher>Later</dc:publisher><dc:language> </dc:language><dc:language>en</dc:language><dc:subject> x / X /  / ; a - b </dc:subject>'));
await reader('ids-case-duplicate',wrap('<dc:identifier opf:scheme="ISBN">first</dc:identifier><dc:identifier opf:scheme="ISBN">second</dc:identifier><dc:identifier opf:scheme="isbn">lower</dc:identifier><dc:identifier opf:scheme="AMAZON"> </dc:identifier><dc:identifier opf:scheme="AMAZON">later</dc:identifier>'));
for(const [index,number] of ['2.5','3.5','-2.5','-3.5','2.50000001','NaN','Infinity','2147483647.4','2147483647.5','-2147483648.5','1e2','1,5','not-a-number',''].entries())await reader('numbers-'+index,wrap(`<meta name="calibre:series_index" content="${number}"/><meta name="calibre:rating" content="${number}"/><meta name="calibre:series" content=" "/>`));
for(const [index,date]of ['2024-03-02','2024-03-02T23:04:05Z','2024-03-02T00:04:05+14:00','0001-01-01','9999-12-31','2024','March 2024','2024-02-30','2024-03-02T23:59:59.9999999-08:00'].entries())await reader('date-'+index,wrap(`<dc:date>${date}</dc:date>`));
await reader('refinement-apostrophe',wrap('<dc:title id="a">Title</dc:title><meta property="title-type" refines="#a&apos;b">main</meta>'));
await reader('malformed','<package><broken></package>');
await reader('internal-dtd','<!DOCTYPE package [<!ENTITY booktitle "Entity title">]>'+wrap('<dc:title>&booktitle;</dc:title>').replace(/^<\?xml[^>]+>/u,''));
await reader('external-dtd','<!DOCTYPE package SYSTEM "file:///D:/mediamanager-validation/never-created-opf-entity.dtd">'+wrap('<dc:title>Title</dc:title>').replace(/^<\?xml[^>]+>/u,''));
await reader('invalid-character',wrap('<dc:title>bad\u0001name</dc:title>'));
await reader('utf8-bom',Buffer.concat([Buffer.from([239,187,191]),Buffer.from(wrap('<dc:title>中文 Café</dc:title>'))]));
await reader('utf16le-bom',Buffer.concat([Buffer.from([255,254]),Buffer.from(wrap('<dc:title>中文 Café</dc:title>').replace('utf-8','utf-16'),'utf16le')]));
await reader('utf16be-bom',Buffer.concat([Buffer.from([254,255]),Buffer.from(wrap('<dc:title>中文 Café</dc:title>').replace('utf-8','utf-16'),'utf16le').swap16()]));
await reader('utf16le-no-bom',Buffer.from(wrap('<dc:title>No BOM 中文</dc:title>').replace('utf-8','utf-16'),'utf16le'));
await reader('latin1-declaration',Buffer.from(wrap('<dc:title>Café ©</dc:title>').replace('utf-8','iso-8859-1'),'latin1'));
await reader('cp1252-declaration',Buffer.concat([Buffer.from(wrap('<dc:title>XX</dc:title>').replace('utf-8','windows-1252').replace('XX','A')),Buffer.alloc(0)]));
await reader('invalid-utf8',Buffer.concat([Buffer.from(wrap('<dc:title>XX</dc:title>').split('XX')[0]),Buffer.from([0xc3,0x28]),Buffer.from('</dc:title></metadata></package>')]));
await reader('cancelled-valid',rich,{cancelled:true}); await reader('cancelled-malformed','<broken>',{cancelled:true});
for(const item of readers.filter(value=>value.name==='cp1252-declaration')){const filename=assets+'/'+item.file;const bytes=Buffer.from(wrap('<dc:title>€ “quoted”</dc:title>').replace('utf-8','windows-1252').replace('€','\x80').replace('“','\x93').replace('”','\x94'),'latin1');await writeFile(filename,bytes);}
async function opfCase(name,{directory=false,missing=false,candidates=[],cancelled=false,locked=false,deltaTicks=1}={}){const base='opf/'+name,item=base+'/'+(directory?'Volume':'book.epub');if(directory)await mkdir(assets+'/'+item,{recursive:true});else if(!missing)await file(item,Buffer.from('book payload'));
 const parent=directory?item:base;for(const [name,xml]of candidates)await file(parent+'/'+name,xml);opf.push({name,path:item,cancelled,locked,deltaTicks});}
await opfCase('specific-first',{candidates:[['book.opf',wrap('<dc:title>Specific</dc:title>')],['content.opf',rich],['metadata.opf',rich]]});
await opfCase('content-second',{candidates:[['content.opf',wrap('<dc:title>Content</dc:title>')],['metadata.opf',rich]]});
await opfCase('metadata-last',{candidates:[['metadata.opf',wrap('<dc:title>Calibre</dc:title>')]]});
await opfCase('directory-specific',{directory:true,candidates:[['Volume.opf',wrap('<dc:title>Directory</dc:title>')],['content.opf',rich]]});
await opfCase('missing-all');await opfCase('missing-parent-source',{missing:true,candidates:[['book.opf',rich]]});
await opfCase('malformed-specific',{candidates:[['book.opf','<broken>'],['content.opf',rich]]});
await opfCase('cancelled-existing',{candidates:[['book.opf',rich]],cancelled:true});await opfCase('cancelled-missing',{cancelled:true});
await opfCase('locked-selected',{candidates:[['book.opf',rich]],locked:true});
for(const deltaTicks of [-1,0,1])await opfCase('mtime-'+deltaTicks,{candidates:[['book.opf',rich]],deltaTicks});
let crcTable;function crc(bytes){crcTable??=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});let v=0xffffffff;for(const b of bytes)v=crcTable[(v^b)&255]^(v>>>8);return(v^0xffffffff)>>>0;}
function zip(entries,{reverseCentral=false}={}){const local=[],records=[];let position=0;for(const {key,data,nameBytes,localNameBytes,flags=0x800,extra=Buffer.alloc(0)}of entries){const name=nameBytes??Buffer.from(key),localName=localNameBytes??name,bytes=Buffer.from(data),compressed=deflateRawSync(bytes),l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(flags,6);l.writeUInt16LE(8,8);l.writeUInt32LE(crc(bytes),14);l.writeUInt32LE(compressed.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(localName.length,26);local.push(l,localName,compressed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(flags,8);c.writeUInt16LE(8,10);c.writeUInt32LE(crc(bytes),16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt16LE(extra.length,30);c.writeUInt32LE(position,42);records.push(Buffer.concat([c,name,extra]));position+=l.length+localName.length+compressed.length;}if(reverseCentral)records.reverse();const size=records.reduce((n,b)=>n+b.length,0),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(entries.length,8);e.writeUInt16LE(entries.length,10);e.writeUInt32LE(size,12);e.writeUInt32LE(position,16);return Buffer.concat([...local,...records,e]);}
const container=(opfPath,extra='')=>`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opfPath}"/>${extra}</rootfiles></container>`;
const coverBytes=await readFile('D:/mediamanager/tests/metadata/fixtures/photo-provider/assets/plain.png');await file('cover.png',coverBytes);
async function epub(name,{containerKey='META-INF\\container.xml',opfKey='OPS/package.opf',containerXml,opfXml=rich,coverKey='OPS\\cover.png',cancelled=false,extension='.epub',entries,raw,directory=false}={}){const namePath='epub/'+name+extension;let data=entries??[{key:containerKey,data:containerXml??container(opfKey)},{key:opfKey,data:opfXml},{key:coverKey,data:coverBytes}];if(directory)await mkdir(assets+'/'+namePath,{recursive:true});else await file(namePath,raw??zip(data));epubs.push({name,path:namePath,cancelled});}
const coverOpf=wrap('<dc:title>Embedded title</dc:title><item properties="cover-image" href="cover.png" media-type="image/png"/>');
await epub('standard-slashes',{containerKey:'META-INF/container.xml',coverKey:'OPS/cover.png',opfXml:coverOpf});
await epub('back-container-slash-cover',{coverKey:'OPS/cover.png',opfXml:coverOpf});
await epub('back-container-back-cover',{opfXml:coverOpf});
await epub('all-backslashes',{opfKey:'OPS\\package.opf',opfXml:coverOpf});
await epub('root-opf',{opfKey:'package.opf',coverKey:'cover.png',opfXml:coverOpf});
await epub('missing-container',{entries:[{key:'OPS/package.opf',data:rich}]});
await epub('wrong-container-namespace',{containerXml:'<container><rootfile full-path="OPS/package.opf"/></container>'});
await epub('first-rootfile-missing',{containerXml:container('missing.opf','<rootfile full-path="OPS/package.opf"/>')});
await epub('missing-opf',{containerXml:container('missing.opf')});
await epub('empty-root-path',{containerXml:container('')});
await epub('malformed-container',{containerXml:'<broken>'}); await epub('malformed-opf',{opfXml:'<broken>'});
await epub('corrupt-zip',{raw:Buffer.from('invalid ZIP bytes')});await epub('wrong-extension',{extension:'.zip',opfXml:coverOpf});
await epub('upper-extension',{extension:'.EPUB',opfXml:coverOpf});await epub('directory',{directory:true});
await epub('cancelled-valid',{cancelled:true,opfXml:coverOpf});await epub('cancelled-missing-container',{cancelled:true,entries:[]});await epub('cancelled-malformed-opf',{cancelled:true,opfXml:'<broken>'});
await epub('duplicate-container',{entries:[{key:'META-INF\\container.xml',data:container('missing.opf')},{key:'META-INF\\container.xml',data:container('OPS/package.opf')},{key:'OPS/package.opf',data:coverOpf}]});
const coverCases=[['tokens','<item properties="nav cover-image" href="cover.png" media-type="image/png"/>'],['literal-star','<item id="*cover-image" href="cover.png" media-type="image/png"/>'],['id-cover-real-mime','<item id="cover" href="cover.png" media-type="image/png"/>'],['id-cover-wild-mime','<item id="cover" href="cover.png" media-type="image/*"/>'],['meta-id','<meta name="cover" content="c"/><item id="c" href="cover.png" media-type="image/png"/>'],['webp-mime','<item properties="cover-image" href="cover.png" media-type="image/webp"/>'],['plain-mime','<item properties="cover-image" href="cover.png" media-type="text/plain"/>'],['unknown-mime','<item properties="cover-image" href="cover.png" media-type="not/a-type"/>'],['first-invalid','<item properties="cover-image" href="" media-type="image/png"/><item properties="cover-image" href="cover.png" media-type="image/png"/>'],['apostrophe','<meta name="cover" content="a&apos;b"/>'],['href-dot','<item properties="cover-image" href="./cover.png" media-type="image/png"/>'],['href-percent','<item properties="cover-image" href="cover%20image.png" media-type="image/png"/>']];
for(const [name,body]of coverCases)await epub('cover-'+name,{opfXml:wrap('<dc:title>Cover case</dc:title>'+body)});

await reader('unknown-entity',wrap('<dc:title>&unknown;</dc:title>'));
await reader('external-entity','<!DOCTYPE package [<!ENTITY t SYSTEM "file:///D:/mediamanager-validation/never-created-opf-entity.txt">]>'+wrap('<dc:title>before&t;after</dc:title>').replace(/^<\?xml[^>]+>/u,''));
await reader('cdata-comments',wrap('<dc:title>A<![CDATA[<B>]]><!-- ignored --> C</dc:title><dc:description><b>one</b> <b>two</b></dc:description>'));
await reader('numeric-references',wrap('<dc:title>&#65;&#x4E2D;&#9;Z</dc:title><dc:description>&#0;</dc:description>'));
await reader('unbound-prefix','<package><dc:title>Bad prefix</dc:title></package>');
await reader('attribute-whitespace',wrap('<meta name="calibre:series" content="a\t\nb"/><dc:creator opf:role="edt\t">Last, First</dc:creator>').replaceAll('\\t','\t').replaceAll('\\n','\n'));
function utf32(value,big){const values=[...value],bytes=Buffer.alloc(values.length*4);for(let i=0;i<values.length;i++)bytes[big?'writeUInt32BE':'writeUInt32LE'](values[i].codePointAt(0),i*4);return bytes;}
await reader('utf32le-bom',Buffer.concat([Buffer.from([255,254,0,0]),utf32(wrap('<dc:title>中文 😀</dc:title>').replace('utf-8','utf-32'),false)]));
await reader('utf32be-bom',Buffer.concat([Buffer.from([0,0,254,255]),utf32(wrap('<dc:title>中文 😀</dc:title>').replace('utf-8','utf-32'),true)]));
await reader('utf16be-no-bom',Buffer.from(wrap('<dc:title>No BOM 中文</dc:title>').replace('utf-8','utf-16'),'utf16le').swap16());
await reader('bom-declaration-conflict',Buffer.concat([Buffer.from([255,254]),Buffer.from(wrap('<dc:title>Conflict</dc:title>'),'utf16le')]));
for(const [name,mime]of [['gif','image/gif'],['bmp','image/bmp'],['jpeg','image/jpeg'],['png-parameters','image/png; charset=utf-8']])await epub('cover-format-'+name,{opfXml:wrap('<item properties="cover-image" href="cover.png" media-type="'+mime+'"/>')});

for(const [name,value]of [['null','0'],['control','1'],['noncharacter','65535'],['surrogate','55296'],['too-large','1114112']])await reader('reference-'+name,wrap('<dc:title>&#'+value+';</dc:title>'));
await reader('utf32be-explicit',Buffer.concat([Buffer.from([0,0,254,255]),utf32(wrap('<dc:title>BE explicit</dc:title>').replace('utf-8','utf-32BE'),true)]));
await reader('xml-space-preserve',wrap('<dc:description xml:space="preserve"><b>one</b> <b>two</b></dc:description>'));
await reader('xml-space-cdata',wrap('<dc:description><b>one</b><![CDATA[ ]]><b>two</b></dc:description>'));
await reader('external-entity-attribute','<!DOCTYPE package [<!ENTITY t SYSTEM "file:///D:/mediamanager-validation/never-created-opf-entity.txt">]>'+wrap('<meta name="calibre:series" content="before&t;after"/>').replace(/^<\?xml[^>]+>/u,''));

await reader('literal-crlf',wrap('<dc:title>one\r\ntwo</dc:title><meta name="calibre:series" content="a\r\nb"/>').replaceAll('\\r','\r').replaceAll('\\n','\n'));
await reader('literal-cr',wrap('<dc:description>one\rtwo</dc:description>').replaceAll('\\r','\r'));
await reader('nested-entity','<!DOCTYPE package [<!ENTITY a "Book"><!ENTITY b "&a; title">]>'+wrap('<dc:title>&b;</dc:title>').replace(/^<\?xml[^>]+>/u,''));
await epub('nested-opf-directory',{opfKey:'OPS/Inner/package.opf',coverKey:'OPS\\Inner\\cover.png',opfXml:coverOpf});
await epub('rich-with-cover',{opfXml:rich.replace('</metadata>','<item properties="cover-image" href="cover.png" media-type="image/png"/></metadata>')});
const archives=[];
async function archive(name,entries,queries,options){const filename=await file('archive/'+name+'.zip',zip(entries,options));archives.push({name,file:filename,queries});}
await archive('non-utf8-byte',[{key:'unused',nameBytes:Buffer.from([0x82,0x2e,0x6f,0x70,0x66]),flags:0,data:'legacy'}],['�.opf','é.opf']);
await archive('non-utf8-valid-utf8',[{key:'é.opf',flags:0,data:'utf8'}],['é.opf','├⌐.opf']);
const oldName=Buffer.from('old.opf'),newName=Buffer.from('new.opf'),unicode=Buffer.alloc(9+newName.length);unicode.writeUInt16LE(0x7075);unicode.writeUInt16LE(5+newName.length,2);unicode[4]=1;unicode.writeUInt32LE(crc(oldName),5);newName.copy(unicode,9);
await archive('unicode-path-extra',[{key:'old.opf',flags:0,extra:unicode,data:'extra'}],['old.opf','new.opf']);
await archive('duplicate-reversed-central',[{key:'same.opf',data:'first physical'},{key:'same.opf',data:'second physical'}],['same.opf'],{reverseCentral:true});
await archive('local-central-name-mismatch',[{key:'central.opf',localNameBytes:Buffer.from('local.opf'),data:'mismatch'}],['central.opf','local.opf']);
await writeFile(root+'/input.json',JSON.stringify({readers,opf,epubs,archives},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({root,readers:readers.length,opf:opf.length,epubs:epubs.length}));
