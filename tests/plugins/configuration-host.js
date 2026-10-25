import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { createConfigurationBinding, namedConfigurationCodec } from '../../packages/plugin-sdk/configuration.js';

export async function openConfiguredPluginHost(options = {}) {
  const directory = options.configurationDirectoryPath ?? (options.programDataPath && path.resolve(options.programDataPath, '..', 'config'))
    ?? (options.directory && path.join(options.directory, 'config'));
  const temporary = directory ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-named-configuration-'));
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory ?? temporary, onError: options.onError });
  const failures = [];
  const attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
  const cleanup = async host => {
    await attempt(() => host?.());
    await attempt(() => store.close());
    if (temporary) await attempt(() => fs.rm(temporary, { recursive: true, force: true }));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Plugin configuration fixture cleanup failed.', { cause: failures[0] });
  };
  try {
    await store.getConfiguration('xbmcmetadata');
    const bindings = new Map(options.configurationBindings ?? []);
    bindings.set('xbmcmetadata', createConfigurationBinding({ getCurrent: () => store.getCurrentConfiguration('xbmcmetadata'),
      save: value => store.saveConfiguration('xbmcmetadata', value), fields: namedConfigurationCodec('xbmcmetadata').fields }));
    const host = await PluginHost.open({ ...options, configurationBindings: bindings });
    const close = host.close.bind(host);
    let closing;
    host.close = () => closing ??= cleanup(close);
    return host;
  } catch (error) {
    failures.push(error);
    await cleanup();
  }
}
