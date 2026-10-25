import { parseLosslessJson } from './json.js';

// Retain every property occurrence and its source span. Consumers validate
// duplicate properties in order even when a later property replaces them.
export function tokenizeJson(text) {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const quoted = () => {
    const start = cursor++;
    while (cursor < text.length) { if (text[cursor++] === '"') break; if (text[cursor - 1] === '\\') cursor++; }
    return JSON.parse(text.slice(start,cursor));
  };
  function read() {
    whitespace();
    const start = cursor;
    let value, properties, items;
    if (text[cursor] === '{') {
      properties = []; cursor++; whitespace();
      while (text[cursor] !== '}') {
        const keyStart = cursor, key = quoted(); whitespace(); cursor++;
        const keySpan = { start: keyStart, end: cursor };
        properties.push([key,read(),keySpan]); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '[') {
      items = []; cursor++; whitespace();
      while (text[cursor] !== ']') {
        items.push(read()); whitespace();
        if (text[cursor] !== ',') break;
        cursor++; whitespace();
      }
      cursor++;
    } else if (text[cursor] === '"') value = quoted();
    else {
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
      value = parseLosslessJson(text.slice(start,cursor));
    }
    return { start, end:cursor, value, properties, items };
  }
  return read();
}
