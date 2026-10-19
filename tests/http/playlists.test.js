import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../src/http/application.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';

const ids = {
  owner: '81000000000000000000000000000001',
  other: '81000000000000000000000000000002',
  playlist: '82000000000000000000000000000001',
  first: '83000000000000000000000000000001',
  second: '83000000000000000000000000000002'
};
const owner = { Id: nativeGuid(ids.owner), Policy: { IsAdministrator: false } };
const other = { Id: nativeGuid(ids.other), Policy: { IsAdministrator: false } };

async function fixture({ playlists, auth = {}, onError = () => {} } = {}) {
  const authenticated = { IsAuthenticated: true, IsAdministrator: false, IsApiKey: false,
    UserId: ids.owner, User: owner, ...auth };
  const application = await createApplication({
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    authentication: {
      async authenticate() { return authenticated; },
      authorize(value) { if (!value.IsAuthenticated) throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
    },
    users: { async getUser(id) { return id === ids.owner ? owner : id === ids.other ? other : null; } },
    library: { async getDeletionItem(id) { return { item: { Id: id, Type: 'Playlist' }, canDelete: true }; } },
    playlists,
    onError
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  return {
    async request(route, { method = 'GET', body } = {}) {
      const response = await fetch(origin + route, { method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* Native error responses can be plain text. */ }
      return { status: response.status, data };
    },
    close: () => new Promise(resolve => application.server.close(resolve))
  };
}

test('playlist HTTP contract binds body-only creation and every managed playlist operation', async () => {
  const calls = [];
  const playlists = {
    async create(input) { calls.push(['create', input]); return { Id: ids.playlist }; },
    async get(id, options) { calls.push(['get', id, options]); return { Shares: [], OpenAccess: true, ItemIds: [ids.first] }; },
    async update(id, options) { calls.push(['update', id, options]); },
    async getUsers(id, options) { calls.push(['users', id, options]); return [{ UserId: ids.other, CanEdit: true }]; },
    async getUser(id, userId, options) { calls.push(['user', id, userId, options]); return { UserId: userId, CanEdit: true }; },
    async updateUser(id, userId, options) { calls.push(['update-user', id, userId, options]); },
    async removeUser(id, userId, options) { calls.push(['remove-user', id, userId, options]); },
    async add(id, itemIds, options) { calls.push(['add', id, itemIds, options]); },
    async remove(id, entryIds, options) { calls.push(['remove', id, entryIds, options]); },
    async move(id, entryId, newIndex, options) { calls.push(['move', id, entryId, newIndex, options]); },
    async getItems(id, options) { calls.push(['items', id, options]); return { Items: [], TotalRecordCount: 0, StartIndex: 1 }; },
    async delete(id, options) { calls.push(['delete', id, options]); }
  };
  const application = await fixture({ playlists });
  try {
    const created = await application.request('/Playlists?name=ignored&ids=ffffffffffffffffffffffffffffffff', {
      method: 'POST', body: { nAmE: 'Body Name', iDs: [ids.first, ids.second], mEdIaTyPe: 'Video' }
    });
    assert.deepEqual(created, { status: 200, data: { Id: ids.playlist } });
    assert.deepEqual(calls.shift(), ['create', { name: 'Body Name', ids: [ids.first, ids.second],
      user: owner, mediaType: 'Video', users: [], isPublic: true }]);

    assert.deepEqual(await application.request(`/Playlists/${ids.playlist}`), {
      status: 200, data: { Shares: [], OpenAccess: true, ItemIds: [ids.first] }
    });
    assert.deepEqual(calls.shift(), ['get', ids.playlist, { user: owner }]);

    assert.equal((await application.request(`/Playlists/${ids.playlist}`, { method: 'POST', body: {
      nAmE: 'Renamed', iDs: [ids.first, ids.first], uSeRs: [{ uSeRiD: ids.other, cAnEdIt: true }], iSpUbLiC: false
    } })).status, 204);
    assert.deepEqual(calls.shift(), ['update', ids.playlist, { user: owner, name: 'Renamed', ids: [ids.first, ids.first],
      users: [{ UserId: ids.other, CanEdit: true }], isPublic: false }]);
    assert.equal((await application.request(`/Playlists/${ids.playlist}`, { method: 'POST',
      body: { Name: null, Ids: null, Users: null, IsPublic: null } })).status, 204);
    assert.deepEqual(calls.shift(), ['update', ids.playlist,
      { user: owner, name: null, ids: null, users: null, isPublic: null }]);

    assert.deepEqual(await application.request(`/Playlists/${ids.playlist}/Users`), {
      status: 200, data: [{ UserId: ids.other, CanEdit: true }]
    });
    assert.deepEqual(calls.shift(), ['users', ids.playlist, { user: owner }]);
    assert.deepEqual(await application.request(`/Playlists/${ids.playlist}/Users/${ids.other}`), {
      status: 200, data: { UserId: ids.other, CanEdit: true }
    });
    assert.deepEqual(calls.shift(), ['user', ids.playlist, ids.other, { user: owner }]);
    assert.equal((await application.request(`/Playlists/${ids.playlist}/Users/${ids.other}`, {
      method: 'POST', body: { CanEdit: null }
    })).status, 204);
    assert.deepEqual(calls.shift(), ['update-user', ids.playlist, ids.other, { user: owner, canEdit: null }]);
    assert.equal((await application.request(`/Playlists/${ids.playlist}/Users/${ids.other}`, {
      method: 'DELETE'
    })).status, 204);
    assert.deepEqual(calls.shift(), ['remove-user', ids.playlist, ids.other, { user: owner }]);

    assert.equal((await application.request(`/Playlists/${ids.playlist}/Items?ids=${ids.first},${ids.second}&position=1`,
      { method: 'POST' })).status, 204);
    assert.deepEqual(calls.shift(), ['add', ids.playlist, [ids.first, ids.second], { user: owner, position: 1 }]);

    const upperEntry = ids.first.toUpperCase();
    assert.equal((await application.request(`/Playlists/${ids.playlist}/Items?entryIds=${upperEntry}`, {
      method: 'DELETE'
    })).status, 204);
    assert.deepEqual(calls.shift(), ['remove', ids.playlist, [upperEntry], { user: owner, isApiKey: false }]);

    assert.equal((await application.request(`/Playlists/${ids.playlist}/Items/${upperEntry}/Move/0`, {
      method: 'POST'
    })).status, 204);
    assert.deepEqual(calls.shift(), ['move', ids.playlist, upperEntry, 0, { user: owner }]);

    const items = await application.request(`/Playlists/${ids.playlist}/Items?startIndex=1&limit=2&fields=Path&enableImages=false`);
    assert.deepEqual(items, { status: 200, data: { Items: [], TotalRecordCount: 0, StartIndex: 1 } });
    assert.deepEqual(calls.shift(), ['items', ids.playlist, { user: owner, startIndex: 1, limit: 2,
      dtoOptions: { fields: 'Path', enableImages: 'false' } }]);

    assert.equal((await application.request(`/Items/${ids.playlist}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(calls.shift(), ['delete', ids.playlist, { user: owner, isApiKey: false }]);
    assert.deepEqual(calls, []);
  } finally { await application.close(); }
});

test('playlist update binding preserves nullable members and rejects invalid DTO shapes', async () => {
  const calls = [];
  const playlists = {
    async update(id, options) { calls.push(['update', id, options]); },
    async updateUser(id, userId, options) { calls.push(['update-user', id, userId, options]); }
  };
  const application = await fixture({ playlists });
  try {
    for (const body of [{ Name: 1 }, { Ids: 1 }, { Users: {} }, { IsPublic: 'true' }]) {
      assert.equal((await application.request(`/Playlists/${ids.playlist}`, { method: 'POST', body })).status, 400);
    }
    assert.equal((await application.request(`/Playlists/${ids.playlist}`, { method: 'POST', body: {
      Ids: `not-a-guid,,${ids.second}`, Users: [{ UserId: null }]
    } })).status, 204);
    assert.deepEqual(calls.shift(), ['update', ids.playlist, { user: owner, name: undefined, ids: [ids.second],
      users: [{ UserId: '00000000000000000000000000000000', CanEdit: false }], isPublic: undefined }]);

    assert.equal((await application.request(`/Playlists/${ids.playlist}/Users/${ids.other}`, {
      method: 'POST', body: { CanEdit: 'true' }
    })).status, 400);
    assert.equal((await application.request(`/Playlists/${ids.playlist}/Users/${ids.other}`, {
      method: 'POST', body: {}
    })).status, 204);
    assert.deepEqual(calls.shift(), ['update-user', ids.playlist, ids.other, { user: owner, canEdit: undefined }]);
    assert.deepEqual(calls, []);
  } finally { await application.close(); }
});

test('playlist HTTP contract rejects missing body, identity escalation and unavailable persistence', async () => {
  const calls = [];
  const service = { async create(input) { calls.push(input); return { Id: ids.playlist }; } };
  const application = await fixture({ playlists: service });
  try {
    assert.equal((await application.request('/Playlists', { method: 'POST', body: {} })).status, 400);
    assert.equal((await application.request('/Playlists', { method: 'POST', body: { Name: 'Escalate', UserId: ids.other } })).status, 403);
    assert.deepEqual(calls, []);
  } finally { await application.close(); }

  const administrator = await fixture({ playlists: service,
    auth: { IsAdministrator: true, User: { ...owner, Policy: { IsAdministrator: true } } } });
  try {
    assert.equal((await administrator.request('/Playlists', { method: 'POST',
      body: { Name: 'Owned by another user', UserId: ids.other, IsPublic: false } })).status, 200);
    assert.equal(wireGuid(calls.at(-1).user.Id), ids.other);
  } finally { await administrator.close(); }

  const unavailable = await fixture();
  try {
    assert.equal((await unavailable.request(`/Playlists/${ids.playlist}`)).status, 501);
    assert.equal((await unavailable.request('/Playlists', { method: 'POST', body: { Name: 'Unavailable' } })).status, 501);
  } finally { await unavailable.close(); }
});

test('playlist API-key mutations retain the native no-user authorization branch', async () => {
  const calls = [];
  const playlists = {
    async remove(id, entryIds, options) { calls.push(['remove', id, entryIds, options]); },
    async delete(id, options) { calls.push(['delete', id, options]); }
  };
  const application = await fixture({ playlists,
    auth: { IsApiKey: true, IsAdministrator: true, UserId: '00000000000000000000000000000000', User: null } });
  try {
    assert.equal((await application.request(`/Playlists/${ids.playlist}/Items?entryIds=${ids.first}`, {
      method: 'DELETE'
    })).status, 204);
    assert.equal((await application.request(`/Items/${ids.playlist}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(calls, [
      ['remove', ids.playlist, [ids.first], { user: null, isApiKey: true }],
      ['delete', ids.playlist, { user: null, isApiKey: true }]
    ]);
  } finally { await application.close(); }
});
