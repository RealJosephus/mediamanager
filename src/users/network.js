import { BlockList, isIP } from 'node:net';
import { clrTrim } from '../metadata/whitespace.js';

export function connectionAddress(value) {
  const text = clrTrim(String(value)).replace(/^\[|\]$/gu, '').replace(/%[^:]+$/, '');
  return isIP(text) === 6 ? new URL('http://[' + text + ']').hostname.slice(1, -1) : networkAddress(text);
}

export function networkAddress(value) {
  let text = clrTrim(String(value));
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  text = text.replace(/%[^:]+$/, '');
  if (isIP(text) === 4) return text;
  if (isIP(text) === 6) {
    // Kestrel normalizes mapped clients before LAN and remote-policy checks.
    const canonical = new URL('http://[' + text + ']').hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/iu.exec(canonical);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    return canonical;
  }
  const parts = text.split('.');
  if (parts.length > 4) return null;
  const values = parts.map(part => {
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) return BigInt(part);
    if (/^0[0-7]+$/.test(part)) return BigInt(`0o${part.slice(1)}`);
    if (/^(?:0|[1-9][0-9]*)$/.test(part)) return BigInt(part);
    return null;
  });
  if (values.some(value => value === null)) return null;
  const widths = [Array.from({ length: parts.length - 1 }, () => 8), [40 - parts.length * 8]].flat();
  if (values.some((value, index) => value >= 1n << BigInt(widths[index]))) return null;
  const integer = values.reduce((result, value, index) => (result << BigInt(widths[index])) + value, 0n);
  return [24n, 16n, 8n, 0n].map(shift => Number(integer >> shift & 255n)).join('.');
}

export function networkSubnet(rule) {
  if (rule == null) return null;
  const input = clrTrim(rule);
  const slash = input.indexOf('/');
  const value = networkAddress(slash < 0 ? input : input.slice(0, slash));
  if (!value) return null;
  const family = isIP(value) === 4 ? 'ipv4' : 'ipv6';
  const maximum = family === 'ipv4' ? 32 : 128;
  const bits = slash < 0 ? value === '0.0.0.0' || value === '::' ? 0 : maximum : Number(input.slice(slash + 1));
  if (slash >= 0 && !/^\d+$/.test(input.slice(slash + 1)) || !Number.isInteger(bits) || bits < 0 || bits > maximum) return null;
  const list = new BlockList();
  try { list.addSubnet(value, bits, family); } catch { return null; }
  return { address: value, prefixLength: bits, family, contains(input) {
    const value = networkAddress(input);
    return value !== null && list.check(value, isIP(value) === 4 ? 'ipv4' : 'ipv6');
  } };
}

export function createNetworkClassifier({ EnableIPv4 = true, EnableIPv6 = false, LocalNetworkSubnets = [] } = {}) {
  const subnets = LocalNetworkSubnets ?? [];
  let allowed = subnets.filter(value => !clrTrim(value ?? '').startsWith('!')).map(networkSubnet).filter(Boolean);
  const excluded = subnets.filter(value => clrTrim(value ?? '').startsWith('!')).map(value => networkSubnet(clrTrim(value).slice(1))).filter(Boolean);
  if (!allowed.length) allowed = [...(EnableIPv4 ? ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] : []),
    ...(EnableIPv6 ? ['::1/128', 'fe80::/10', 'fc00::/7'] : [])].map(networkSubnet);
  const loopback = [networkSubnet('127.0.0.0/8'), networkSubnet('::1/128')];
  return remoteAddress => {
    const value = networkAddress(remoteAddress ?? '');
    if (!value) return false;
    if (loopback.some(network => network.contains(value))) return true;
    return allowed.some(network => network.contains(value)) && !excluded.some(network => network.contains(value));
  };
}

export const isDefaultLocalNetwork = createNetworkClassifier();
