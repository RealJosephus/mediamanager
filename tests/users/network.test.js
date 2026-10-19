import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkClassifier } from '../../src/users/network.js';

test('native default LAN ranges, IPv4-mapped addresses and IPv6 configuration remain distinct', () => {
  const local = createNetworkClassifier();
  for (const value of ['127.0.0.2', '::1', '10.20.30.40', '172.16.0.1', '172.31.255.254', '192.168.3.4', '::ffff:10.1.2.3', '::ffff:a00:1']) assert.equal(local(value), true, value);
  for (const value of ['172.32.0.1', '169.254.1.2', '8.8.8.8', 'fc00::1', 'fe80::1', 'invalid']) assert.equal(local(value), false, value);
  const ipv6 = createNetworkClassifier({ EnableIPv4: false, EnableIPv6: true });
  assert.equal(ipv6('fc00::1234'), true);
  assert.equal(ipv6('fe80::5678%2'), true);
  assert.equal(ipv6('10.1.2.3'), false);
});

test('explicit LAN ranges replace defaults; exclusions apply except to loopback', () => {
  const local = createNetworkClassifier({ LocalNetworkSubnets: ['192.0.2.0/24', '!192.0.2.128/25', '!127.0.0.0/8'] });
  assert.equal(local('192.0.2.100'), true);
  assert.equal(local('192.0.2.200'), false);
  assert.equal(local('192.168.1.1'), false);
  assert.equal(local('127.0.0.1'), true);
  const invalid = createNetworkClassifier({ LocalNetworkSubnets: ['broken', '!10.0.0.0/8'] });
  assert.equal(invalid('10.0.0.1'), false);
  assert.equal(invalid('192.168.0.1'), true);
  assert.equal(createNetworkClassifier({ LocalNetworkSubnets: ['0.0.0.0'] })('203.0.113.1'), true);
});
