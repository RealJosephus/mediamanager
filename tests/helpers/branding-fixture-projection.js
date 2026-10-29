import { dateTicks } from '../../src/library/records.js';
import { projectProblemTrace } from './http-body-projection.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const statePath = (value, root) => {
  if (typeof value !== 'string') return value;
  if (value === root) return '{state}';
  return value.startsWith(root + '/') || value.startsWith(root + '\\')
    ? '{state}/' + value.slice(root.length + 1).replaceAll('\\', '/') : value;
};
const options = (value, root, location = 'SplashscreenLocation') => !object(value) || !Object.hasOwn(value, location) ? value
  : { ...value, [location]: statePath(value[location], root) };

export function projectBrandingHttpBody(value, { status, route, root, camel = false }) {
  if (status >= 400) return projectProblemTrace(value, status);
  const pathname = route.split('?')[0].replace(/^\/(?:emby|mediabrowser)(?=\/|$)/iu, '').toLowerCase();
  return ['/branding/configuration', '/system/configuration/branding'].includes(pathname)
    ? options(value, root, camel ? 'splashscreenLocation' : 'SplashscreenLocation') : value;
}

// This is the fixture's declared state/callback summary. Text options, file
// bytes, unknown callbacks and arbitrary dictionaries remain literal.
export function projectBrandingFixtureState(value, root) {
  return { ...value, live: options(value.live, root), disk: options(value.disk, root),
    calls: value.calls.map(call => {
      if (['configuration-updating', 'configuration-updated'].includes(call.phase)) return { ...call, options: options(call.options, root) };
      if (call.phase !== 'image') return call;
      return { ...call,
        ...(Object.hasOwn(call, 'path') ? { path: statePath(call.path, root) } : {}),
        ...(Object.hasOwn(call, 'dateModified') ? { dateModified: String(dateTicks(call.dateModified)) } : {}) };
    }) };
}
