const base = { BaseUrl: '/a', EnableIPv4: true, EnableIPv6: false, LocalNetworkAddresses: ['127.0.0.1'],
  KnownProxies: ['127.0.0.1'], AutoDiscovery: false, InternalHttpPort: 0, InternalHttpsPort: '$https', EnableHttps: false, RequireHttps: false };
const tls = { ...base, CertificatePath: '$a', CertificatePassword: '$password', EnableHttps: true };
const effects = { ...tls, InternalHttpPort: '$http' };
const post = (values, extra = {}) => ({ action: 'postNetwork', values, ...extra });

export const networkListenerInput = () => ({
  identity: 'network-listener-init-kestrel-tls-ordered-effects-native-only-20261025',
  certificatePassword: 'isolated-network-listener-password',
  certificateValidity: { notBefore: '2026-01-01T00:00:00Z', notAfter: '2036-01-01T00:00:00Z' },
  interfaceInput: '127.0.0.1/8,1,lo',
  // This URL is a declared Kestrel fallback input, used only when Setup registers
  // no Listen endpoint. It is not a claim about the full application's default.
  fallbackUrl: 'http://127.0.0.1:0',
  listeners: [
    { name: 'plain-http-inactive-invalid-https-port', initial: { ...base, InternalHttpsPort: -1 } },
    { name: 'https-a-and-startup-required-redirect', initial: { ...tls, RequireHttps: true } },
    { name: 'https-b', initial: { ...tls, CertificatePath: '$b' } },
    { name: 'certificate-loaded-while-https-disabled', initial: { ...tls, EnableHttps: false, RequireHttps: true } },
    { name: 'missing-pfx-http-survives', initial: { ...tls, CertificatePath: '$missing', RequireHttps: true } },
    { name: 'bad-pfx-http-survives', initial: { ...tls, CertificatePath: '$bad', RequireHttps: true } },
    { name: 'wrong-password-http-survives', initial: { ...tls, CertificatePassword: 'wrong-password', RequireHttps: true } },
    { name: 'certificate-only-http-survives', initial: { ...tls, CertificatePath: '$certificateOnly', RequireHttps: true } },
    { name: 'invalid-active-http-port', initial: { ...base, InternalHttpPort: -1 } },
    { name: 'invalid-active-https-port', initial: { ...tls, InternalHttpsPort: 65536 } },
    { name: 'equal-zero-ports-captured-fallback', initial: { ...base, InternalHttpPort: 0, InternalHttpsPort: 0 } },
    { name: 'no-addresses-kestrel-declared-fallback', initial: { ...base, EnableIPv4: false, EnableIPv6: false, LocalNetworkAddresses: [] } },
  ],
  effects: [
    { name: 'ports-change-saves-authorization-before-pending', initial: effects, steps: [post({ InternalHttpPort: '$nextHttp' }, { waitSystemEvent: true })] },
    { name: 'port-and-missing-certificate-retain-saved-prefix', initial: effects, steps: [post({ InternalHttpPort: '$nextHttp', CertificatePath: '$missing' }, { waitSystemEvent: true })] },
    { name: 'nested-system-file-failure-retains-live-authorization-prefix', initial: effects, steps: [
      { action: 'blockSystemFile' }, post({ InternalHttpPort: '$nextHttp' }),
    ] },
    { name: 'existing-invalid-certificate-only-marks-restart', initial: effects, steps: [post({ CertificatePath: '$bad' })] },
    { name: 'password-removal-and-flags-keep-startup-listeners', initial: effects, steps: [
      post({ CertificatePassword: 'wrong-password' }), post({ CertificatePath: '' }), post({ EnableHttps: false, RequireHttps: true }),
    ] },
    { name: 'any-named-update-reads-canonical-network', initial: effects, steps: [
      { action: 'mutateNetwork', values: { InternalHttpPort: '$nextHttp' } },
      { action: 'postNamed', key: 'metadata', values: { UseFileCreationTimeForDateAdded: true }, waitSystemEvent: true },
    ] },
    { name: 'system-update-returns-before-queued-certificate-failure', initial: effects, steps: [
      { action: 'mutateNetwork', values: { CertificatePath: '$missing' } }, { action: 'postSystem', waitSystemEvent: true },
    ] },
    { name: 'require-https-is-startup-middleware-choice', initial: effects, steps: [post({ RequireHttps: true })] },
    { name: 'startup-required-redirect-survives-hot-disable', initial: { ...effects, RequireHttps: true }, steps: [post({ EnableHttps: false, RequireHttps: false })] },
    { name: 'hot-enable-uses-loaded-certificate-without-new-tls-listener', initial: { ...effects, EnableHttps: false }, probeUnboundHttps: true,
      steps: [post({ EnableHttps: true, RequireHttps: true })] },
  ],
});
