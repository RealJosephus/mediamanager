import path from 'node:path';
import { hostname } from 'node:os';
import { defaultConfiguration } from './core/configuration-xml.js';
import { loadConfigurationFile, readConfigurationFile } from './core/configuration-file.js';
import { clrTrim } from './metadata/whitespace.js';
import { ServerIdentity, readServerIdentity } from './core/server-identity.js';

export function serverFriendlyName(configuration, fallback = hostname()) {
  return Object.hasOwn(configuration, 'ServerName') ? configuration.ServerName || hostname() : fallback;
}

export async function loadEncodingConfiguration({ programDataPath, configurationDirectoryPath, onError = () => {} } = {}) {
  if (!programDataPath && !configurationDirectoryPath) return defaultConfiguration('encoding');
  const directory = configurationDirectoryPath ?? path.resolve(programDataPath, '..', 'config');
  return loadConfigurationFile(path.join(directory, 'encoding.xml'), 'encoding', { onError });
}

function instanceSettings(root, configuration, network, serverId) {
  const configurationDirectoryPath = path.join(root, 'config');
  configuration.BaseUrl = network.BaseUrl;
  configuration.NetworkConfiguration = network;
  const programDataPath = path.join(root, 'data'), dataPath = path.join(programDataPath, 'data');
  return { configuration, serverId, configurationDirectoryPath, programDataPath, dataPath,
    metadataPath: clrTrim(configuration.MetadataPath ?? '') === '' ? path.join(programDataPath, 'metadata') : configuration.MetadataPath,
    serverName: configuration.ServerName || hostname() };
}

export async function readInstanceConfiguration(directory, { onError = () => {} } = {}) {
  const root = path.resolve(directory), configurationDirectoryPath = path.join(root, 'config');
  const configuration = await loadConfigurationFile(path.join(configurationDirectoryPath, 'system.xml'), 'server', { onError });
  const network = await loadConfigurationFile(path.join(configurationDirectoryPath, 'network.xml'), 'network', { onError });
  const serverId = await new ServerIdentity({ dataPath: path.join(root, 'data', 'data'), onError }).getValue();
  return instanceSettings(root, configuration, network, serverId);
}

export async function inspectInstanceConfiguration(directory) {
  const root = path.resolve(directory), configurationDirectoryPath = path.join(root, 'config');
  const configuration = await readConfigurationFile(path.join(configurationDirectoryPath, 'system.xml'), 'server');
  const network = await readConfigurationFile(path.join(configurationDirectoryPath, 'network.xml'), 'network');
  return instanceSettings(root, configuration, network, await readServerIdentity(path.join(root, 'data', 'data')));
}
