import test from 'node:test';
import assert from 'node:assert/strict';
import { readAuthorization, parseAuthorizationParts } from '../../src/core/authorization.js';

test('authorization dictionary preserves source key casing, commas and URL decoding', () => {
  assert.deepEqual({ ...parseAuthorizationParts('Client="A,B", Token="a%2Bb+c", token="lower"') },
    { Client: 'A,B', Token: 'a+b c', token: 'lower' });
});

test('local baseline ApiKey works with legacy authorization disabled', () => {
  const request = { headers: { 'X-Emby-Token': 'header' }, url: '/?api_key=legacy&ApiKey=current' };
  assert.equal(readAuthorization(request).Token, 'current');
  assert.equal(readAuthorization(request, {enableLegacyAuthorization: true}).Token, 'header');
});

test('authorization token precedes legacy query then headers then ApiKey', () => {
  const request = { headers: { Authorization: 'MediaBrowser Client="test", Token="first"', 'X-Emby-Token': 'third' },
    url: '/?X-Emby-Token=second&ApiKey=fourth' };
  assert.equal(readAuthorization(request, {enableLegacyAuthorization: true}).Token, 'first');
  delete request.headers.Authorization;
  assert.equal(readAuthorization(request, {enableLegacyAuthorization: true}).Token, 'second');
  assert.equal(readAuthorization(request).Token, 'fourth');
});

test('unknown authentication schemes and lowercase Token are not accepted', () => {
  assert.equal(readAuthorization({headers:{Authorization:'Bearer secret'},url:'/'}).IsAuthenticated, false);
  assert.equal(readAuthorization({headers:{Authorization:'MediaBrowser token="secret"'},url:'/'}).Token, '');
});
