import { BindingError, booleanValue, guidValue, queryValue } from './binding.js';
import { clrTrim } from '../metadata/whitespace.js';
import { parseInvariantDate } from '../core/invariant-date-parse.js';
import { activitySeverityNames, activitySortFields, queryActivityLog } from '../activity/activity-log-query.js';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { BinaryResult } from './binary-result.js';
import { stringifyNativeJson } from '../core/json.js';
import { jsonProfile } from './json-profile.js';

const sortOrders = { Ascending: 0, Descending: 1 };
const severityFields = Object.fromEntries(activitySeverityNames.map((name, value) => [name, value]));
const queryValues = (query, name) => [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
const nullable = value => value === undefined || clrTrim(value) === '' ? undefined : value;

function integer(value, name) {
  // MVC's Int32 converter first trims CLR whitespace; the number parser then
  // accepts ASCII whitespace and trailing NULs. Keep value for model state.
  const text = clrTrim(value);
  if (/^[\t\n\v\f\r ]*[+-]?\d+[\t\n\v\f\r ]*\0*$/u.test(text)) {
    const converted = Number(text.replace(/\0+$/u, ''));
    if (Number.isInteger(converted) && converted >= -2147483648 && converted <= 2147483647) return converted;
  }
  throw new BindingError(name, `The value '${value}' is not valid.`);
}

// These arrays use MVC's normal EnumTypeModelBinder. A comma inside one value
// is converted by EnumConverter as one OR-combined enum, not a split array.
function enumValue(value, fields) {
  let converted = 0;
  for (const part of value.split(',')) {
    const token = clrTrim(part);
    let number;
    if (/^[+-]?\d+$/u.test(token)) number = Number(token);
    else number = Object.entries(fields).find(([name]) => name.toLowerCase() === token.toLowerCase())?.[1];
    if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) return undefined;
    converted |= number;
  }
  return converted;
}

function enumArray(query, name, fields, addError) {
  const direct = queryValues(query, name), result = [];
  const parse = (raw, key, attempted = raw) => {
    if (raw !== undefined && clrTrim(raw) === '') {
      addError(key, `The value '${attempted}' is invalid.`); return false;
    }
    const value = raw === undefined ? 0 : enumValue(raw, fields);
    if (value === undefined) addError(key, `The value '${attempted}' is not valid.`);
    else if (!Object.values(fields).includes(value)) addError(key, `The value '${attempted}' is invalid.`);
    else { result.push(value); return true; }
    return false;
  };
  if (direct.length) {
    for (const value of direct) parse(value, name);
    return result;
  }
  const indexes = queryValues(query, name + '.index');
  const indexed = key => parse(queryValue(query, key), key, queryValues(query, key).join(','));
  if (indexes.length) for (const index of indexes) indexed(`${name}[${index}]`);
  else for (let index = 0; ; index++) {
    const key = `${name}[${index}]`, value = queryValue(query, key);
    if (value === undefined || !indexed(key)) break;
  }
  return result;
}

export function bindActivityLogQuery(query) {
  let failure;
  const addError = (name, message) => {
    if (!failure) failure = new BindingError(name, message);
    else (failure.errors[name] ??= []).push(message);
  };
  const bind = (name, operation) => {
    const raw = queryValue(query, name), value = nullable(raw);
    if (value === undefined) return undefined;
    try { return operation(value, name); }
    catch (error) {
      if (!(error instanceof BindingError)) throw error;
      // Simple scalar binding reports the full repeated value in model state.
      for (const message of Object.values(error.errors).flat()) addError(name,
        message.replace(`'${value}'`, `'${queryValues(query, name).join(',')}'`));
      return undefined;
    }
  };
  const date = (value, name) => {
    const converted = parseInvariantDate(value);
    if (converted === null) throw new BindingError(name, `The value '${value}' is not valid.`);
    return converted;
  };
  const result = { startIndex: bind('startIndex', integer), limit: bind('limit', integer),
    minDate: bind('minDate', date), maxDate: bind('maxDate', date), hasUserId: bind('hasUserId', booleanValue) };
  for (const name of ['name', 'overview', 'shortOverview', 'type', 'username']) result[name] = nullable(queryValue(query, name));
  result.itemId = bind('itemId', guidValue);
  // The designated nullable-enum binder silently leaves malformed severity
  // unset, but accepts unnamed Int32 values and comma combinations.
  const severity = queryValue(query, 'severity');
  result.severity = severity === undefined ? undefined : enumValue(severity, severityFields);
  result.sortBy = enumArray(query, 'sortBy', activitySortFields, addError);
  result.sortOrder = enumArray(query, 'sortOrder', sortOrders, addError);
  if (failure) throw failure;
  return result;
}

export function registerActivityLogRoutes(add, { store }) {
  add('GET', '/System/ActivityLog/Entries', context => {
    const limit = context.queryInput.limit ?? 100;
    if (limit >= 0 && limit <= 128) return queryActivityLog(store, context.queryInput, { signal: context.signal });
    return new BinaryResult(async (request, response) => {
      const disconnected = new AbortController();
      const abort = () => { if (!response.writableFinished) disconnected.abort(); };
      request.once('aborted', abort); response.once('close', abort);
      const signal = AbortSignal.any([context.signal, disconnected.signal]);
      if (request.aborted || response.destroyed) abort();
      const completion = finished(response, { cleanup: true });
      void completion.catch(() => {});
      const profile = jsonProfile(request.headers.accept ?? ''), camel = profile === 'CamelCase';
      const write = async value => {
        signal.throwIfAborted();
        if (!response.write(value)) await once(response, 'drain', { signal });
      };
      try {
        await queryActivityLog(store, context.queryInput, { signal, consume: async (metadata, pages) => {
          signal.throwIfAborted();
          response.setHeader('Content-Type', 'application/json' + (profile ? '; profile="' + profile + '"' : '') + '; charset=utf-8');
          await write(camel ? '{"items":[' : '{"Items":[');
          let first = true;
          for await (const rows of pages) for (const row of rows) {
            await write((first ? '' : ',') + stringifyNativeJson(row, { camel })); first = false;
          }
          await write('],' + stringifyNativeJson(metadata, { camel }).slice(1));
          response.end();
          await completion;
        } });
      } catch (error) {
        if (response.headersSent || signal.aborted) response.destroy();
        throw error;
      } finally {
        request.removeListener('aborted', abort); response.removeListener('close', abort);
      }
    });
  },
    { policy: 'RequiresElevation', bindQuery: bindActivityLogQuery });
}
