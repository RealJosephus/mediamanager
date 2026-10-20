import { setTimeout as delay } from 'node:timers/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function captureSearchOrder({ call, items, report }) {
  const name = 'Controlled tie reader';
  const created = await call('create-tie-reader', '/Users/New', { method: 'POST', body: { Name: name }, form: true });
  if (created.status !== 200) throw new Error('Cannot create controlled tie reader.');
  const login = await call('login-tie-reader', '/Users/AuthenticateByName', {
    method: 'POST', deviceId: 'search-tie-reader', body: { Username: name, Pw: '' },
  });
  if (login.status !== 200) throw new Error('Cannot authenticate controlled tie reader.');
  const token = login.bodyJson.AccessToken, user = `/Users/${created.bodyJson.Id}`;
  const byName = new Map(items.map(item => [item.Name, item.Id]));
  const a = byName.get('Controlled audio A'), b = byName.get('Controlled audio B'), c = byName.get('Controlled audio C');
  report.identities.tieReader = created.bodyJson.Id;
  report.identities.itemNames = Object.fromEntries(items.map(item => [item.Id, item.Name]));
  for (const id of [c, a, b]) await call('create-userdata-' + id, user + '/FavoriteItems/' + id, { token, method: 'POST' });
  await call('mark-tied-items', user + '/SearchedItems', { token, method: 'POST', body: { Ids: [c, b, a] } });
  const recent = user + '/Items?Recursive=true&WasSearched=true&SortBy=DateLastSearched&SortOrder=Descending';
  for (const [label, query] of [['tie-descending', recent], ['tie-ascending', recent.replace('Descending', 'Ascending')],
    ['tie-count-off', recent + '&EnableTotalRecordCount=false&StartIndex=1&Limit=1'],
    ['ordinary-count-off', user + '/Items?Recursive=true&IncludeItemTypes=Audio&SortBy=SortName&StartIndex=1&Limit=1&EnableTotalRecordCount=false']]) {
    await call(label, query, { token });
  }
  await delay(1250);
  await call('mark-already-searched', user + '/SearchedItems', { token, method: 'POST', body: { Ids: [c] } });
  await call('tie-after-repeat', recent, { token });
  await call('clear-before-spaced-marks', user + '/RecentlySearched/Delete', { token, method: 'POST' });
  for (const id of [a, b, c]) {
    await delay(1200);
    await call('mark-spaced-' + id, user + '/SearchedItems', { token, method: 'POST', body: { Ids: [id] } });
  }
  for (const sort of ['Ascending', 'Descending']) for (const count of [true, false]) for (const limited of [true, false]) {
    const query = recent.replace('Descending', sort) + `&EnableTotalRecordCount=${count}` + (limited ? '&Limit=2&StartIndex=1' : '');
    await call(`spaced-${sort}-count-${count}-limited-${limited}`, query, { token });
  }
}

export async function captureSearchHistory({ call, reader, other, token, otherToken, items, report, restart, instance }) {
  const ids = items.map(item => item.Id), user = `/Users/${reader.Id}`, target = `/Users/${other.Id}`;
  report.identities.items = ids;
  report.identities.itemNames = Object.fromEntries(items.map(item => [item.Id, item.Name]));
  const storage = async label => {
    const snapshot = { label, tables: [], failures: [] };
    for (const name of await readdir(path.join(instance, 'data'))) {
      if (!name.endsWith('.db')) continue;
      let database;
      try {
        database = new DatabaseSync(path.join(instance, 'data', name), { readOnly: true });
        for (const { name: table } of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
          const quoted = '"' + table.replaceAll('"', '""') + '"';
          const columns = database.prepare(`PRAGMA table_info(${quoted})`).all();
          if (!columns.some(column => /searched/iu.test(column.name))) continue;
          const statement = database.prepare(`SELECT * FROM ${quoted}`); statement.setReadBigInts(true);
          const rows = statement.all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
            [key, typeof value === 'bigint' ? { integer: String(value) } : value])));
          snapshot.tables.push({ database: name, table, columns, rows });
        }
      } catch (error) { snapshot.failures.push({ database: name, message: error.message }); }
      finally { database?.close(); }
    }
    (report.searchStorage ??= []).push(snapshot);
  };
  const recent = (owner = user, extra = '') => owner + '/Items?Recursive=true&WasSearched=true&SortBy=DateLastSearched&SortOrder=Descending&Limit=10' + extra;
  const mark = (label, list, options = {}) => call(label, user + '/SearchedItems', {
    token, method: 'POST', body: { Ids: list, WasSearched: true }, ...options,
  });
  await call('clear-source-initial', user + '/RecentlySearched/Delete', { token, method: 'POST' });
  await call('clear-target-initial', target + '/RecentlySearched/Delete', { token: otherToken, method: 'POST' });
  await call('initial-history', recent(), { token });
  await call('favorite-before-history', user + '/FavoriteItems/' + ids[0], { token, method: 'POST' });
  await call('played-before-history', user + '/PlayedItems/' + ids[0], { token, method: 'POST' });
  await call('source-item-before-mark', user + '/Items/' + ids[0], { token });
  await mark('mark-first', [ids[0]]);
  await call('after-first', recent(), { token });
  await delay(25);
  await mark('mark-second', [ids[1]]);
  await call('after-second', recent(), { token });
  await storage('after-second');
  await call('history-ascending', recent().replace('Descending', 'Ascending'), { token });
  await call('history-page', recent().replace('Limit=10', 'Limit=1') + '&StartIndex=1', { token });
  await call('history-page-without-count', recent().replace('Limit=10', 'Limit=1') + '&StartIndex=1&EnableTotalRecordCount=false', { token });
  await call('history-negative-filter', recent().replace('WasSearched=true', 'WasSearched=false'), { token });
  await call('history-default-order', user + '/Items?Recursive=true&WasSearched=true', { token });
  await call('history-field', recent(user, '&Fields=DateLastSearched'), { token });
  await call('history-unknown-bool', recent().replace('WasSearched=true', 'WasSearched=invalid'), { token });
  await delay(1250);
  await mark('mark-false', [ids[0]], { body: { Ids: [ids[0]], WasSearched: false } });
  await call('after-false', recent(), { token });
  await storage('after-false');
  await delay(1250);
  await mark('mark-invalid-flag', [ids[1]], { body: { Ids: [ids[1]], WasSearched: 'invalid' } });
  await call('after-invalid-flag', recent(), { token });
  await storage('after-invalid-flag');
  await mark('mark-empty-list', []);
  await mark('mark-null-list', [], { body: { Ids: null } });
  await mark('mark-missing-id', ['999999999999']);
  await mark('mark-invalid-id', ['invalid']);
  await mark('mark-mixed-ids', [ids[2], '999999999999', ids[0]]);
  await call('after-mixed-ids', recent(), { token });
  await call('mark-other-user', target + '/SearchedItems', { token, method: 'POST', body: { Ids: [ids[2]], WasSearched: true } });
  await call('other-history-after-cross-write', recent(target));
  await call('other-history-as-reader', recent(target), { token });
  await call('anonymous-mark', user + '/SearchedItems', { token: null, method: 'POST', body: { Ids: [ids[0]] } });
  await call('anonymous-clear', user + '/RecentlySearched/Delete', { token: null, method: 'POST' });
  await call('mark-other-as-owner', target + '/SearchedItems', { token: otherToken, method: 'POST', body: { Ids: [ids[2]] } });
  await call('copy-search-history', user + '/CopyData', { method: 'POST', body: { ToUserIds: [other.Id], CopyOptions: ['userdata'] } });
  await call('other-history-after-copy', recent(target), { token: otherToken });
  await storage('after-copy');
  await call('restrict-source-folders', user + '/Policy', { method: 'POST', body: { ...reader.Policy, EnableAllFolders: false, EnabledFolders: [] } });
  await call('history-without-library-access', recent(), { token });
  await mark('mark-without-library-access', [ids[1]]);
  await call('restore-source-folders', user + '/Policy', { method: 'POST', body: reader.Policy });
  await call('history-after-access-restored', recent(), { token });
  await call('history-before-restart', recent(), { token });
  await delay(800);
  await restart();
  await call('history-after-restart', recent(), { token });
  await call('clear-source', user + '/RecentlySearched/Delete', { token, method: 'POST' });
  await call('history-after-clear', recent(), { token });
  await storage('after-clear');
  await call('source-item-after-clear', user + '/Items/' + ids[0], { token });
  await call('other-history-after-source-clear', recent(target), { token: otherToken });
  await call('clear-other-as-reader', target + '/RecentlySearched/Delete', { token, method: 'POST' });
  await call('other-history-after-cross-clear', recent(target));
  await delay(800);
}
