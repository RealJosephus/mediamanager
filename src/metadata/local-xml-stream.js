import { XmlTokenCursor } from '../core/xml-stream.js';
import { XmlError } from '../core/xml.js';
import { clrTrim } from './whitespace.js';

const error = message => { throw new XmlError(message); };
const whitespace = value => /^[\t\n\r ]*$/u.test(value);
const personFields = new Set(['name','Name','role','Role','type','Type','order','sortorder','SortOrder','thumb']);

/** Retain the current lexical token and one structured member, never a member
 * container. Token validation is shared with the pinned synchronous reader. */
export class StreamCursor {
  constructor(source,{allowInternalDtd=false}={}) {
    this.source = typeof source === 'string' ? (async function* () { yield source; })() : source;
    if (!this.source?.[Symbol.asyncIterator] && !this.source?.[Symbol.iterator]) throw new TypeError('XML requires text chunks.');
    this.iterator = (this.source[Symbol.asyncIterator] ?? this.source[Symbol.iterator]).call(this.source);
    this.cursor = new XmlTokenCursor(''); this.ended = false; this.pending = undefined;
    this.first = true; this.carriage = false; this.consumed = false;
    this.allowInternalDtd=allowInternalDtd;this.entities=new Map();this.entityCharacters=0;
  }
  async more() {
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      if (this.carriage) this.cursor.xml += '\n';
      this.carriage = false; return;
    }
    if (typeof next.value !== 'string') throw new TypeError('The XML text decoder must provide string chunks.');
    let value = next.value;
    if (!value.length) return;
    if (this.first) { this.first = false; if (value.charCodeAt(0) === 0xfeff) value = value.slice(1); }
    if (this.carriage) { this.cursor.xml += '\n'; if (value.startsWith('\n')) value = value.slice(1); this.carriage = false; }
    if (value.endsWith('\r')) { this.carriage = true; value = value.slice(0,-1); }
    this.cursor.xml += value.replaceAll('\r\n','\n').replaceAll('\r','\n');
  }
  complete() {
    const text = this.cursor.xml, start = this.cursor.position;
    if (start >= text.length) return this.ended;
    if (text[start] !== '<') return text.indexOf('<',start) >= 0 || this.ended;
    const rest = text.slice(start);
    if (rest.length < 9 && ['<!--','<![CDATA[','<?','<!DOCTYPE'].some(prefix => prefix.startsWith(rest))) return this.ended;
    if (rest.startsWith('<!--')) return rest.includes('-->') || this.ended;
    if (rest.startsWith('<![CDATA[')) return rest.includes(']]>') || this.ended;
    if (rest.startsWith('<?')) return rest.includes('?>') || this.ended;
    if(/^<!DOCTYPE\b/iu.test(rest)){
      let quoted=null,depth=0;
      for(let n=9;n<rest.length;n++){const c=rest[n];if(quoted){if(c===quoted)quoted=null;}
        else if(c==='"'||c==="'")quoted=c;else if(c==='[')depth++;else if(c===']')depth--;else if(c==='>'&&depth===0)return true;}
      return this.ended;
    }
    let quote;
    for (let index = start + 1; index < text.length; index++) {
      const value = text[index];
      if (quote) { if (value === quote) quote = null; }
      else if (value === '"' || value === "'") quote = value;
      else if (value === '>') return true;
    }
    return this.ended;
  }
  async readToken() {
    if (this.pending !== undefined) { const token = this.pending; this.pending = undefined; return token; }
    if (this.cursor.position) {
      this.cursor.xml = ' ' + this.cursor.xml.slice(this.cursor.position); this.cursor.position = 1; this.consumed = true;
    }
    while (!this.complete()) await this.more();
    if(this.allowInternalDtd&&/^<!DOCTYPE\b/iu.test(this.cursor.xml.slice(this.cursor.position))){
      const source=this.cursor.xml.slice(this.cursor.position);let quote=null,depth=0,end=-1;
      for(let n=9;n<source.length;n++){const c=source[n];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;
        else if(c==='[')depth++;else if(c===']')depth--;else if(c==='>'&&!depth){end=n+1;break;}}
      if(end<0)error('The document type declaration was not closed.');
      const declaration=source.slice(0,end),body=/\[([\s\S]*)\]/u.exec(declaration)?.[1]??'';
      for(const match of body.matchAll(/<!ENTITY\s+([\w.-]+)\s+(["'])([\s\S]*?)\2\s*>/gu))this.entities.set(match[1],match[3]);
      this.cursor.position+=end;return{type:'doctype'};
    }
    if(this.entities.size&&!this.cursor.xml.startsWith('<!--',this.cursor.position)&&!this.cursor.xml.startsWith('<![CDATA[',this.cursor.position)){
      let value=this.cursor.xml.slice(this.cursor.position),changed=true;
      const expanded=new Set();
      for(let round=0;changed;round++){
        changed=false;
        value=value.replace(/&([\w.-]+);/gu,(all,name)=>{
          if(!this.entities.has(name))return all;changed=true;const replacement=this.entities.get(name);this.entityCharacters+=replacement.length;
          if(this.entityCharacters>10000000)error('The XML entity expansion limit was exceeded.');return replacement;
        });
        if(changed&&expanded.has(value))error('The XML entity contains a recursive reference.');expanded.add(value);
      }
      this.cursor.xml=this.cursor.xml.slice(0,this.cursor.position)+value;
    }
    return this.cursor.readToken();
  }
  async peekToken() { this.pending ??= await this.readToken(); return this.pending; }
  namespacesFor(...args) { return this.cursor.namespacesFor(...args); }
  validateLookahead(...args) { return this.cursor.validateLookahead(...args); }
  async close() { await this.iterator.return?.(); }
  async readNode(start, inherited = {}, { allowChildren = true, keep = true } = {}) {
    const namespaces = this.namespacesFor(start,inherited), parts = [], children = [];
    if (!start.empty) for (;;) {
      const token = await this.readToken();
      if (token.type === 'eof') error(`Unexpected end of file while reading '${start.name}'.`);
      if (token.type === 'end') {
        if (token.name !== start.name) error(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
        break;
      }
      if (token.type === 'start') {
        if (!allowChildren) error(`The '${start.name}' element cannot contain child elements.`);
        await this.readNode(token,namespaces,{keep:false});
      } else if (keep && token.type === 'text') parts.push(token.value);
    }
    return { name:start.name,attributes:start.attributes,namespaces,text:parts.join(''),children };
  }
  async fieldsNode(start, inherited, fields) {
    const namespaces = this.namespacesFor(start,inherited), latest = new Map();
    if (!start.empty) for (;;) {
      const token = await this.readToken();
      if (token.type === 'eof') error(`Unexpected end of file while reading '${start.name}'.`);
      if (token.type === 'end') {
        if (token.name !== start.name) error(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
        break;
      }
      if (token.type === 'start') {
        const known = fields.has(token.name), node = await this.readNode(token,namespaces,{allowChildren:!known,keep:known});
        if (known) {
          // Int32.TryParse failure preserves the preceding valid assignment.
          // Keep its last valid field while still validating every XML token.
          if(fields===personFields&&['order','sortorder','SortOrder'].includes(node.name)){
            const number=clrTrim(node.text).replace(/\0+$/u,'');
            if(!/^[+-]?\d+$/u.test(number)||Number(number)<-2147483648||Number(number)>2147483647)continue;
          }
          latest.delete(node.name); latest.set(node.name,node);
        }
      }
    }
    return { name:start.name,attributes:start.attributes,namespaces,text:'',children:[...latest.values()] };
  }
}
async function content(cursor) {
  for (;;) { const token = await cursor.readToken(); if (!['comment','processing-instruction'].includes(token.type) && !(token.type === 'text' && whitespace(token.value))) return token; }
}
async function peekLocal(cursor) {
  while (['comment','processing-instruction'].includes((await cursor.peekToken()).type)) await cursor.readToken();
  return cursor.peekToken();
}
async function* container(cursor,start,inherited,children) {
  const namespaces = cursor.namespacesFor(start,inherited);
  yield {type:'container-start',name:start.name};
  for (;;) {
    const token = await cursor.readToken();
    if (token.type === 'eof') error(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) error(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      yield {type:'container-end',name:start.name}; yield {type:'traversal'}; return;
    }
    if (token.type !== 'start') continue;
    const fields = children[token.name];
    if (fields instanceof Set) {
      const node = await cursor.fieldsNode(token,namespaces,fields);
      if (!token.empty) yield {type:'container-node',container:start.name,node};
      else cursor.validateLookahead(await peekLocal(cursor),namespaces,start.name);
    } else {
      const node = await cursor.readNode(token,namespaces,{allowChildren:fields !== false,keep:fields === false});
      cursor.validateLookahead(await peekLocal(cursor),namespaces,start.name);
      if (fields === false) yield {type:'container-node',container:start.name,node};
    }
  }
}
export async function* readLocalXmlStepsStreaming(source,{scalarNames,type}={}) {
  const containers = { TagLines:{Tagline:false},Genres:{Genre:false},Studios:{Studio:false},Tags:{Tag:false},Trailers:{Trailer:false},Persons:{Person:personFields,Actor:personFields},
    ...(type === 'Playlist' ? {Shares:{Share:new Set(['UserId','CanEdit'])},PlaylistItems:{PlaylistItem:new Set(['Path','ItemId'])}}
      : {CollectionItems:{CollectionItem:new Set(['Path','ItemId'])}}) };
  const cursor = new StreamCursor(source);
  try {
    const root = await content(cursor);
    if (root.type !== 'start') error('An XML document must have exactly one root element.');
    const namespaces = cursor.namespacesFor(root,{});
    if (root.empty) { if ((await content(cursor)).type !== 'eof') error('An XML document must have exactly one root element.'); return; }
    for (;;) {
      const token = await cursor.readToken();
      if (token.type === 'eof') error(`Unexpected end of file while reading '${root.name}'.`);
      if (['comment','processing-instruction'].includes(token.type)) continue;
      yield {type:'traversal'};
      if (token.type === 'end') {
        if (token.name !== root.name) error(`The '${root.name}' start tag does not match the '${token.name}' end tag.`);
        if ((await content(cursor)).type !== 'eof') error('An XML document must have exactly one root element.'); return;
      }
      if (token.type !== 'start') continue;
      cursor.namespacesFor(token,namespaces);
      if (Object.hasOwn(containers,token.name) && !token.empty) yield* container(cursor,token,namespaces,containers[token.name]);
      else {
        const scalar = typeof scalarNames === 'function' ? scalarNames(token.name) : scalarNames.has(token.name);
        const node = await cursor.readNode(token,namespaces,{allowChildren:!scalar,keep:scalar});
        cursor.validateLookahead(await peekLocal(cursor),namespaces,root.name);
        yield {type:'node',node};
      }
    }
  } finally { await cursor.close(); }
}
