import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { BindingError, guidValue, queryValue, notFound } from './binding.js';
import { BinaryResult } from './binary-result.js';
import { jsonProfile } from './json-profile.js';
import { stringifyNativeJson } from '../core/json.js';
import { clrTrim } from '../metadata/whitespace.js';
import { MediaSegmentService, mediaSegmentTypes } from '../library/media-segment-service.js';

const values = (query, name) => [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);

export function bindMediaSegmentQuery(query, params) {
  let failure;
  const fail = (name, message) => {
    if (!failure) failure = new BindingError(name, message);
    else (failure.errors[name] ??= []).push(message);
  };
  let itemId;
  try { itemId = guidValue(params.itemId, 'itemId'); }
  catch (error) { if (!(error instanceof BindingError)) throw error; for (const message of error.errors.itemId) fail('itemId', message); }
  const name = 'includeSegmentTypes', types = [], direct = values(query, name), indexes = values(query, name + '.index');
  const parse = (raw, key, attempted = raw) => {
    if (raw === undefined) { types.push(0); return true; }
    if (clrTrim(raw) === '') { fail(key, `The value '${attempted}' is invalid.`); return false; }
    let result = 0;
    for (const part of raw.split(',')) {
      const token = clrTrim(part), named = mediaSegmentTypes.findIndex(value => value.toLowerCase() === token.toLowerCase());
      const numeric = /^[+-]?\d+$/u.test(token) ? Number(token) : named < 0 ? undefined : named;
      if (!Number.isInteger(numeric) || numeric < -2147483648 || numeric > 2147483647) {
        fail(key, `The value '${attempted}' is not valid.`); return false;
      }
      result |= numeric;
    }
    if (result < 0 || result >= mediaSegmentTypes.length) { fail(key, `The value '${attempted}' is invalid.`); return false; }
    types.push(result); return true;
  };
  let supplied = direct.length > 0 || indexes.length > 0;
  if (direct.length) for (const value of direct) parse(value, name);
  else if (indexes.length) for (const index of indexes) {
    const key = `${name}[${index}]`; parse(queryValue(query, key), key, values(query, key).join(','));
  }
  else for (let index = 0; ; index++) {
    const key = `${name}[${index}]`, value = queryValue(query, key);
    if (value === undefined) break;
    supplied = true; if (!parse(value, key, values(query, key).join(','))) break;
  }
  if (failure) throw failure;
  return { itemId, includeSegmentTypes: supplied ? types : null };
}

export function registerMediaSegmentRoutes(add, services) {
  const segments = services.mediaSegments ?? new MediaSegmentService({ store: services.store, library: services.library });
  add('GET', '/MediaSegments/{itemId}', context => new BinaryResult(async (request, response) => {
    const disconnected = new AbortController();
    const abort = () => { if (!response.writableFinished) disconnected.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    const signal = AbortSignal.any([context.signal, disconnected.signal]);
    if (request.aborted || response.destroyed) abort();
    const completion = finished(response, { cleanup: true }); void completion.catch(() => {});
    const profile = jsonProfile(request.headers.accept ?? ''), camel = profile === 'CamelCase';
    const write = async text => { signal.throwIfAborted(); if (!response.write(text)) await once(response, 'drain', { signal }); };
    try {
      await segments.read(context.queryInput.itemId, { user: context.auth.User, includeSegmentTypes: context.queryInput.includeSegmentTypes,
        signal, consume: async (metadata, pages) => {
          signal.throwIfAborted();
          response.setHeader('Content-Type', 'application/json' + (profile ? '; profile="' + profile + '"' : '') + '; charset=utf-8');
          await write(camel ? '{"items":[' : '{"Items":['); let first = true;
          for await (const rows of pages) for (const row of rows) {
            await write((first ? '' : ',') + stringifyNativeJson(row, { camel })); first = false;
          }
          await write('],' + stringifyNativeJson(metadata, { camel }).slice(1)); response.end(); await completion;
        } });
    } catch (error) {
      if (!response.writableFinished && (response.headersSent || signal.aborted)) response.destroy();
      if (!response.headersSent && error?.status === 404) throw notFound();
      throw error;
    } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
  }), { bindQuery: bindMediaSegmentQuery });
}
