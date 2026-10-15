import path from 'node:path';
import { defaultConfiguration } from '../core/configuration-xml.js';
import { loadConfigurationFile } from '../core/configuration-file.js';
export async function loadMetadataConfiguration({ programDataPath, configurationDirectoryPath, onError = () => {} } = {}) {
  configurationDirectoryPath ??= programDataPath && path.resolve(programDataPath, '..', 'config');
  return {metadata: configurationDirectoryPath ? await loadConfigurationFile(path.join(configurationDirectoryPath,'metadata.xml'),'metadata',{onError}) : defaultConfiguration('metadata')};
}
