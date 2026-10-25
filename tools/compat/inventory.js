import { validationPath } from '../validation/paths.js';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

async function walk(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['bin', 'obj', '.git'].includes(entry.name)) continue;
    const path = validationPath(resolve(root, entry.name));
    if (entry.isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths;
}

export async function inventory(source) {
  const routes = [];
  const providers = [];
  for (const path of await walk(source)) {
    const name = relative(source, path).replaceAll('\\', '/');
    if (!path.endsWith('.cs') || name.startsWith('tests/')) continue;
    if (/Controller\.cs$/.test(name)) {
      const text = await readFile(path, 'utf8');
      const className = /class\s+(\w+Controller)\b/.exec(text)?.[1];
      const classOffset = text.search(/class\s+\w+Controller\b/);
      const prefix = text.slice(0, classOffset);
      const classRoutes = [...prefix.matchAll(/\[Route\("([^"]*)"\)\]/g)].map(match => match[1]);
      if (!classRoutes.length && /:\s*BaseJellyfinApiController/.test(text)) classRoutes.push('[controller]');
      const matches = [...text.matchAll(/\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\("([^"]*)"[^\]]*\))?\]/g)];
      for (const match of matches) {
        const template = match[2] ?? '';
        const prefixes = template.startsWith('/') || template.startsWith('~/') ? [''] : classRoutes;
        const resolved = prefixes.map(base => `/${[base, template.replace(/^~?\//, '')].filter(Boolean).join('/')}`
          .replaceAll('[controller]', className?.replace(/Controller$/, '') ?? '[unresolved]'));
        routes.push({
          source: name, line: text.slice(0, match.index).split('\n').length,
          controller: className, method: match[1].toUpperCase(), template,
          candidateRoutes: resolved, status: 'unreviewed',
          evidence: 'Static attribute inventory only; runtime routes, binding, authorization and responses are not verified.',
        });
      }
    }
    if (/MediaBrowser\.Providers\/Plugins\/Tmdb\/|MediaBrowser\.XbmcMetadata\//.test(name)) {
      providers.push({ source: name, status: 'unreviewed' });
    }
  }
  return { source: resolve(source), routes, metadataSources: providers,
    additionalSurfaces: ['WebSocket', 'UDP discovery', 'Middleware', 'Plugin controller discovery', 'Base URL'],
    runtimeVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.argv[2] ?? '.test-input/baselines/jellyfin-current/source';
  const result = await inventory(source);
  await mkdir(validationPath('.test-input/evidence'), { recursive: true });
  await writeFile(validationPath('.test-input/evidence/contracts.json'), `${JSON.stringify(result, null, 2)}\n`);
  const core = result.routes.filter(route => route.source.startsWith('Jellyfin.Api/Controllers/'));
  console.log(JSON.stringify({ coreAttributes: core.length, allAttributes: result.routes.length,
    coreControllers: new Set(core.map(route => route.controller)).size, metadataSources: result.metadataSources.length }));
}
