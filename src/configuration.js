import path from 'node:path';
import { hostname } from 'node:os';
import { loadConfigurationFile, readConfigurationFile } from './core/configuration-file.js';
import { clrTrim } from './metadata/whitespace.js';
import { ServerIdentity, readServerIdentity } from './core/server-identity.js';
import { NamedConfigurationStore } from './core/named-configuration-store.js';

export function serverFriendlyName(configuration, fallback = hostname()) {
  return Object.hasOwn(configuration, 'ServerName') ? configuration.ServerName || hostname() : fallback;
}

function instanceSettings(root, configuration, networkConfiguration, serverId) {
  const configurationDirectoryPath = path.join(root, 'config');
  const programDataPath = path.join(root, 'data'), dataPath = path.join(programDataPath, 'data');
  return { configuration, networkConfiguration, serverId, configurationDirectoryPath, programDataPath, dataPath,
    logDirectoryPath: path.join(root, 'log'),
    metadataPath: clrTrim(configuration.MetadataPath ?? '') === '' ? path.join(programDataPath, 'metadata') : configuration.MetadataPath,
    serverName: configuration.ServerName || hostname() };
}

export async function readInstanceConfiguration(directory, { onError = () => {} } = {}) {
  const root = path.resolve(directory), configurationDirectoryPath = path.join(root, 'config');
  const configuration = await loadConfigurationFile(path.join(configurationDirectoryPath, 'system.xml'), 'server', { onError });
  const named = new NamedConfigurationStore({ configurationDirectoryPath, onError });
  let network;
  try { network = await named.getConfiguration('network'); }
  finally { await named.close(); }
  const serverId = await new ServerIdentity({ dataPath: path.join(root, 'data', 'data'), onError }).getValue();
  return instanceSettings(root, configuration, network, serverId);
}

export async function inspectInstanceConfiguration(directory) {
  const root = path.resolve(directory), configurationDirectoryPath = path.join(root, 'config');
  const configuration = await readConfigurationFile(path.join(configurationDirectoryPath, 'system.xml'), 'server');
  const network = await readConfigurationFile(path.join(configurationDirectoryPath, 'network.xml'), 'network');
  return instanceSettings(root, configuration, network, await readServerIdentity(path.join(root, 'data', 'data')));
}
