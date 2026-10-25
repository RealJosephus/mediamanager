import { LiveTvConfigurationStore } from '../core/live-tv-configuration-store.js';

export class LiveTvService extends LiveTvConfigurationStore {
  constructor({ users, now = () => new Date(), ...configuration } = {}) {
    super(configuration);
    Object.assign(this, { users, now });
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
