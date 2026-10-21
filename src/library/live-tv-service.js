import path from 'node:path';
import model from './resources/live-tv-configuration-model.json' with { type: 'json' };
import { createConfigurationReader } from '../core/configuration-xml.js';
import { createConfigurationWriter, loadConfigurationFile } from '../core/configuration-file.js';

export const liveTvConfigurationReader = createConfigurationReader(model);
export const serializeLiveTvConfiguration = createConfigurationWriter(model);

export class LiveTvService {
  #configuration;
  constructor({ users, configurationDirectoryPath, onError = () => {}, now = () => new Date() } = {}) {
    Object.assign(this, { users, configurationDirectoryPath, onError, now });
  }

  getConfiguration() {
    return this.#configuration ??= (this.configurationDirectoryPath
      ? loadConfigurationFile(path.join(this.configurationDirectoryPath, 'livetv.xml'), 'livetv', {
        reader: liveTvConfigurationReader, serialize: serializeLiveTvConfiguration, onError: this.onError,
      }) : Promise.resolve(liveTvConfigurationReader.defaultConfiguration('livetv'))).catch(error => {
      this.#configuration = undefined;
      throw error;
    });
  }

  async getInfo() {
    const configuration = await this.getConfiguration();
    return {
      Services: [{ Name: 'Emby', Status: 'Ok', HasUpdateAvailable: false, IsVisible: false, Tuners: [] }],
      IsEnabled: true,
      EnabledUsers: configuration.TunerHosts.length ? await this.users.getLiveTvUserIds() : [],
    };
  }

  async isEnabledForUser(user) {
    if (!user) throw new TypeError('A user is required.');
    return user.Policy.EnableLiveTvAccess === true && (await this.getConfiguration()).TunerHosts.length > 0;
  }

  async getGuideInfo() {
    const configuration = await this.getConfiguration();
    const days = Math.max(1, Math.min(14, configuration.GuideDays ?? 7));
    const start = new Date(this.now());
    return { StartDate: start.toISOString(), EndDate: new Date(start.getTime() + days * 86400000).toISOString() };
  }
}
