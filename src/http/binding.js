import { randomBytes } from 'node:crypto';
import { parseLosslessJson } from '../core/json.js';
import { wireGuid } from '../users/native.js';
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';

const booleanWhitespace = new RegExp(`^[${clrWhitespace}\\u0000]+|[${clrWhitespace}\\u0000]+$`, 'gu');

export class HttpResult {
  constructor(status, body, { text = false } = {}) { Object.assign(this, { status, body, text }); }
}
export const noContent = () => new HttpResult(204);
export const httpError = (status, message) => Object.assign(new Error(message), { status });
export const badRequest = () => new HttpResult(400, {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'Bad Request', status: 400,
  traceId: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`,
});
const unsupportedMediaType = () => new HttpResult(415, {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.16', title: 'Unsupported Media Type', status: 415,
  traceId: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`
});
export const notFound = () => new HttpResult(404, {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5', title: 'Not Found', status: 404,
  traceId: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`,
});

export class BindingError extends Error {
  constructor(name, message) {
    super(message);
    this.status = 400;
    this.errors = { [name]: [message] };
  }
  problem() {
    return { type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'One or more validation errors occurred.',
      status: 400, errors: this.errors, traceId: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00` };
  }
}

export function queryValue(query, name) {
  return [...query].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
export function booleanValue(value, name, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  const text = value.replace(booleanWhitespace, '');
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  throw new BindingError(name, `The value '${value}' is not valid.`);
}
export function integerValue(value, name, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  if (/^[+-]?\d+$/.test(value.trim()) && Number(value) >= -2147483648 && Number(value) <= 2147483647) return Number(value);
  throw new BindingError(name, `The value '${value}' is not valid.`);
}
export function guidValue(value, name, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  try { return wireGuid(value); }
  catch { throw new BindingError(name, `The value '${value}' is not valid.`); }
}

// CommaDelimitedCollectionModelBinder ignores FormatException entries. It
// splits only one value; repeated query values are converted individually.
export function commaGuidValues(query, name) {
  const values = [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',').filter(value => value !== '') ?? [];
  const result = [];
  for (const entry of entries) {
    try { result.push(wireGuid(clrTrim(entry))); }
    catch { /* Actual native binder logs and discards malformed GUID values. */ }
  }
  return result;
}
export function member(object, name) {
  const key = Object.keys(object).find(key => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}
export function requireMember(object, name) {
  const value = member(object, name);
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) throw new BindingError(name, `The ${name} field is required.`);
  return value;
}

export async function readBody(request, { allowForm = false, allowTextJson = false, optional = false, bind, objectType } = {}) {
  if (optional && !request.headers['transfer-encoding'] && !(Number(request.headers['content-length']) > 0)) return {};
  const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json') && !(allowForm && type === 'application/x-www-form-urlencoded')
    && !(allowTextJson && type === 'text/plain')) throw unsupportedMediaType();
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 30_000_000) throw httpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.length) { if (optional) return {}; throw new BindingError('', 'A non-empty request body is required.'); }
  const arrayStart = /^[ \t\r\n]*\[/.exec(text);
  if (objectType && arrayStart) {
    const consumed = arrayStart[0], line = consumed.split('\n').length - 1, position = Buffer.byteLength(consumed.slice(consumed.lastIndexOf('\n') + 1));
    throw new BindingError('$', `The JSON value could not be converted to ${objectType}. Path: $ | LineNumber: ${line} | BytePositionInLine: ${position}.`);
  }
  let body;
  if (allowForm && type === 'application/x-www-form-urlencoded') body = Object.fromEntries(new URLSearchParams(text));
  else {
    try { body = parseLosslessJson(text); }
    catch {
      if (/^[ \t\r\n]*\{[ \t\r\n]*$/.test(text)) {
        const line = text.split('\n').length - 1, position = Buffer.byteLength(text.slice(text.lastIndexOf('\n') + 1));
        throw new BindingError('$', `Expected depth to be zero at the end of the JSON payload. There is an open JSON object or array that should be closed. Path: $ | LineNumber: ${line} | BytePositionInLine: ${position}.`);
      }
      throw new BindingError('$', 'The request body is not valid JSON.');
    }
  }
  if (bind) return bind(body,text);
  if (optional && body === null) return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BindingError('', 'A non-empty request body is required.');
  if (type !== 'application/x-www-form-urlencoded') Object.defineProperty(body, Symbol.for('mediamanager.jsonSource'), { value: text });
  return body;
}
