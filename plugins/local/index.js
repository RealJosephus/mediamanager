import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalAdapter } from './adapter.js';

export function validateConfiguration(configuration) {
  if (Object.keys(configuration).length) throw new TypeError('Local file settings belong to each storage instance.');
}

export async function activate(context) {
  validateConfiguration(context.configuration);
  const roots = [...new Set([context.paths.programDataPath, context.paths.dataPath, context.paths.metadataPath,
    context.paths.cachePath, context.paths.pluginStoragePath, context.paths.configurationDirectoryPath].filter(Boolean).map(value => path.resolve(value)))];
  await context.register('storage', {
    type: 'local',
    create: (configuration, options) => LocalAdapter.open(configuration, options),
    defaults: roots.map(root => ({
      id: `application-${createHash('sha256').update(root).digest('hex').slice(0,16)}`, config: { root, createRoot: true, writable: true },
      identityRoot: root, style: process.platform === 'win32' ? 'windows' : 'posix',
    })),
  });
}
