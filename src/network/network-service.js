import { networkInterfaces } from 'node:os';
import { lookup as resolveHost } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connectionAddress, createNetworkClassifier, networkAddress, networkSubnet } from '../users/network.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { requestNetworkInfo } from './http-request.js';

const nonempty = value => value != null && clrTrim(value) !== '';
const familyEnabled = (address, configuration) => isIP(address) === 4 ? configuration.EnableIPv4 : configuration.EnableIPv6;
const loopback = address => networkSubnet('127.0.0.0/8').contains(address) || networkSubnet('::1').contains(address);
const linkLocal = address => networkSubnet('169.254.0.0/16').contains(address) || networkSubnet('fe80::/10').contains(address);
const formatAddress = address => isIP(address) === 6 ? '[' + address + ']' : address;
const byIndex = (a, b) => a.index - b.index;
const trimSlashes = value => value.replace(/^\/+|\/+$/gu, '');
const splitHeader = value => value == null ? [] : String(value).split(',').map(value => value.trim());

function systemInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, values], index) => (values ?? []).map(value => ({
    address: value.address, prefixLength: Number(value.cidr?.split('/')[1] ?? (value.family === 'IPv4' ? 32 : 128)),
    name, index,
  })));
}

function endpointAddress(value) {
  const direct = connectionAddress(value);
  if (direct) return direct;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/u.exec(value);
  if (bracket) return connectionAddress(bracket[1]);
  const ipv4 = /^([^:]+):\d+$/u.exec(value);
  return ipv4 ? connectionAddress(ipv4[1]) : null;
}

function hostAndPort(value) {
  if (value.includes('://')) return { address: value, port: null };
  try {
    const parsed = new URL('any://' + value);
    if (parsed.port) return { address: parsed.hostname.replace(/^\[|\]$/gu, ''), port: Number(parsed.port) };
  } catch { /* A host without an explicit port remains the original value. */ }
  return { address: value, port: null };
}

// NetworkManager's observable LAN, remote access and advertised-address rules.
// Listener binding remains owned by the HTTP server, rather than this service.
export class NetworkService {
  #classifier;
  #remote = [];
  #interfaces = [];
  #published = [];
  #proxy = [];
  #forwarded = false;
  #initialization;
  #closed = false;
  #updated;

  constructor({ getNetworkConfiguration, namedConfiguration, getInterfaces = systemInterfaces,
    lookup = resolveHost, getApplicationHost = () => null, publishedUrl, logger = {} } = {}) {
    if (typeof getNetworkConfiguration !== 'function' || typeof getInterfaces !== 'function'
      || typeof lookup !== 'function' || typeof getApplicationHost !== 'function') throw new TypeError('Network services require current configuration, interfaces, DNS and application host functions.');
    Object.assign(this, { getNetworkConfiguration, namedConfiguration, getInterfaces, lookup, getApplicationHost, publishedUrl, logger });
    this.#updated = ({ key, configuration }) => { if (key === 'network') this.updateSettings(configuration); };
  }

  initialize() {
    if (this.#closed) return Promise.reject(Object.assign(new Error('Network services are closing.'), { code: 'closed', status: 503 }));
    return this.#initialization ??= (async () => {
      const configuration = this.getNetworkConfiguration();
      this.updateSettings(configuration);
      this.namedConfiguration?.on('updated', this.#updated);
      // ForwardedHeadersOptions is constructed from the startup configuration.
      // Replacing a named current does not rebuild this request middleware.
      if (configuration.KnownProxies.length) {
        this.#forwarded = true;
        const trusted = [networkSubnet('127.0.0.0/8'), networkSubnet('::1')];
        for (const proxy of configuration.KnownProxies) {
          const address = networkAddress(proxy);
          const subnet = address ? networkSubnet(address + '/' + (isIP(address) === 4 ? 32 : 128)) : networkSubnet(proxy);
          if (subnet) {
            if (familyEnabled(subnet.address, configuration)) trusted.push(subnet);
            continue;
          }
          if (!nonempty(proxy)) continue;
          let addresses;
          try { addresses = await this.lookup(hostAndPort(clrTrim(proxy)).address, { all: true }); }
          catch (error) { if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA'].includes(error.code)) continue; throw error; }
          for (const { address } of addresses) if (familyEnabled(address, configuration)) trusted.push(networkSubnet(address));
        }
        this.#proxy = trusted.filter(Boolean);
      }
    })();
  }

  updateSettings(configuration) {
    const current = this.getNetworkConfiguration();
    this.#classifier = createNetworkClassifier({ ...configuration, EnableIPv4: current.EnableIPv4, EnableIPv6: current.EnableIPv6 });
    const remote = configuration.RemoteIPFilter;
    // Native keeps the old filter when the new first entry is absent/blank.
    if (remote.length && nonempty(remote[0])) {
      const filtered = remote.filter(value => value.includes('/')).map(networkSubnet).filter(Boolean);
      for (const value of remote.filter(value => !value.includes('/'))) {
        const address = networkAddress(value);
        if (address) filtered.push(networkSubnet(address + '/' + (isIP(address) === 4 ? 32 : 128)));
      }
      this.#remote = filtered;
    }
    let interfaces = this.getInterfaces().map(value => ({ ...value, address: networkAddress(value.address),
      subnet: networkSubnet(value.address + '/' + value.prefixLength) })).filter(value => value.address && value.subnet && familyEnabled(value.address, current));
    if (!interfaces.length) {
      if (current.EnableIPv4) interfaces.push({ address: '127.0.0.1', name: 'lo', index: 0, subnet: networkSubnet('127.0.0.0/8') });
      if (current.EnableIPv6) interfaces.push({ address: '::1', name: 'lo', index: 0, subnet: networkSubnet('::1') });
    }
    this.#interfaces = interfaces;
    const bind = configuration.LocalNetworkAddresses;
    if (bind.length && nonempty(bind[0])) {
      const addresses = new Set(bind.map(value => networkSubnet(value)?.address
        ?? interfaces.find(item => ordinalIgnoreCaseEquals(item.name, value))?.address).filter(Boolean));
      interfaces = interfaces.filter(item => addresses.has(item.address));
      for (const address of ['127.0.0.1', '::1']) if (addresses.has(address) && !interfaces.some(value => value.address === address)) {
        interfaces.push({ address, name: 'lo', index: 0, subnet: networkSubnet(address === '::1' ? address : '127.0.0.0/8') });
      }
    }
    if (configuration.IgnoreVirtualInterfaces) {
      for (const raw of configuration.VirtualInterfaceNames) {
        const prefix = raw.replaceAll('*', '');
        for (let index = interfaces.length - 1; index >= 0; index -= 1) {
          if (ordinalIgnoreCaseEquals(interfaces[index].name.slice(0, prefix.length), prefix)) interfaces.splice(index, 1);
        }
      }
    }
    this.#interfaces = interfaces.filter((value, index, values) => familyEnabled(value.address, current)
      && values.findIndex(item => item.address === value.address) === index);
    this.#initializeOverrides(configuration);
  }

  #initializeOverrides(configuration) {
    const published = [], add = (subnet, replacement, internal = true, external = true) => published.push({ subnet, replacement, internal, external });
    if (this.publishedUrl != null && this.publishedUrl !== '') {
      add(networkSubnet('0.0.0.0/0'), this.publishedUrl); add(networkSubnet('::/0'), this.publishedUrl);
      this.#published = published; return;
    }
    for (const entry of configuration.PublishedServerUriBySubnet) {
      const parts = entry.split('=');
      if (parts.length !== 2) { this.logger.error?.(new Error('Unable to parse bind override: ' + entry)); return; }
      const [identifier, raw] = parts, replacement = clrTrim(raw);
      if (ordinalIgnoreCaseEquals(identifier, 'all')) {
        published.length = 0;
        add(networkSubnet('0.0.0.0/0'), replacement); add(networkSubnet('::/0'), replacement); break;
      }
      if (ordinalIgnoreCaseEquals(identifier, 'external')) {
        add(networkSubnet('0.0.0.0/0'), replacement, false); add(networkSubnet('::/0'), replacement, false); continue;
      }
      if (ordinalIgnoreCaseEquals(identifier, 'internal')) {
        const current = this.getNetworkConfiguration(), subnets = configuration.LocalNetworkSubnets ?? [];
        let networks = subnets.filter(value => !clrTrim(value ?? '').startsWith('!')).map(networkSubnet).filter(Boolean);
        if (!networks.length) networks = [...(current.EnableIPv4 ? ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] : []),
          ...(current.EnableIPv6 ? ['::1', 'fe80::/10', 'fc00::/7'] : [])].map(networkSubnet);
        for (const subnet of networks) add(subnet, replacement, true, false);
        continue;
      }
      const subnet = networkSubnet(identifier);
      if (subnet) add(subnet, replacement);
      else {
        const current = this.getNetworkConfiguration();
        const matches = this.#interfaces.filter(value => ordinalIgnoreCaseEquals(value.name, identifier) && familyEnabled(value.address, current)).sort(byIndex);
        if (!matches.length) this.logger.error?.(new Error('Unable to parse bind override: ' + entry));
        for (const value of matches) add(value.subnet, replacement);
      }
    }
    this.#published = published;
  }

  isInLocalNetwork(address) { return this.#classifier(address); }

  getAllBindInterfaces(individualInterfaces = false) {
    const current = this.getNetworkConfiguration(), explicit = current.LocalNetworkAddresses;
    if (individualInterfaces || explicit.length && nonempty(explicit[0]) && this.#interfaces.length) return this.#interfaces.map(value => value.address);
    if (current.EnableIPv4 && current.EnableIPv6) return ['::'];
    if (current.EnableIPv4) return ['0.0.0.0'];
    return current.EnableIPv6 ? this.#interfaces.filter(value => isIP(value.address) === 6).map(value => value.address) : [];
  }

  shouldAllowServerAccess(address) {
    if (!networkAddress(address)) throw new TypeError('A valid remote IP address is required.');
    const current = this.getNetworkConfiguration();
    if (this.isInLocalNetwork(address)) return true;
    if (!current.EnableRemoteAccess) return false;
    if (!this.#remote.length) return true;
    const matches = this.#remote.some(value => value.contains(address));
    return current.IsRemoteIPFilterBlacklist ? !matches : matches;
  }

  getBindAddress(input, { skipOverrides = false } = {}) {
    const source = input == null ? null : networkAddress(input), external = source != null && !this.isInLocalNetwork(source);
    if (source && !skipOverrides) {
      const published = this.#publishedAddress(source, external);
      if (published) return published;
    }
    const usable = this.#interfaces.length === 1 && ['0.0.0.0', '::'].includes(this.#interfaces[0].address) ? [] : this.#interfaces;
    if (source) {
      const matches = usable.filter(value => external ? !this.isInLocalNetwork(value.address) && !linkLocal(value.address) : this.isInLocalNetwork(value.address))
        .sort((a, b) => Number(b.subnet.contains(source)) - Number(a.subnet.contains(source)) || b.subnet.prefixLength - a.subnet.prefixLength || byIndex(a, b));
      if (matches.length) return { address: formatAddress(matches[0].address), port: null };
    }
    const available = this.#interfaces.filter(value => !loopback(value.address))
      .sort((a, b) => Number(this.isInLocalNetwork(b.address)) - Number(this.isInLocalNetwork(a.address)) || byIndex(a, b));
    if (!available.length) {
      const current = this.getNetworkConfiguration();
      return { address: source && isIP(source) === 6 && current.EnableIPv6 ? '::1' : current.EnableIPv4 ? '127.0.0.1' : '::1', port: null };
    }
    const match = source && (available.find(value => value.subnet.contains(source)) ?? available.find(value => isIP(value.address) === isIP(source)));
    return { address: formatAddress((match || available[0]).address), port: null };
  }

  #publishedAddress(source, external = !this.isInLocalNetwork(source)) {
    const matches = this.#published.filter(value => (external ? value.external : value.internal) && value.subnet.contains(source))
      .sort((a, b) => b.subnet.prefixLength - a.subnet.prefixLength);
    for (const value of matches) if (['0.0.0.0', '::'].includes(value.subnet.address)
      || this.#interfaces.some(item => value.subnet.contains(item.address))) return value.replacement ? hostAndPort(value.replacement) : null;
    return null;
  }

  getPublishedApiUrl(address) {
    if (this.publishedUrl != null && this.publishedUrl !== '') return trimSlashes(this.publishedUrl);
    const source = networkAddress(address), published = source && this.#publishedAddress(source);
    return published ? this.getLocalApiUrl(published.address, { port: published.port }) : null;
  }

  getRequestInfo(request) {
    const info = requestNetworkInfo(request);
    if (!this.#forwarded) return info;
    const addresses = splitHeader(request.headers['x-forwarded-for']), schemes = splitHeader(request.headers['x-forwarded-proto']), hosts = splitHeader(request.headers['x-forwarded-host']);
    const length = Math.max(addresses.length, schemes.length, hosts.length);
    for (let index = 0; index < length; index += 1) {
      if (!this.#proxy.some(value => value.contains(info.remoteEndPoint))) break;
      const original = addresses.at(-1 - index), scheme = schemes.at(-1 - index), host = hosts.at(-1 - index);
      const address = original ? endpointAddress(original) : null;
      if (original && !address) break;
      if (scheme && !/^[A-Za-z][A-Za-z0-9+.-]*$/u.test(scheme)) break;
      if (host && /[\s/\\?#@]/u.test(host)) break;
      if (address) { info.remoteEndPoint = networkAddress(address); info.isLocal = info.localAddress === address; }
      if (scheme) info.scheme = scheme;
      if (host) info.host = host;
    }
    return info;
  }

  getLocalApiUrl(host, { scheme, port } = {}) {
    if (/^https?:\/\//iu.test(host)) return host.replace(/\/+$/gu, '');
    const applicationHost = this.getApplicationHost();
    scheme ??= applicationHost?.listenWithHttps ? 'https' : 'http';
    const address = host.replace(/^\[|\]$/gu, ''), url = new URL(scheme + '://' + formatAddress(address));
    const value = port ?? (scheme === 'https' ? applicationHost?.httpsPort : applicationHost?.httpPort);
    if (value != null && value !== -1) url.port = String(value);
    url.pathname = this.getNetworkConfiguration().BaseUrl || '/';
    return url.href.replace(/\/+$/gu, '');
  }

  getSmartApiUrl(request, info = this.getRequestInfo(request)) {
    if (this.getNetworkConfiguration().EnablePublishedServerUriByRequest) {
      const host = new URL(info.scheme + '://' + info.host);
      return this.getLocalApiUrl(host.hostname, { scheme: info.scheme, port: host.port ? Number(host.port) : -1 });
    }
    return this.getApiUrlForAddress(info.remoteEndPoint);
  }

  getApiUrlForAddress(address) {
    const published = this.getPublishedApiUrl(address);
    if (published) return published;
    const bind = this.getBindAddress(address);
    return this.getLocalApiUrl(trimSlashes(bind.address), { port: bind.port });
  }

  close() {
    this.#closed = true;
    this.namedConfiguration?.off('updated', this.#updated);
    return Promise.resolve(this.#initialization).then(() => {}, () => {});
  }
}
