import { BlockList, isIP } from 'node:net';

function address(value) {
  let text = String(value).trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  text = text.replace(/%[^:]+$/, '');
  if (isIP(text)) return text;
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

function subnet(rule) {
  const input = rule.trim();
  const slash = input.indexOf('/');
  const value = address(slash < 0 ? input : input.slice(0, slash));
  if (!value) return null;
  const family = isIP(value) === 4 ? 'ipv4' : 'ipv6';
  const maximum = family === 'ipv4' ? 32 : 128;
  const bits = slash < 0 ? value === '0.0.0.0' || value === '::' ? 0 : maximum : Number(input.slice(slash + 1));
  if (slash >= 0 && !/^\d+$/.test(input.slice(slash + 1)) || !Number.isInteger(bits) || bits < 0 || bits > maximum) return null;
  const list = new BlockList();
  try { list.addSubnet(value, bits, family); } catch { return null; }
  return list;
}

export function createNetworkClassifier({ EnableIPv4 = true, EnableIPv6 = false, LocalNetworkSubnets = [] } = {}) {
  if (!Array.isArray(LocalNetworkSubnets)) throw new TypeError('LocalNetworkSubnets must be an array.');
  let allowed = LocalNetworkSubnets.filter(value => !value.trim().startsWith('!')).map(subnet).filter(Boolean);
  const excluded = LocalNetworkSubnets.filter(value => value.trim().startsWith('!')).map(value => subnet(value.trim().slice(1))).filter(Boolean);
  if (!allowed.length) allowed = [...(EnableIPv4 ? ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] : []),
    ...(EnableIPv6 ? ['::1/128', 'fe80::/10', 'fc00::/7'] : [])].map(subnet);
  const loopback = [subnet('127.0.0.0/8'), subnet('::1/128')];
  return remoteAddress => {
    const value = address(remoteAddress ?? '');
    if (!value) return false;
    const family = isIP(value) === 4 ? 'ipv4' : 'ipv6';
    if (loopback.some(network => network.check(value, family))) return true;
    return allowed.some(network => network.check(value, family)) && !excluded.some(network => network.check(value, family));
  };
}

export const isDefaultLocalNetwork = createNetworkClassifier();
