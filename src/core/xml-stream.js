import { XmlError } from './xml.js';

const entityValues = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const invalidLiteral = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;
const whitespace = /[\t\n\r ]/;
const isXmlWhitespace = value => /^[\t\n\r ]*$/.test(value);
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';

function isXmlNameStart(codePoint) {
  return codePoint === 0x3a || codePoint === 0x5f || codePoint >= 0x41 && codePoint <= 0x5a
    || codePoint >= 0x61 && codePoint <= 0x7a || codePoint >= 0xc0 && codePoint <= 0xd6
    || codePoint >= 0xd8 && codePoint <= 0xf6 || codePoint >= 0xf8 && codePoint <= 0x2ff
    || codePoint >= 0x370 && codePoint <= 0x37d || codePoint >= 0x37f && codePoint <= 0x1fff
    || codePoint >= 0x200c && codePoint <= 0x200d || codePoint >= 0x2070 && codePoint <= 0x218f
    || codePoint >= 0x2c00 && codePoint <= 0x2fef || codePoint >= 0x3001 && codePoint <= 0xd7ff
    || codePoint >= 0xf900 && codePoint <= 0xfdcf || codePoint >= 0xfdf0 && codePoint <= 0xfffd
    || codePoint >= 0x10000 && codePoint <= 0xeffff;
}

function isXmlName(name) {
  const points = [...name].map(character => character.codePointAt(0));
  return points.length > 0 && isXmlNameStart(points[0]) && points.slice(1).every(codePoint => isXmlNameStart(codePoint)
    || codePoint === 0x2d || codePoint === 0x2e || codePoint >= 0x30 && codePoint <= 0x39 || codePoint === 0xb7
    || codePoint >= 0x300 && codePoint <= 0x36f || codePoint >= 0x203f && codePoint <= 0x2040);
}

function xmlError(message) {
  throw new XmlError(message);
}

function decodeText(value) {
  if (invalidLiteral.test(value)) xmlError('The document contains an invalid XML character.');
  let result = '';
  for (let index = 0; index < value.length;) {
    const ampersand = value.indexOf('&', index);
    if (ampersand < 0) return result + value.slice(index);
    result += value.slice(index, ampersand);
    const semicolon = value.indexOf(';', ampersand + 1);
    if (semicolon < 0) xmlError('An XML entity reference is missing its semicolon.');
    const reference = value.slice(ampersand + 1, semicolon);
    if (Object.hasOwn(entityValues, reference)) result += entityValues[reference];
    else if (/^#x[0-9a-f]+$/i.test(reference) || /^#[0-9]+$/.test(reference)) {
      const scalar = Number.parseInt(reference[1].toLowerCase() === 'x' ? reference.slice(2) : reference.slice(1), reference[1].toLowerCase() === 'x' ? 16 : 10);
      if (!Number.isSafeInteger(scalar) || scalar > 0x10ffff) xmlError('The numeric XML character reference is outside the Unicode range.');
      // XmlReader(CheckCharacters=false) exposes numeric controls and surrogate
      // code units even though their literal spellings remain invalid XML.
      result += scalar <= 0xffff ? String.fromCharCode(scalar) : String.fromCodePoint(scalar);
    } else xmlError(`Reference to undeclared entity '${reference}'.`);
    index = semicolon + 1;
  }
  return result;
}

export class XmlTokenCursor {
  constructor(xml) {
    this.xml = String(xml);
    // XmlReader treats a single leading U+FEFF from a TextReader as the
    // document signature. Our saver intentionally emits that character.
    if (this.xml.charCodeAt(0) === 0xfeff) this.xml = this.xml.slice(1);
    this.position = 0;
    this.pending = undefined;
  }

  skipWhitespace() {
    while (this.position < this.xml.length && whitespace.test(this.xml[this.position])) this.position++;
  }

  readName() {
    const start = this.position;
    while (this.position < this.xml.length && !/[\t\n\r /?>=]/.test(this.xml[this.position])) this.position++;
    if (start === this.position) xmlError('An XML name was expected.');
    const name = this.xml.slice(start, this.position);
    if (!isXmlName(name) || name.split(':').length > 2 || name.startsWith(':') || name.endsWith(':')) {
      xmlError(`'${name}' is not a valid XML name.`);
    }
    return name;
  }

  readUntil(ending, message) {
    const end = this.xml.indexOf(ending, this.position);
    if (end < 0) xmlError(message);
    const value = this.xml.slice(this.position, end);
    this.position = end + ending.length;
    return value;
  }

  readToken() {
    if (this.pending !== undefined) { const token = this.pending; this.pending = undefined; return token; }
    if (this.position >= this.xml.length) return { type: 'eof' };
    if (this.xml[this.position] !== '<') {
      const start = this.position;
      const end = this.xml.indexOf('<', start);
      this.position = end < 0 ? this.xml.length : end;
      const value = this.xml.slice(start, this.position);
      if (value.includes(']]>')) xmlError("Character data cannot contain ']]>'.");
      return { type: 'text', value: decodeText(value) };
    }
    if (this.xml.startsWith('<!--', this.position)) {
      this.position += 4;
      const value = this.readUntil('-->', 'An XML comment was not closed.');
      if (value.includes('--') || value.endsWith('-')) xmlError('An XML comment cannot contain --.');
      return { type: 'comment' };
    }
    if (this.xml.startsWith('<![CDATA[', this.position)) {
      this.position += 9;
      const value = this.readUntil(']]>', 'A CDATA section was not closed.');
      if (invalidLiteral.test(value)) xmlError('The document contains an invalid XML character.');
      return { type: 'text', value, cdata: true };
    }
    if (/^<!DOCTYPE\b/i.test(this.xml.slice(this.position))) xmlError('DTD declarations are prohibited.');
    if (this.xml.startsWith('<?', this.position)) {
      const declaration = this.position === 0 && this.xml.startsWith('<?xml', this.position);
      this.position += 2;
      const target = this.readName();
      if (target.toLowerCase() === 'xml' && !declaration) xmlError("The 'xml' processing instruction target is reserved.");
      this.readUntil('?>', 'An XML processing instruction was not closed.');
      return { type: 'processing-instruction' };
    }
    if (this.xml.startsWith('</', this.position)) {
      this.position += 2; this.skipWhitespace();
      const name = this.readName(); this.skipWhitespace();
      if (this.xml[this.position] !== '>') xmlError(`The closing tag '${name}' is malformed.`);
      this.position++;
      return { type: 'end', name };
    }
    if (this.xml.startsWith('<!', this.position)) xmlError('Unsupported XML declaration.');
    this.position++;
    const name = this.readName();
    const attributes = {};
    while (true) {
      this.skipWhitespace();
      if (this.position >= this.xml.length) xmlError(`The start tag '${name}' was not closed.`);
      if (this.xml.startsWith('/>', this.position)) { this.position += 2; return { type: 'start', name, attributes, empty: true }; }
      if (this.xml[this.position] === '>') { this.position++; return { type: 'start', name, attributes, empty: false }; }
      const attribute = this.readName(); this.skipWhitespace();
      if (this.xml[this.position] !== '=') xmlError(`Attribute '${attribute}' has no value.`);
      this.position++; this.skipWhitespace();
      const quote = this.xml[this.position];
      if (quote !== '"' && quote !== "'") xmlError(`Attribute '${attribute}' must be quoted.`);
      this.position++;
      const end = this.xml.indexOf(quote, this.position);
      if (end < 0) xmlError(`Attribute '${attribute}' was not closed.`);
      if (this.xml.slice(this.position, end).includes('<')) xmlError(`Attribute '${attribute}' contains an invalid '<' character.`);
      if (Object.hasOwn(attributes, attribute)) xmlError(`Duplicate attribute '${attribute}'.`);
      attributes[attribute] = decodeText(this.xml.slice(this.position, end));
      this.position = end + 1;
    }
  }

  peekToken() {
    this.pending ??= this.readToken();
    return this.pending;
  }

  namespacesFor(start, inheritedNamespaces = {}) {
    const namespaces = { ...inheritedNamespaces };
    for (const [name, value] of Object.entries(start.attributes)) {
      if (name === 'xmlns') {
        if (value === xmlnsNamespace) xmlError(`The namespace '${xmlnsNamespace}' is reserved.`);
        namespaces[''] = value;
      } else if (name.startsWith('xmlns:')) {
        const prefix = name.slice(6);
        if (prefix === 'xmlns' || value === xmlnsNamespace || prefix === 'xml' && value !== xmlNamespace
          || prefix !== 'xml' && value === xmlNamespace || !value) xmlError(`Invalid namespace declaration '${name}'.`);
        namespaces[prefix] = value;
      }
    }
    namespaces.xml = xmlNamespace;
    const elementPrefix = start.name.includes(':') ? start.name.split(':')[0] : '';
    if (elementPrefix === 'xmlns' || elementPrefix && !Object.hasOwn(namespaces, elementPrefix)) {
      xmlError(`The namespace prefix '${elementPrefix}' is not defined.`);
    }
    const expanded = new Set();
    for (const name of Object.keys(start.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const [prefix, local = null] = name.split(':');
      if (local != null && !Object.hasOwn(namespaces, prefix)) xmlError(`The namespace prefix '${prefix}' is not defined.`);
      const key = local == null ? `|${prefix}` : `${namespaces[prefix]}|${local}`;
      if (expanded.has(key)) xmlError(`Duplicate attribute '${name}'.`);
      expanded.add(key);
    }
    return namespaces;
  }

  validateLookahead(token, inheritedNamespaces, parentName) {
    if (token.type === 'start') this.namespacesFor(token, inheritedNamespaces);
    if (token.type === 'end' && token.name !== parentName) {
      xmlError(`The '${parentName}' start tag does not match the '${token.name}' end tag.`);
    }
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${parentName}'.`);
    return token;
  }

  readNode(start, inheritedNamespaces = {}, { allowChildren = true } = {}) {
    const namespaces = this.namespacesFor(start, inheritedNamespaces);
    const content = [];
    if (!start.empty) while (true) {
      const token = this.readToken();
      if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
      if (token.type === 'end') {
        if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
        break;
      }
      if (token.type === 'start') {
        if (!allowChildren) xmlError(`The '${start.name}' element cannot contain child elements.`);
        content.push(this.readNode(token, namespaces));
      } else if (token.type === 'text') content.push(token.value);
      // Comments and processing instructions do not contribute to element text.
    }
    return { name: start.name, attributes: start.attributes, namespaces, content,
      text: content.filter(part => typeof part === 'string').join(''),
      children: content.filter(part => typeof part !== 'string') };
  }
}
const Cursor = XmlTokenCursor;

function* readRatingsSteps(cursor, start, inheritedNamespaces) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  if (start.empty) return;
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      return;
    }
    if (token.type !== 'start') continue;
    if (token.name !== 'rating') { cursor.readNode(token, namespaces); continue; }
    const ratingNamespaces = cursor.namespacesFor(token, namespaces);
    if (token.empty) continue;
    while (true) {
      const child = cursor.readToken();
      if (child.type === 'eof') xmlError(`Unexpected end of file while reading '${token.name}'.`);
      if (child.type === 'end') {
        if (child.name !== token.name) xmlError(`The '${token.name}' start tag does not match the '${child.name}' end tag.`);
        break;
      }
      if (child.type !== 'start') continue;
      if (child.name !== 'value') { cursor.readNode(child, ratingNamespaces); continue; }
      const value = cursor.readNode(child, ratingNamespaces, { allowChildren: false });
      cursor.validateLookahead(cursor.peekToken(), ratingNamespaces, token.name);
      yield { type: 'rating', name: token.attributes.name, value: value.text };
    }
  }
}

function* readVideoSteps(cursor, start, inheritedNamespaces) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  if (start.empty) return;
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      return;
    }
    if (token.type !== 'start') continue;
    if (!['format3d', 'aspect', 'width', 'height', 'durationinseconds'].includes(token.name)) {
      cursor.readNode(token, namespaces); continue;
    }
    const value = cursor.readNode(token, namespaces, { allowChildren: false });
    cursor.validateLookahead(cursor.peekToken(), namespaces, start.name);
    yield { type: 'video-field', name: token.name, value: value.text };
  }
}

function* readSubtitleSteps(cursor, start, inheritedNamespaces) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  if (start.empty) return;
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      return;
    }
    if (token.type !== 'start') continue;
    if (token.name !== 'language') { cursor.readNode(token, namespaces); continue; }
    cursor.readNode(token, namespaces, { allowChildren: false });
    cursor.validateLookahead(cursor.peekToken(), namespaces, start.name);
    yield { type: 'subtitle-language' };
  }
}

function* readStreamDetailsSteps(cursor, start, inheritedNamespaces, { streamVideoFields }) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  if (start.empty) return;
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      return;
    }
    if (token.type !== 'start') continue;
    if (token.name === 'video' && streamVideoFields) yield* readVideoSteps(cursor, token, namespaces);
    else if (token.name === 'video') cursor.readNode(token, namespaces);
    else if (token.name === 'subtitle') yield* readSubtitleSteps(cursor, token, namespaces);
    else cursor.readNode(token, namespaces);
  }
}

function* readFileInfoSteps(cursor, start, inheritedNamespaces, options) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  if (start.empty) return;
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      return;
    }
    if (token.type !== 'start') continue;
    if (token.name === 'streamdetails') yield* readStreamDetailsSteps(cursor, token, namespaces, options);
    else cursor.readNode(token, namespaces);
  }
}

function readFieldsNode(cursor, start, inheritedNamespaces, scalarChildren) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  const content = [];
  if (!start.empty) while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      break;
    }
    if (token.type === 'start') content.push(cursor.readNode(token, namespaces, { allowChildren: !scalarChildren.has(token.name) }));
    else if (token.type === 'text') content.push(token.value);
  }
  return { name: start.name, attributes: start.attributes, namespaces, content,
    text: content.filter(part => typeof part === 'string').join(''),
    children: content.filter(part => typeof part !== 'string') };
}

const personFields = new Set(['name', 'Name', 'role', 'Role', 'type', 'Type', 'order', 'sortorder', 'SortOrder', 'thumb']);
const readActorNode = (cursor, start, namespaces) => readFieldsNode(cursor, start, namespaces, personFields);

function* readFanartContainer(cursor, start, inheritedNamespaces, state) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  if (start.empty) return;
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      return;
    }
    if (token.type !== 'start') continue;
    if (!state.found && token.name === 'thumb') {
      state.found = true;
      const node = cursor.readNode(token, namespaces, { allowChildren: false });
      cursor.validateLookahead(cursor.peekToken(), namespaces, start.name);
      yield { type: 'fanart-thumb', node };
    } else if (!state.found) {
      yield* readFanartContainer(cursor, token, namespaces, state);
    } else {
      cursor.readNode(token, namespaces);
    }
  }
}

function* readFanartSteps(cursor, start, inheritedNamespaces) {
  yield* readFanartContainer(cursor, start, inheritedNamespaces, { found: false });
}

function readDetailedNode(cursor, start, inheritedNamespaces) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  const content = [];
  if (!start.empty) while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      break;
    }
    if (token.type === 'start') content.push({ type: 'node', node: readDetailedNode(cursor, token, namespaces) });
    else if (token.type === 'text') content.push({ type: 'text', value: token.value, cdata: token.cdata === true });
  }
  return { name: start.name, attributes: start.attributes, namespaces, content,
    text: content.filter(part => part.type === 'text').map(part => part.value).join(''),
    children: content.filter(part => part.type === 'node').map(part => part.node) };
}

function* readMovieSetSteps(cursor, start, inheritedNamespaces, rootName) {
  // MovieNfoParser first calls ReadInnerXml. No collection name is observable
  // until the whole outer set and the following root token are valid.
  const node = readDetailedNode(cursor, start, inheritedNamespaces);
  cursor.validateLookahead(cursor.peekToken(), inheritedNamespaces, rootName);
  for (const part of node.content) {
    if (part.type === 'text') {
      // ParseSetXml reacts to direct Text, but not Whitespace or CDATA.
      if (!part.cdata && !isXmlWhitespace(part.value)) {
        yield { type: 'set-name', value: part.value };
        return;
      }
      continue;
    }
    if (part.node.name !== 'name') continue;
    // ReadElementContentAsString throws on a nested element. ParseSetXml
    // swallows that exception while retaining earlier name assignments.
    if (part.node.children.length) return;
    yield { type: 'set-name', value: part.node.text };
  }
}

function nextContentToken(cursor) {
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'comment' || token.type === 'processing-instruction') continue;
    if (token.type === 'text' && isXmlWhitespace(token.value)) continue;
    return token;
  }
}

// A node event is deliberately yielded only after the token following its end
// tag has been lexed. This mirrors XmlReader.ReadElementContentAs* advancing to
// the next node before returning its value. Attribute-only native effects are
// represented by the earlier start event.
export function* readXmlSteps(xml, {
  scalarNames = new Set(), streamActor = true, streamRatings = true, streamFileInfo = true, streamVideoFields = true,
  streamFanart = true, streamMovieSet = false, streamTraversal = false,
} = {}) {
  if (/<!DOCTYPE\b/i.test(xml)) xmlError('DTD declarations are prohibited.');
  const cursor = new Cursor(xml);
  const root = nextContentToken(cursor);
  if (root.type !== 'start') xmlError('An NFO document must have exactly one root element.');
  const namespaces = cursor.namespacesFor(root, {});
  if (root.empty) {
    if (nextContentToken(cursor).type !== 'eof') xmlError('An NFO document must have exactly one root element.');
    return;
  }
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${root.name}'.`);
    if (token.type === 'comment' || token.type === 'processing-instruction') continue;
    // BaseNfoParser advances past direct root text without importing it.
    if (token.type === 'text') {
      if (streamTraversal) yield { type: 'traversal' };
      continue;
    }
    if (token.type === 'end') {
      if (token.name !== root.name) xmlError(`The '${root.name}' start tag does not match the '${token.name}' end tag.`);
      if (streamTraversal) yield { type: 'traversal' };
      if (nextContentToken(cursor).type !== 'eof') xmlError('An NFO document must have exactly one root element.');
      return;
    }
    cursor.namespacesFor(token, namespaces);
    yield { type: 'start', name: token.name, attributes: token.attributes };
    if (token.name === 'actor' && streamActor) {
      yield { type: 'node', node: readActorNode(cursor, token, namespaces) };
    } else if (token.name === 'ratings' && streamRatings) {
      yield* readRatingsSteps(cursor, token, namespaces);
    } else if (token.name === 'fileinfo' && streamFileInfo) {
      yield* readFileInfoSteps(cursor, token, namespaces, { streamVideoFields });
    } else if (token.name === 'fanart' && streamFanart) {
      yield* readFanartSteps(cursor, token, namespaces);
    } else if (token.name === 'set' && streamMovieSet) {
      yield* readMovieSetSteps(cursor, token, namespaces, root.name);
    } else {
      const scalar = typeof scalarNames === 'function' ? scalarNames(token.name) : scalarNames.has(token.name);
      const node = cursor.readNode(token, namespaces, { allowChildren: !scalar });
      cursor.validateLookahead(cursor.peekToken(), namespaces, root.name);
      yield { type: 'node', node };
    }
  }
}

function peekLocalToken(cursor) {
  while (['comment', 'processing-instruction'].includes(cursor.peekToken().type)) cursor.readToken();
  return cursor.peekToken();
}

function* readLocalContainer(cursor, start, inheritedNamespaces, children) {
  const namespaces = cursor.namespacesFor(start, inheritedNamespaces);
  yield { type: 'container-start', name: start.name };
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${start.name}'.`);
    if (token.type === 'end') {
      if (token.name !== start.name) xmlError(`The '${start.name}' start tag does not match the '${token.name}' end tag.`);
      // ReadSubtree reaches its own EOF without lexing the next outer token.
      yield { type: 'container-end', name: start.name };
      yield { type: 'traversal' };
      return;
    }
    if (token.type !== 'start') continue;
    const fields = children[token.name];
    if (fields instanceof Set) {
      const node = readFieldsNode(cursor, token, namespaces, fields);
      if (!token.empty) yield { type: 'container-node', container: start.name, node };
      else cursor.validateLookahead(peekLocalToken(cursor), namespaces, start.name);
    } else {
      const node = cursor.readNode(token, namespaces, { allowChildren: fields !== false });
      cursor.validateLookahead(peekLocalToken(cursor), namespaces, start.name);
      if (fields === false) yield { type: 'container-node', container: start.name, node };
    }
  }
}

/** BaseItemXmlParser's case-sensitive stream, including ReadSubtree commit
 * boundaries. Share the lexical reader with NFO without changing NFO events. */
export function* readLocalXmlSteps(xml, { scalarNames, type } = {}) {
  const containers = {
    TagLines: { Tagline: false }, Genres: { Genre: false }, Studios: { Studio: false },
    Tags: { Tag: false }, Trailers: { Trailer: false }, Persons: { Person: personFields, Actor: personFields },
    ...(type === 'Playlist' ? { Shares: { Share: new Set(['UserId', 'CanEdit']) },
      PlaylistItems: { PlaylistItem: new Set(['Path', 'ItemId']) } }
      : { CollectionItems: { CollectionItem: new Set(['Path', 'ItemId']) } })
  };
  const cursor = new Cursor(String(xml).replaceAll('\r\n', '\n').replaceAll('\r', '\n')), root = nextContentToken(cursor);
  if (root.type !== 'start') xmlError('An XML document must have exactly one root element.');
  const namespaces = cursor.namespacesFor(root, {});
  if (root.empty) {
    if (nextContentToken(cursor).type !== 'eof') xmlError('An XML document must have exactly one root element.');
    return;
  }
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') xmlError(`Unexpected end of file while reading '${root.name}'.`);
    if (['comment', 'processing-instruction'].includes(token.type)) continue;
    yield { type: 'traversal' };
    if (token.type === 'end') {
      if (token.name !== root.name) xmlError(`The '${root.name}' start tag does not match the '${token.name}' end tag.`);
      if (nextContentToken(cursor).type !== 'eof') xmlError('An XML document must have exactly one root element.');
      return;
    }
    if (token.type !== 'start') continue;
    cursor.namespacesFor(token, namespaces);
    if (Object.hasOwn(containers, token.name) && !token.empty) {
      yield* readLocalContainer(cursor, token, namespaces, containers[token.name]);
    } else {
      const scalar = typeof scalarNames === 'function' ? scalarNames(token.name) : scalarNames.has(token.name);
      const node = cursor.readNode(token, namespaces, { allowChildren: !scalar });
      cursor.validateLookahead(peekLocalToken(cursor), namespaces, root.name);
      yield { type: 'node', node };
    }
  }
}
