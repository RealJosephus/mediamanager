import { notFound, noContent } from './binding.js';
import { nativeGuid } from '../users/native.js';
import { bindSyncPlayBody } from './syncplay-binding.js';
import { formatUtcTicks, utcTicks } from '../syncplay/time.js';

const trim = value => value.replace(/^[\u0009-\u000d\u0085\p{Zs}\p{Zl}\p{Zp}]+|[\u0009-\u000d\u0085\p{Zs}\p{Zl}\p{Zp}]+$/gu, '');
export function registerSyncPlayRoutes(add, { sessions, syncPlay }) {
  add('GET', '/GetUtcTime', () => ({ RequestReceptionTime: formatUtcTicks(utcTicks()), ResponseTransmissionTime: formatUtcTicks(utcTicks()) }), { public: true });
  const current = context => sessions.logActivity(context.auth, { remoteEndPoint: context.remoteEndPoint });
  const body = (type, policy) => ({ policy, body: true, bodyParameter: 'requestData', bindBody: (value, source) => bindSyncPlayBody(type, value, source) });
  add('POST', '/SyncPlay/New', async context => syncPlay.create(await current(context), trim(context.body.GroupName)), body('NewGroupRequestDto', 'SyncPlayCreateGroup'));
  add('POST', '/SyncPlay/Join', async context => { await syncPlay.join(await current(context), context.body.GroupId); return noContent(); }, body('JoinGroupRequestDto', 'SyncPlayJoinGroup'));
  add('POST', '/SyncPlay/Leave', async context => { await syncPlay.leave(await current(context)); return noContent(); }, { policy: 'SyncPlayIsInGroup' });
  add('GET', '/SyncPlay/List', async context => syncPlay.list(await current(context)), { policy: 'SyncPlayJoinGroup' });
  add('GET', '/SyncPlay/{id}', async context => (await syncPlay.get(await current(context), nativeGuid(context.params.id))) ?? notFound(), {
    policy: 'SyncPlayJoinGroup', constraints: { id: value => { try { nativeGuid(value); return true; } catch { return false; } } }
  });
  for (const [path, action, dto] of [
    ['SetNewQueue', 'Play', 'Play'], ['SetPlaylistItem'], ['RemoveFromPlaylist'], ['MovePlaylistItem'], ['Queue'],
    ['Unpause', 'Unpause', null], ['Pause', 'Pause', null], ['Stop', 'Stop', null], ['Seek'], ['Buffering', 'Buffer', 'Buffer'], ['Ready'],
    ['SetIgnoreWait', 'IgnoreWait', 'IgnoreWait'], ['NextItem'], ['PreviousItem'], ['SetRepeatMode'], ['SetShuffleMode'], ['Ping']
  ]) {
    const options = dto === null ? { policy: 'SyncPlayIsInGroup' } : body(`${dto ?? path}RequestDto`, path === 'Ping' ? 'SyncPlayHasAccess' : 'SyncPlayIsInGroup');
    add('POST', `/SyncPlay/${path}`, async context => { await syncPlay.handle(await current(context), action ?? path, context.body); return noContent(); }, options);
  }
}
