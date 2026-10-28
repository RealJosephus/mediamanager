import { createRuntime } from '../../src/runtime.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';

// Ordinary service fixtures declare a single ephemeral loopback listener.
// Network XML, startup ordering and bind/TLS tests supply their own real inputs
// and use createRuntime/start directly instead of this fixture.
export function createUnstartedTestRuntime(options) {
  return createRuntime({ ...options, networkConfiguration: {
    ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'],
    AutoDiscovery: false, EnablePublishedServerUriByRequest: true, ...options.networkConfiguration,
  } });
}

export async function createTestRuntime(options) {
  const runtime = await createUnstartedTestRuntime(options);
  await runtime.start();
  return runtime;
}
