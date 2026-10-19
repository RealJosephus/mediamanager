import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeCharsetStreamDetector} from '../core/native-charset.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {quoteIdentifier as q} from '../database/model.js';
import {clrTrim} from './whitespace.js';
import {decodeNativeTextStream} from './native-text-stream.js';
import {StreamCursor} from './local-xml-stream.js';
import {XmlError} from '../core/xml.js';
const nativeError=(type,message)=>Object.assign(new Error(message),{nativeException:type});
async function* lines(source){let pending='';for await(const text of source){pending+=text;for(;;){const match=/[\r\n]/u.exec(pending);if(!match)break;
  const line=pending.slice(0,match.index);pending=pending.slice(match.index+1);if(line.length)yield clrTrim(line);}}if(pending.length)yield clrTrim(pending);}
const decodeUrl=value=>{const decoded=new URLSearchParams(`value=${value}`).get('value');return value.replaceAll('+',' ')===decoded?value:decoded;};
const unescape=value=>value==null?value:value.replaceAll('&amp;','&').replaceAll('&apos;',"'").replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<');
async function parseText(source,extension,session,writer){
  const temporary=q('playlist_parse_'+randomUUID().replaceAll('-',''));
  await session.client.query(extension==='.pls'?`CREATE TEMP TABLE ${temporary}(number bigint PRIMARY KEY,path bytea)`:`CREATE TEMP TABLE ${temporary}(name bytea PRIMARY KEY)`);
  try{
    let first=true,extended=false,header=false;
    for await(const line of lines(source)){
      if(first){first=false;if(extension==='.pls'){header=line==='[playlist]';continue;}extended=line==='#EXTM3U';if(extended)continue;}
      if(extension==='.pls'){
        if(!header)continue;let prefix;if(line.startsWith('File'))prefix='File';else if(line.startsWith('Title'))prefix='Title';else if(line.startsWith('Length'))prefix='Length';else continue;
        const equals=line.indexOf('='),contents=line.slice(equals+1);if(prefix==='Title'&&!contents)continue;
        const raw=line.slice(prefix.length,equals),number=equals>=prefix.length&&/^[+-]?\d+$/u.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):-1;
        await session.client.query(`INSERT INTO ${temporary}(number,path) VALUES ($1,$2) ON CONFLICT(number) DO UPDATE SET path=${prefix==='File'?'EXCLUDED.path':`${temporary}.path`}`,[number,prefix==='File'?nativeTextBytes(contents):null]);
      }else if(!extended){if(!line.startsWith('#'))await writer.append({Type:0,Path:line});}
      else{
        if(/^#EXT-X-VERSION:\d$/u.test(line))throw nativeError('FormatException','Playlist appears to be a HLS playlist. Use the HLS parser instead.');
        if(/^#EXTINF:(-?\d*),(.*)$/u.test(line)||/^#(EXTALB|EXTART):(.*)$/u.test(line))continue;
        const property=/^#(EXT.*):(.*)$/u.exec(line);
        if(property){const result=await session.client.query(`INSERT INTO ${temporary}(name) VALUES ($1) ON CONFLICT DO NOTHING`,[nativeTextBytes(property[1])]);
          if(!result.rowCount)throw nativeError('ArgumentException','An item with the same key has already been added.');continue;}
        if(/^#(?!EXT)/u.test(line))continue;
        await writer.append({Type:0,Path:decodeUrl(line)});await session.client.query(`DELETE FROM ${temporary}`);
      }
    }
    if(first&&extension!=='.pls')throw nativeError('ArgumentOutOfRangeException','Index was out of range.');
    if(extension==='.pls')for(let after=null;;){const rows=(await session.client.query(`SELECT number,path FROM ${temporary} WHERE $1::bigint IS NULL OR number>$1 ORDER BY number LIMIT 128`,[after])).rows;
      if(!rows.length)break;for(const row of rows)await writer.append({Type:0,Path:row.path==null?null:decodeNativeTextBytes(row.path,'runtime')});after=rows.at(-1).number;}
  }finally{await session.client.query(`DROP TABLE ${temporary}`);}
}
async function parseXml(source,writer){
  const cursor=new StreamCursor(source,{allowInternalDtd:true}),stack=[],namespaces=[];let root=false,ended=false,head=false,wrongRoot=false;
  try{for(;;){const token=await cursor.readToken();if(token.type==='eof'){if(stack.length)throw new XmlError('Unexpected end of file.');break;}
    if(['comment','processing-instruction'].includes(token.type))continue;
    if(token.type==='doctype'){if(root)throw new XmlError('A document type must precede the root element.');continue;}
    if(token.type==='text'){if(!stack.length&&clrTrim(token.value))throw new XmlError('Data at the root level is invalid.');continue;}
    if(token.type==='end'){if(stack.at(-1)!==token.name)throw new XmlError('An XML closing tag does not match.');stack.pop();namespaces.pop();if(!stack.length)ended=true;continue;}
    if(!root){root=true;wrongRoot=token.name!=='smil'||Boolean(token.attributes.xmlns);}
    else if(ended)throw new XmlError('There are multiple root elements.');
    const inherited=namespaces.at(-1)??{},current=cursor.namespacesFor(token,inherited);
    if(stack.length===1&&token.name==='head'&&!current[''])head=true;
    if(stack.length===3&&stack[0]==='smil'&&stack[1]==='body'&&stack[2]==='seq'&&token.name==='media'&&!current[''])await writer.append({Type:0,Path:unescape(token.attributes.src)});
    if(!token.empty){stack.push(token.name);namespaces.push(current);}else if(!stack.length)ended=true;
  }
  if(!root)throw new XmlError('Root element is missing.');if(wrongRoot||!head)throw nativeError('NullReferenceException','Object reference not set to an instance of an object.');
  }finally{await cursor.close();}
}
/** Freeze the bytes once for charset detection, then parse into SQL before any
 * path resolution. Whole-document parser failures therefore publish no links. */
export async function parsePlaylistMemberRelation(source,{extension,linkedChildren,session,parentId,spoolRoot,fileSystem}){
  if(typeof spoolRoot!=='string'||!path.isAbsolute(spoolRoot))throw new TypeError('Playlist parsing requires a state-owned spool root.');
  const filename=path.join(spoolRoot,`playlist-read-${randomUUID()}.tmp`),file=await fileSystem.open(filename,'wx'),detector=createNativeCharsetStreamDetector();
  let closed=false,hasShiftControls=false,writer;
  try{
    for await(const chunk of source){const bytes=Buffer.from(chunk);detector.append(bytes);hasShiftControls ||= bytes.includes(0x1b)||bytes.includes(0x0e)||bytes.includes(0x0f);
      for(let offset=0;offset<bytes.length;){const result=await file.write(bytes.subarray(offset));offset+=result.bytesWritten;}}
    await file.close();closed=true;const detected=detector.finish().details?.[0];
    const encoding=['.wpl','.zpl'].includes(extension)?'utf-8':detected?.encoding&&detected.confidence>=Math.fround(0.5)?detected.encoding:'utf-8';
    const text=decodeNativeTextStream(fileSystem.createReadStream(filename),{encoding,hasShiftControls});
    writer=await linkedChildren.createWriter({session,parentId});
    if(['.wpl','.zpl'].includes(extension))await parseXml(text,writer);else await parseText(text,extension,session,writer);
    return await writer.finish();
  }catch(error){if(writer)await writer.abort();throw error;}
  finally{if(!closed)await file.close();await fileSystem.rm(filename,{force:true});}
}
