import assert from 'node:assert/strict';
import path from 'node:path';
import { idKey } from '../../src/library/records.js';

// A single source has no version-label choice. Bind each display label to the
// same persistent file before comparing client path substitutions. Native raw
// responses remain intact; multi-source labels are never projected here.
export function projectSingleSourceName(body, items, native, observations, name) {
  if (!body?.MediaSources || body.MediaSources.length !== 1) return body;
  const source = body.MediaSources[0], item = items.find(item => idKey(item.id) === idKey(source.Id));
  assert.ok(item);
  if (!item.path || /:.*\/\//u.test(item.path)) return body;
  const api = native && process.platform !== 'win32' ? path.posix : path.win32;
  const file = api.basename(item.path), dot = file.lastIndexOf('.');
  const label = dot < 0 ? file : file.slice(0, dot);
  assert.equal(source.Name, label, name);
  observations.push({ name, native, itemId: source.Id, identityPath: item.path, label: source.Name });
  return { ...body, MediaSources: [{ ...source, Name: '$single-file:' + source.Id }] };
}
