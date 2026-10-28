# HTTP storage source fixture

`http-source.js` starts an isolated, real HTTP server on loopback and an ephemeral
port. It supplies ordinary GET-only resources, byte ranges, source error bodies,
redirects, compressed/chunked data and controlled pending/truncated responses.
Each actual response and socket has a close receipt so the tests can await real
handle, bridge and plugin shutdown before destroying fixture-owned resources.

`../http.test.js` exercises the official HTTP storage adapter through VFS and the
public binary response consumer. URI identity and signed query spelling survive
access mapping; raw HTTP status/body and Range/If-Range are distinct from normal
reads that reject unsuccessful source responses. Configured source prefixes and
independent metadata storage remain selectable, and plugin defaults do not grant
write capabilities.

These are storage and transport regressions. They do not record the Native
subtitle controller/encoder and do not certify a File identity as an HTTP
identity. The separate `tests/playback/fixtures/subtitle-http-current/` fixture
owns current Native HTTP subtitle recordings and cache consumers. Tests execute
only in GitHub Actions under the repository validation workflow.
