const key = 'xbmcmetadata';
export const nfoImageSourcePath = 'tests/images/fixtures/user-view-collage/small.png';
const initialXml = '<XbmcMetadataOptions><UserId>10000000-0000-0000-0000-000000000001</UserId><ReleaseDateFormat>yyyy-MM-dd</ReleaseDateFormat><SaveImagePathsInNfo>true</SaveImagePathsInNfo><EnablePathSubstitution>false</EnablePathSubstitution><EnableExtraThumbsDuplication>false</EnableExtraThumbsDuplication><Future xmlns="urn:nfo:future" note="preserve">before<Child />after</Future></XbmcMetadataOptions>';
const first = { UserId: '10000000-0000-0000-0000-000000000002', ReleaseDateFormat: 'dd/MM/yyyy', SaveImagePathsInNfo: false,
  EnablePathSubstitution: true, EnableExtraThumbsDuplication: true };
export const nfoConfigurationInput = () => ({
  identity: 'nfo-configuration-current-owner-live-consumers-20261025',
  core: [
    { name: 'missing-get-does-not-create-file', key, steps: [{ action: 'get', retain: 'initial' }] },
    { name: 'malformed-get-preserves-original-bytes', key, xml: '<XbmcMetadataOptions><SaveImagePathsInNfo>broken</SaveImagePathsInNfo></XbmcMetadataOptions>',
      steps: [{ action: 'get' }] },
    { name: 'unknown-xml-live-alias-and-cold-known-values', key, xml: initialXml, steps: [
      { action: 'get', retain: 'old' }, { action: 'save', values: first, retain: 'incoming' },
      { action: 'mutate', retain: 'incoming', values: { ReleaseDateFormat: 'yyyy/MM/dd', SaveImagePathsInNfo: true } }, { action: 'get', retain: 'current' },
      { action: 'mutate', retain: 'current', values: { UserId: first.UserId, EnableExtraThumbsDuplication: false } },
      { action: 'mutate', retain: 'old', values: { UserId: null, ReleaseDateFormat: 'old only', SaveImagePathsInNfo: false } },
      { action: 'saveRetained', retain: 'incoming' }, { action: 'get' },
    ] },
    { name: 'raw-key-current-isolation-and-shared-lowercase-file', key, xml: initialXml, steps: [
      { action: 'get', retain: 'canonical' }, { action: 'get', key: 'XbmcMetadata', retain: 'mixed' },
      { action: 'save', key: 'XbmcMetadata', values: first, retain: 'incoming' }, { action: 'get' }, { action: 'get', key: 'XbmcMetadata' },
      { action: 'mutate', retain: 'incoming', values: { SaveImagePathsInNfo: true, ReleaseDateFormat: 'yyyy' } },
      { action: 'saveRetained', key: 'XbmcMetadata', retain: 'incoming' }, { action: 'get' },
    ] },
    ...['updating', 'updated'].map(phase => ({ name: phase + '-observer-keeps-real-save-prefix', key, xml: initialXml, steps: [
      { action: 'get', retain: 'old' }, { action: 'observer', phase }, { action: 'save', values: first, retain: 'incoming' }, { action: 'get' },
    ] })),
    { name: 'save-adopts-incoming-before-real-target-failure', key, xml: initialXml, steps: [
      { action: 'get', retain: 'old' }, { action: 'physical', mode: 'target-directory' },
      { action: 'save', values: first, retain: 'incoming' }, { action: 'mutate', retain: 'incoming', values: { ReleaseDateFormat: 'yyyy/MM/dd' } },
      { action: 'get', retain: 'current' }, { action: 'mutate', retain: 'current', values: { EnableExtraThumbsDuplication: false } },
    ] },
    { name: 'readonly-save-keeps-current-and-original-file', key, xml: initialXml, steps: [
      { action: 'get', retain: 'old' }, { action: 'physical', mode: 'readonly' }, { action: 'save', values: first, retain: 'incoming' },
      { action: 'get' }, { action: 'physical', mode: 'writable' },
    ] },
    { name: 'real-read-io-failure', key, xml: initialXml, steps: [{ action: 'readMode', mode: 'io' }, { action: 'get' }] },
  ],
  http: [
    { name: 'ordinary-authenticated-get', key, method: 'GET', identity: 'regular', xml: initialXml },
    { name: 'missing-file-get-does-not-write', key, method: 'GET' },
    { name: 'full-five-field-post', key, method: 'POST', body: JSON.stringify(first) },
    { name: 'empty-object-defaults', key, method: 'POST', body: '{}' },
    { name: 'case-sensitive-manual-properties-and-unknown', key, method: 'POST', body: '{"saveImagePathsInNfo":false,"future":{"n":1}}' },
    { name: 'duplicate-token-last-value', key, method: 'POST', body: '{"SaveImagePathsInNfo":false,"SaveImagePathsInNfo":true,"ReleaseDateFormat":"yyyy/MM/dd"}' },
    { name: 'manual-json-reference-null-is-not-mvc-nonnullable', key, method: 'POST', body: '{"UserId":null,"ReleaseDateFormat":null}' },
    { name: 'user-id-remains-configuration-text', key, method: 'POST', body: '{"UserId":"not-a-guid"}' },
    { name: 'quoted-boolean-action-failure', key, method: 'POST', body: '{"SaveImagePathsInNfo":"false"}' },
    { name: 'boolean-null-action-failure', key, method: 'POST', body: '{"EnableExtraThumbsDuplication":null}' },
    { name: 'array-action-failure', key, method: 'POST', body: '[]' },
    { name: 'null-action-failure', key, method: 'POST', body: 'null' },
    { name: 'malformed-json-mvc', key, method: 'POST', body: '{"UserId":' },
    { name: 'missing-body-mvc', key, method: 'POST' },
    { name: 'regular-user-cannot-save', key, method: 'POST', identity: 'regular', body: '{}' },
    { name: 'anonymous-cannot-get', key, method: 'GET', identity: 'anonymous' },
    { name: 'api-key-can-save', key, method: 'POST', identity: 'apiKey', body: JSON.stringify(first) },
    { name: 'updating-observer-failure', key, method: 'POST', xml: initialXml, observer: 'updating', body: JSON.stringify(first) },
    { name: 'updated-observer-failure', key, method: 'POST', xml: initialXml, observer: 'updated', body: JSON.stringify(first) },
    { name: 'directory-target-failure', key, method: 'POST', xml: initialXml, physical: 'target-directory', body: JSON.stringify(first) },
    { name: 'unknown-get', key: 'nfo-factory-not-registered', method: 'GET' },
    { name: 'unknown-post', key: 'nfo-factory-not-registered', method: 'POST', body: '{}' },
  ],
  consumers: [
    { name: 'date-art-and-selected-user', before: { ReleaseDateFormat: 'yyyy-MM-dd', SaveImagePathsInNfo: true, UserId: '10000000-0000-0000-0000-000000000001' },
      after: first, folderUserIds: [
        { name: 'invalid-user-id-fails-before-folder-return', userId: 'not-a-guid' },
        { name: 'valid-user-folder-skips-play-state', userId: '10000000-0000-0000-0000-000000000001' },
      ], previousFolderNfo: '<season><title>Retained original</title><future keep="original">before<child />after</future></season>' },
  ],
});
