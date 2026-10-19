/** StreamReader's BOM-selected decoding. XML declarations do not select a
 * decoder after the stream has already become characters. */
import {decodeNativeTextEncoding} from '../core/native-text.js';
export async function* decodeNativeTextStream(source,{encoding='utf-8',hasShiftControls=true}={}) {
  const iterator = (source[Symbol.asyncIterator] ?? source[Symbol.iterator]).call(source);
  let pending = Buffer.alloc(0), decoder, utf32, carry = Buffer.alloc(0),custom,shifted=false,designated=false;
  const select = bytes => {
    let skip = 0;
    if (bytes.length >= 4 && bytes[0]===0xff && bytes[1]===0xfe && bytes[2]===0 && bytes[3]===0) { utf32='LE';skip=4; }
    else if (bytes.length >= 4 && bytes[0]===0 && bytes[1]===0 && bytes[2]===0xfe && bytes[3]===0xff) { utf32='BE';skip=4; }
    else if (bytes.length >= 3 && bytes[0]===0xef && bytes[1]===0xbb && bytes[2]===0xbf) { encoding='utf-8';skip=3; }
    else if (bytes.length >= 2 && bytes[0]===0xff && bytes[1]===0xfe) { encoding='utf-16le';skip=2; }
    else if (bytes.length >= 2 && bytes[0]===0xfe && bytes[1]===0xff) { encoding='utf-16be';skip=2; }
    const name=String(encoding).toLowerCase();
    if(!utf32&&['utf-32','utf-32le','utf-32be'].includes(name))utf32=name==='utf-32be'?'BE':'LE';
    if(!utf32){
      if(['ibm850','ibm852','ibm855','x-mac-ce','hz-gb-2312','iso-2022-kr'].includes(name)||name==='x-cp50227'&&hasShiftControls)custom=name;
      else decoder = new TextDecoder(name==='x-cp50227'?'gb18030':encoding,{ignoreBOM:true});
    }
    return bytes.subarray(skip);
  };
  const decode = (bytes,final=false) => {
    if (decoder) return decoder.decode(bytes,{stream:!final});
    if(custom){
      if(['ibm850','ibm852','ibm855','x-mac-ce'].includes(custom))return decodeNativeTextEncoding(Buffer.concat([Buffer.from([0]),bytes]),custom).slice(1);
      const input=Buffer.concat([carry,bytes]);let index=0,text='';
      const designation=custom==='iso-2022-kr'?[0x24,0x29,0x43]:[0x24,0x29,0x41];
      while(index<input.length){
        const start=index,byte=input[index++];
        if(custom==='hz-gb-2312'&&byte===0x7e){
          if(index===input.length&&!final){index=start;break;}const next=input[index++];
          if(next===0x7b){shifted=true;continue;}if(next===0x7d){shifted=false;continue;}if(next===0x7e){text+='~';continue;}if(next===0x0a)continue;
          if(next===0x0d){if(index===input.length&&!final){index=start;break;}if(input[index]===0x0a){index++;continue;}}
          text+='\uFFFD';if(next===undefined)break;continue;
        }
        if(custom!=='hz-gb-2312'){
          if(byte===0x1b){if(input.length-index<designation.length&&!final){index=start;break;}
            if(designation.every((part,n)=>input[index+n]===part)){designated=true;index+=designation.length;continue;}text+='\uFFFD';continue;}
          if(byte===0x0e){shifted=true;continue;}if(byte===0x0f){shifted=false;continue;}
        }
        if(!shifted){text+=byte<128?String.fromCharCode(byte):'\uFFFD';continue;}
        if(index===input.length&&!final){index=start;break;}const next=input[index++];
        if(custom!=='hz-gb-2312'&&!designated||next===undefined||byte<0x21||byte>0x7e||next<0x21||next>0x7e){text+='\uFFFD';continue;}
        text+=new TextDecoder(custom==='iso-2022-kr'?'euc-kr':'gb18030').decode(Uint8Array.of(byte|0x80,next|0x80));
      }
      carry=input.subarray(index);return text;
    }
    const input = Buffer.concat([carry,bytes]), end=input.length-input.length%4; let text='';
    for (let index=0;index<end;index+=4) { const point=utf32==='LE'?input.readUInt32LE(index):input.readUInt32BE(index); text+=point>0x10ffff||point>=0xd800&&point<=0xdfff?'\uFFFD':String.fromCodePoint(point); }
    carry=input.subarray(end); if (final&&carry.length) { text+='\uFFFD';carry=Buffer.alloc(0); } return text;
  };
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      let bytes=Buffer.from(next.value);
      if (!decoder&&!utf32&&!custom) { pending=Buffer.concat([pending,bytes]); if(pending.length<4) continue;bytes=select(pending);pending=Buffer.alloc(0); }
      const text=decode(bytes);if(text)yield text;
    }
    if(!decoder&&!utf32&&!custom){const bytes=select(pending);pending=Buffer.alloc(0);const text=decode(bytes);if(text)yield text;}
    const tail=decode(Buffer.alloc(0),true);if(tail)yield tail;
  } finally { await iterator.return?.(); }
}
