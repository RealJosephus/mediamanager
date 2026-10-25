export const id = index => `cd100000000000000000${String(index).padStart(12, '0')}`;
export const userId = id(1), targetId = id(2), channelId = id(3), missingId = id(4), parentId = id(5);
export function makeInput() {
  const permission = (name, extra = {}) => ({ name, provider: 'supported', result: true, type: 'Audio', user: true, policy: 'content', reference: 'registered', ...extra });
  const deletion = (name, extra = {}) => ({ name, provider: 'supported', outcome: 'success', type: 'Audio', externalId: 'owned-external', reference: 'registered', deleteFromExternalProvider: true, controller: true, ...extra });
  return { userId, targetId, channelId, missingId, parentId, permissions: [
    permission('supported provider and global deletion permission'),
    permission('provider observes the actual unsaved cached name', { type: 'Video', warmName: 'Warm provider input' }),
    permission('provider false precedes global permission', { result: false }),
    permission('userless permission still invokes provider', { user: false }),
    permission('channel-specific folder permission', { policy: 'channel' }),
    permission('wrong folder is unauthorized after provider', { policy: 'wrong-folder' }),
    permission('administrator alone does not authorize external media', { policy: 'admin' }),
    permission('BoxSet retains its own user authorization after provider success', { type: 'BoxSet' }),
    permission('BoxSet administrator permission follows provider success', { type: 'BoxSet', policy: 'admin' }),
    permission('no support marker does not call provider', { provider: 'plain' }),
    permission('registered duplicate identity uses first provider', { provider: 'duplicate-plain-first' }),
    permission('provider lookup does not use name fallback', { reference: 'wrong-identity' }),
    permission('wrong referent type retains the base-item identity match', { reference: 'wrong-type' }),
    permission('empty inventory missing referent short circuit', { provider: 'empty', reference: 'missing' }),
    permission('nonempty inventory missing referent fails', { reference: 'missing', failure: 500 }),
    permission('provider permission failure propagates before authorization', { result: 'failure', policy: 'none', failure: 500 }),
    permission('active Video exits before provider', { type: 'Video', active: true }),
    permission('active Video source bypasses an empty ChannelId lookup', { type: 'Video', active: true, reference: 'empty' }),
    permission('ordinary Channel root overrides provider deletion', { type: 'Channel', reference: 'empty', dtoFailure: 400 }),
    permission('root Folder exits before provider', { type: 'Folder', isRoot: true }),
    permission('physical MusicArtist overrides provider deletion', { type: 'MusicArtist', reference: 'empty' }),
    permission('Playlist action override and DTO precomputed overload differ', { type: 'Playlist', result: false, policy: 'none' }),
  ], deletions: [
    deletion('actual provider succeeds before native metadata and persistence'),
    deletion('actual batch retains its committed prefix before a missing item', { batch: true, actionStatus: 404 }),
    deletion('actual user denial retains all media and metadata before external deletion', { userRequest: true, result: false, policy: 'content', actionStatus: 401, retained: true }),
    deletion('ArgumentException is ignored by actual LibraryManager', { outcome: 'argument' }),
    deletion('ArgumentNullException inherits the native ignored argument boundary', { outcome: 'argument-null' }),
    deletion('provider I/O failure stops native metadata and persistence', { outcome: 'io', failure: 500 }),
    deletion('provider non-argument failure stops native metadata and persistence', { outcome: 'failure', failure: 500 }),
    deletion('provider absent is an ignored native argument', { provider: 'plain' }),
    deletion('missing referent is an ignored native argument', { reference: 'missing' }),
    deletion('provider callback can be explicitly disabled', { deleteFromExternalProvider: false, controller: false }),
    deletion('null ExternalId reaches the actual provider unchanged', { externalId: null }),
    deletion('ordinary Channel can be deleted by the userless controller', { type: 'Channel' }),
    deletion('LiveTvManagement deletion never evaluates provider CanDelete', { recordingController: true, policy: 'none', result: 'failure' }),
  ] };
}
