import { mkdir, writeFile, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { deflateSync } from 'node:zlib';
const root='D:/mediamanager-validation/20261016-photo-stage/inputs/'+(process.argv[2]??'photo-provider-synthetic-1'); await mkdir(root,{recursive:true}); await mkdir(root+'/assets');
const jpeg=await sharp({create:{width:8,height:6,channels:3,background:'#2468ac'}}).jpeg().toBuffer();
const png=await sharp({create:{width:8,height:6,channels:3,background:'#2468ac'}}).png().toBuffer();
const u16=value=>{const b=Buffer.alloc(2);b.writeUInt16LE(value);return b;};
const u32=value=>{const b=Buffer.alloc(4);b.writeUInt32LE(value);return b;};
const typeSizes={1:1,2:1,3:2,4:4,5:8,7:1,9:4,10:8};
function tiff({base={},exif={},gps={},cr2=false}={}) {
  const enc=entry=>{const [type,value]=entry;if(type===2)return Buffer.from(value+'\0','latin1');if(type===7)return Buffer.from(value);const values=Array.isArray(value)?value:[value];return Buffer.concat(values.map(value=>{
    if(type===3)return u16(value);if(type===4)return u32(value);if(type===1)return Buffer.from([value]);
    const b=Buffer.alloc(8);if(type===10){b.writeInt32LE(value[0]);b.writeInt32LE(value[1],4);}else{b.writeUInt32LE(value[0]);b.writeUInt32LE(value[1],4);}return b;
  }));};
  const dirs=[{...base},{...exif},{...gps}];
  if(Object.keys(exif).length)dirs[0][0x8769]=[4,0]; if(Object.keys(gps).length)dirs[0][0x8825]=[4,0];
  const start=cr2?16:8, offsets=[];let next=start;
  for(const dir of dirs){offsets.push(next);next+=2+12*Object.keys(dir).length+4;}
  if(dirs[0][0x8769])dirs[0][0x8769]=[4,offsets[1]];if(dirs[0][0x8825])dirs[0][0x8825]=[4,offsets[2]];
  const data=[];const ifds=dirs.map(dir=>{const entries=Object.entries(dir).sort((a,b)=>Number(a[0])-Number(b[0])).map(([tag,entry])=>{
    const payload=enc(entry),record=Buffer.alloc(12);record.writeUInt16LE(Number(tag));record.writeUInt16LE(entry[0],2);record.writeUInt32LE(payload.length/typeSizes[entry[0]],4);
    if(payload.length<=4)payload.copy(record,8);else{record.writeUInt32LE(next,8);next+=payload.length;data.push(payload);}return record;
  });return Buffer.concat([u16(entries.length),...entries,u32(0)]);});
  const header=Buffer.concat([Buffer.from('II'),u16(42),u32(start),...(cr2?[Buffer.from([67,82,2,0]),u32(0)]:[])]);
  return Buffer.concat([header,...ifds,...data]);
}
const marker=(code,bytes)=>{const header=Buffer.from([255,code,0,0]);header.writeUInt16BE(bytes.length+2,2);return Buffer.concat([header,bytes]);};
const xmp=(body,attributes='')=>`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" ${attributes}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const alt=(name,value)=>`<dc:${name}><rdf:Alt><rdf:li xml:lang="en">English ${value}</rdf:li><rdf:li xml:lang="x-default">${value}</rdf:li></rdf:Alt></dc:${name}>`;
const xmpSegment=value=>marker(225,Buffer.from('http://ns.adobe.com/xap/1.0/\0'+value));
const exifSegment=value=>marker(225,Buffer.concat([Buffer.from('Exif\0\0'),tiff(value)]));
const iptc=data=>marker(237,Buffer.concat([Buffer.from('Photoshop 3.0\0'+'8BIM','latin1'),Buffer.from([4,4,0,0,0,0,0,0]),...data.map(([tag,value])=>{const bytes=Buffer.from(value,'latin1'),header=Buffer.from([28,2,tag,0,0]);header.writeUInt16BE(bytes.length,3);return Buffer.concat([header,bytes]);})]));
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;}
function chunk(type,data){const header=Buffer.alloc(8),footer=Buffer.alloc(4);header.writeUInt32BE(data.length);header.write(type,4);footer.writeUInt32BE(crc(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([header,data,footer]);}
const taggedPng=chunks=>Buffer.concat([png.subarray(0,33),...chunks,png.subarray(33)]);
function bigEndian(source){
 const result=Buffer.from(source),seen=new Set();result.write('MM');result.writeUInt16BE(source.readUInt16LE(2),2);result.writeUInt32BE(source.readUInt32LE(4),4);
 function convert(offset){if(!offset||seen.has(offset))return;seen.add(offset);const count=source.readUInt16LE(offset);result.writeUInt16BE(count,offset);
  for(let i=0;i<count;i++){const base=offset+2+12*i,tag=source.readUInt16LE(base),type=source.readUInt16LE(base+2),count=source.readUInt32LE(base+4),length=count*typeSizes[type],start=length<=4?base+8:source.readUInt32LE(base+8);
   result.writeUInt16BE(tag,base);result.writeUInt16BE(type,base+2);result.writeUInt32BE(count,base+4);if(length>4)result.writeUInt32BE(start,base+8);
   const width=type===3?2:[4,5,9,10].includes(type)?4:1;for(let k=0;k<length;k+=width)for(let j=0;j<width;j++)result[start+k+j]=source[start+k+width-1-j];
   if([0x8769,0x8825].includes(tag))convert(source.readUInt32LE(base+8));
  }const next=offset+2+12*count;result.writeUInt32BE(source.readUInt32LE(next),next);convert(source.readUInt32LE(next));
 }convert(source.readUInt32LE(4));return result;
}
const text=(key,value)=>chunk('tEXt',Buffer.from(key+'\0'+value));
const itxt=(key,value)=>chunk('iTXt',Buffer.from(key+'\0\0\0\0\0'+value));
const ztxt=(key,value)=>chunk('zTXt',Buffer.concat([Buffer.from(key+'\0\0'),deflateSync(Buffer.from(value))]));
const fullExif={base:{[0x10f]:[2,'EXIF maker'],[0x110]:[2,'EXIF camera'],[0x131]:[2,'EXIF software'],[0x10e]:[2,'EXIF description'],[0x112]:[3,6]},exif:{
 [0x9003]:[2,'2024:03:02 23:04:05'],[0x829a]:[5,[[1,125]]],[0x920a]:[5,[[501,10]]],[0x9202]:[5,[[28,10]]],[0x9201]:[10,[[-7,1]]],[0x8827]:[3,400],
 [0x9286]:[7,Buffer.from('ASCII\0\0\0User comment\0tail')]
},gps:{1:[2,'S'],2:[5,[[25,1],[2,1],[6,1]]],3:[2,'W'],4:[5,[[121,1],[33,1],[5544,100]]],5:[1,1],6:[5,[[25,2]]]}};
const fullXmp=xmp(alt('title','XMP title')+alt('description','XMP overview')+'<dc:subject><rdf:Bag><rdf:li>travel</rdf:li><rdf:li> travel </rdf:li><rdf:li></rdf:li><rdf:li>travel</rdf:li></rdf:Bag></dc:subject><exif:ISOSpeedRatings><rdf:Seq><rdf:li>800</rdf:li></rdf:Seq></exif:ISOSpeedRatings>',
 'tiff:Make="XMP maker" tiff:Model="XMP camera" tiff:Orientation="8" xmp:Rating="4" xmp:CreateDate="2024-03-02T23:04:05+09:00" xmp:CreatorTool="XMP software" exif:ExposureTime="1/250" exif:FocalLength="35/1" exif:GPSLatitude="1,2N"');
const assets=new Map(),cases=[];
const add=(name,filename,bytes,options={})=>{if(bytes)assets.set(filename,bytes);cases.push({name,file:filename,...options});};
add('plain-jpeg','plain.jpg',jpeg);add('plain-png','plain.png',png);
add('exif-complete','exif.jpg',Buffer.concat([jpeg.subarray(0,2),exifSegment(fullExif),jpeg.subarray(2)]));
add('exif-name-lock','exif.jpg',null,{nameLocked:true});
add('xmp-complete','xmp.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(fullXmp),jpeg.subarray(2)]));
add('xmp-name-lock','xmp.jpg',null,{nameLocked:true});
add('xmp-before-exif','combined.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(fullXmp),exifSegment(fullExif),jpeg.subarray(2)]));
add('exif-before-xmp','combined-reverse.jpg',Buffer.concat([jpeg.subarray(0,2),exifSegment(fullExif),xmpSegment(fullXmp),jpeg.subarray(2)]));
const iptcData=[[5,'IPTC title'],[25,'one'],[25,'two'],[120,'IPTC caption']];
add('iptc-only','iptc.jpg',Buffer.concat([jpeg.subarray(0,2),iptc(iptcData),jpeg.subarray(2)]));
add('iptc-xmp-missing','iptc-xmp.jpg',Buffer.concat([jpeg.subarray(0,2),iptc(iptcData),xmpSegment(xmp('','tiff:Make="Only maker"')),jpeg.subarray(2)]));
add('iptc-xmp-before','xmp-iptc.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(xmp('','tiff:Make="Only maker"')),iptc(iptcData),jpeg.subarray(2)]));
add('jpeg-comment','comment.jpg',Buffer.concat([jpeg.subarray(0,2),marker(254,Buffer.from('JPEG comment')),jpeg.subarray(2)]));
for(const orientation of [0,1,2,3,4,5,6,7,8,9])add('orientation-'+orientation,'orientation-'+orientation+'.jpg',Buffer.concat([jpeg.subarray(0,2),exifSegment({base:{[0x112]:[3,orientation]}}),jpeg.subarray(2)]));
for(const [name,extra] of [['unsigned-shutter',{[0x9201]:[5,[[7,2]]]}],['zero-rational',{[0x9202]:[5,[[8,0]]],[0x829a]:[5,[[1,0]]]}],['iso-overflow',{[0x8827]:[4,2147483648]}],['iso-array',{[0x8827]:[3,[100,200]]}],['invalid-date',{[0x9003]:[2,'2024:02:30 03:04:05']}],['datetime-only',{}]]){
 const exif=structuredClone(fullExif);Object.assign(exif.exif,extra);if(name==='datetime-only'){delete exif.exif[0x9003];exif.base[0x132]=[2,'2023:01:02 03:04:05'];}
 add(name,name+'.jpg',Buffer.concat([jpeg.subarray(0,2),exifSegment(exif),jpeg.subarray(2)]));
}
add('blank-title','blank-title.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(xmp(alt('title','   '))),jpeg.subarray(2)]));
add('xmp-iso-overflow','xmp-iso-overflow.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(xmp('<exif:ISOSpeedRatings><rdf:Seq><rdf:li>4294967295</rdf:li></rdf:Seq></exif:ISOSpeedRatings>', 'tiff:Make="Overflow maker"')),jpeg.subarray(2)]));
add('png-text','text.png',taggedPng([text('Title','PNG title'),text('Description','PNG description'),text('Comment','PNG comment'),text('Software','PNG software'),text('Creation Time','Sat, 02 Mar 2024 23:04:05 GMT')]));
add('png-ztext','ztext.png',taggedPng([ztxt('Title','Compressed PNG title')]));
add('png-itext','itext.png',taggedPng([itxt('Title','International PNG title')]));
add('png-xmp','xmp.png',taggedPng([itxt('XML:com.adobe.xmp',fullXmp)]));
add('png-exif-ignored','exif.png',taggedPng([chunk('eXIf',tiff(fullExif))]));
add('png-xmp-ztext-failure','xmp-ztext.png',taggedPng([ztxt('xmp',fullXmp)]));
const badPng=taggedPng([text('Title','bad CRC')]);badPng[33+8]^=1;add('png-bad-crc','bad-crc.png',badPng);
const tif=tiff({base:{...fullExif.base,[0x100]:[4,8],[0x101]:[4,6]},exif:fullExif.exif,gps:fullExif.gps});
add('tiff-complete','photo.tiff',tif);add('tif-extension-skips-tags','photo.tif',tif);
add('cr2-complete','photo.cr2',tiff({base:fullExif.base,exif:{...fullExif.exif,[0xa002]:[4,8],[0xa003]:[4,6]},gps:fullExif.gps,cr2:true}));
for(const format of ['webp','avif','gif'])add(format+'-format','photo.'+format,await sharp(png)[format]().toBuffer());
add('uppercase-extension','upper.JPG',assets.get('exif.jpg'));
add('invalid-jpeg','invalid.jpg',Buffer.from('invalid photo'));add('invalid-retains-size','invalid.jpg',null,{width:4,height:3});
add('unsupported-format','opaque.raw',Buffer.from('opaque bytes'));
add('fallback-argument','opaque.raw',null,{fallback:'ArgumentException'});add('fallback-io','opaque.raw',null,{fallback:'IOException'});
add('fallback-zero','opaque.raw',null,{fallback:'zero'});add('cancelled-fetch','exif.jpg',null,{cancelled:true});
add('existing-primary','exif.jpg',null,{existingPrimary:true});
for(const [name,value]of [['utc-date','2024-03-02T23:04:05Z'],['utc-new-year','2023-12-31T23:04:05Z'],['xmp-fraction','2024-03-02T23:04:05.1234567+09:00'],['minimum-date','0001-01-01T00:00:00'],['maximum-date','9999-12-31T23:00:00Z']])add(name,name+'.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(xmp('',`xmp:CreateDate="${value}"`)),jpeg.subarray(2)]));
add('big-endian-exif','big-endian.jpg',Buffer.concat([jpeg.subarray(0,2),marker(225,Buffer.concat([Buffer.from('Exif\0\0'),bigEndian(tiff(fullExif))])),jpeg.subarray(2)]));
add('big-endian-tiff','big-endian.tiff',bigEndian(tif));
const gpsClamp=structuredClone(fullExif);gpsClamp.gps[2]=[5,[[99,1],[0,1],[0,1]]];gpsClamp.gps[4]=[5,[[222,1],[0,1],[0,1]]];gpsClamp.gps[1]=[2,'s'];gpsClamp.gps[3]=[2,'Q'];
add('gps-clamp-unknown-reference','gps-clamp.jpg',Buffer.concat([jpeg.subarray(0,2),exifSegment(gpsClamp),jpeg.subarray(2)]));
add('xmp-whitespace-iptc','whitespace-iptc.jpg',Buffer.concat([jpeg.subarray(0,2),iptc(iptcData),xmpSegment(xmp(alt('title','   '))),jpeg.subarray(2)]));
add('png-duplicate-title','duplicate-title.png',taggedPng([text('Title','First title'),text('Title','Later title')]));
add('rating-large','rating-large.jpg',Buffer.concat([jpeg.subarray(0,2),xmpSegment(xmp('','xmp:Rating="4294967295"')),jpeg.subarray(2)]));
const badOffset=tiff(fullExif);{const count=badOffset.readUInt16LE(8);for(let i=0;i<count;i++){const position=10+12*i;if(badOffset.readUInt16LE(position)===0x10f)badOffset.writeUInt32LE(0x7fffffff,position+8);}}
add('exif-entry-outside-file','outside.jpg',Buffer.concat([jpeg.subarray(0,2),marker(225,Buffer.concat([Buffer.from('Exif\0\0'),badOffset])),jpeg.subarray(2)]));
for(const [filename,bytes]of assets)await writeFile(root+'/assets/'+filename,bytes,{flag:'wx'});
await writeFile(root+'/input.json',JSON.stringify({cases},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({root,assets:assets.size,cases:cases.length}));
