import { lowerInvariant } from '../core/identity.js';
import caseFoldExceptions from '../core/resources/invariant-case-fold.json' with { type: 'json' };
import { clrTrim } from '../metadata/whitespace.js';
import { domainError } from './native.js';

const comparer = new Intl.Collator('en', { sensitivity: 'variant' });
const caseKey = value => [...value].map(character => caseFoldExceptions[character] ?? lowerInvariant(character)).join('');
const sameName = (left, right) => comparer.compare(caseKey(left), caseKey(right)) === 0;

export class StartupService {
  #pending = new Set();
  #closed = false;
  #closing;

  constructor(options) {
    if (!options.users || !options.configuration) throw new TypeError('Startup requires user and server configuration services.');
    Object.assign(this, { users: options.users, configurationStore: options.configurationStore, namedConfiguration: options.namedConfiguration, options });
  }

  #run(operation) {
    if (this.#closed) return Promise.reject(domainError(503, 'Startup is closing.'));
    const pending = Promise.resolve().then(operation);
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }

  #store() {
    if (!this.configurationStore) throw domainError(501, 'Native configuration storage is unavailable.');
    return this.configurationStore;
  }

  getConfiguration() {
    return this.#run(() => {
      const configuration = this.options.configuration;
      return Object.fromEntries(['ServerName', 'UICulture', 'MetadataCountryCode', 'PreferredMetadataLanguage']
        .map(name => [name, Object.hasOwn(configuration, name) ? configuration[name]
          : name === 'ServerName' ? '' : name === 'UICulture' ? 'en-US' : name === 'MetadataCountryCode' ? 'US' : 'en']));
    });
  }

  updateConfiguration(input) {
    return this.#run(() => this.#store().updateServerValues(Object.fromEntries(['ServerName', 'UICulture', 'MetadataCountryCode', 'PreferredMetadataLanguage']
      .map(name => [name, input[name] ?? '']))));
  }

  complete() {
    return this.#run(() => this.#store().updateServerValues({ IsStartupWizardCompleted: true }));
  }

  updateRemoteAccess(input) {
    return this.#run(async () => {
      if (!this.namedConfiguration) throw domainError(501, 'Native configuration storage is unavailable.');
      const configuration = this.namedConfiguration.getCurrentConfiguration('network');
      configuration.EnableRemoteAccess = input.EnableRemoteAccess;
      await this.namedConfiguration.saveConfiguration('network', configuration);
    });
  }

  getUser() {
    return this.#run(async () => {
      await this.users.initialize();
      const user = await this.users.getFirstUser();
      if (!user) throw new Error('No user exists after initialization.');
      return { Name: user.Username, Password: null };
    });
  }

  updateUser(input) {
    return this.#run(async () => {
      const user = await this.users.getFirstUser();
      if (!user) return 'missing';
      if (user.Password != null && user.Password !== '') return 'configured';
      if (input.Password == null || clrTrim(input.Password) === '') return 'empty-password';
      await this.users.saveUserSnapshot(user);
      if (input.Name != null && !sameName(input.Name, user.Username)) await this.users.renameUser(user.Id, user.Username, input.Name);
      if (input.Password !== '') await this.users.changePassword(user.Id, input.Password);
      return 'updated';
    });
  }

  close() {
    this.#closed = true;
    return this.#closing ??= Promise.allSettled([...this.#pending]).then(() => {});
  }
}
