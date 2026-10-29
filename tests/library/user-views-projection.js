import assert from 'node:assert/strict';
import { parseLosslessJson } from '../../src/core/json.js';
import { tokenizeJson } from '../../src/core/json-tokens.js';
import { nativeItemJsonContract, nativeItemJsonValidationManifest } from '../../src/library/native-item-data.js';
import { idKey } from '../../src/library/records.js';
import { projectItemDataIdentities } from '../helpers/fixture-identity-projection.js';
import { projectItemBody } from '../helpers/http-body-projection.js';
import { projectStatePath, projectStateMacroPath } from './fixture-state-path.js';

const viewType = 'MediaBrowser.Controller.Entities.UserView';
const viewFields = new Map(nativeItemJsonContract(viewType).map(field => [field.name, field]));
const nested = nativeItemJsonValidationManifest().nested;

/** Bind the recorded state roles from the preserved Native values, rather than
 * the later storage location of the evidence directory. */
export function recordedUserViewsStateRoots(contract, fixture) {
  const declared = fixture.items.filter(item => item.key === 'userRoot' && item.type === 'UserRootFolder');
  assert.equal(declared.length, 1);
  const roots = contract.native.before.database.baseItems.filter(row => row.Type === 'MediaBrowser.Controller.Entities.UserRootFolder'
    && idKey(row.Id) === idKey(declared[0].id));
  assert.equal(roots.length, 1);
  const root = roots[0]; assert.equal(typeof root.Path, 'string');
  // ServerApplicationPaths constructs DefaultUserViewsPath from ProgramDataPath
  // + root/default and defaults InternalMetadataPath to ProgramDataPath/metadata.
  const suffix = /([\\/])data\1root\1default$/u.exec(root.Path);
  assert.ok(suffix && suffix.index > 0, 'The recorded UserRootFolder must identify its declared default state role.');
  assert.equal(contract.configuration.MetadataPath, '', 'This recorded profile uses Native default internal metadata.');
  const referenceRoot = root.Path.slice(0, suffix.index), separator = suffix[1];
  const programDataPath = referenceRoot + separator + 'data', metadataPath = programDataPath + separator + 'metadata';
  const macro = '%MetadataPath%', views = new Map(contract.native.afterShutdown.database.baseItems
    .filter(row => row.Type === viewType && typeof row.Path === 'string' && row.Path.startsWith(macro + separator))
    .map(row => [idKey(row.Id), row]));
  const observed = new Set();
  for (const record of contract.http) for (const item of record.response.bodyJson?.Items ?? []) {
    const stored = views.get(idKey(item.Id));
    if (item.Type !== 'UserView' || !stored || typeof item.Path !== 'string') continue;
    assert.equal(item.Path, metadataPath + stored.Path.slice(macro.length), 'The recorded UserView HTTP path must consume its actual metadata root.');
    observed.add(idKey(item.Id));
  }
  assert.ok(observed.size > 0, 'The metadata root must have actual typed UserView HTTP consumers.');
  return { referenceRoot, programDataPath, metadataPath, userRootId: root.Id, metadataViewIds: [...observed] };
}

// Discover candidate path values, then let the actual Data contract select the
// allowed tokens. Unknown fields, duplicate keys and numeric spelling stay raw.
export function rebindUserViewsDataPaths(text, type, path) {
  if (typeof text !== 'string') return text;
  let value;
  try { value = parseLosslessJson(text); } catch { return text; }
  const paths = new Map();
  const visit = value => {
    if (typeof value === 'string') {
      const mapped = path(value); if (mapped !== value) paths.set(value, mapped);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(value);
  return projectItemDataIdentities(text, type, new Map(), { paths });
}

export const userViewsPath = (value, root) => projectStateMacroPath(projectStatePath(value, root, '$instance'), root);

export function projectUserViewsData(text, type, root, { newView = false } = {}) {
  const rebound = rebindUserViewsDataPaths(text, type, value => userViewsPath(value, root));
  // Only these newly generated typed UserView documents have independent save
  // clocks. The caller separately proves their Data/SQL clock relationship.
  if (!newView || type !== viewType || typeof rebound !== 'string') return rebound;
  const unknown = [];
  const source = node => parseLosslessJson(rebound.slice(node.start, node.end));
  const visit = (node, fields, path = []) => {
    if (!node.properties) return source(node);
    const value = {};
    for (const [name, child] of node.properties) {
      const field = fields.get(name), location = [...path, name];
      if (!field) {
        unknown.push({ path: location, raw: rebound.slice(child.start, child.end) });
        value[name] = source(child); continue;
      }
      if (!path.length && name === 'DateLastSaved') continue;
      const kind = field.kind.replace(/\[\]$/u, '');
      const element = (entry, index) => nested[kind] ? visit(entry, new Map(Object.entries(nested[kind])),
        index === undefined ? location : [...location, index]) : source(entry);
      value[name] = field.kind.endsWith('[]') && child.items ? child.items.map(element) : element(child);
    }
    return value;
  };
  return { value: visit(tokenizeJson(rebound), viewFields), unknown };
}

export function projectUserViewsBody(body, root, { serverId, status } = {}) {
  return projectItemBody(body, { serverId, status, date: value => value, path: value => userViewsPath(value, root) });
}
