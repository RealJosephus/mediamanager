# Actual Web consumers

These tests serve the designated, unmodified Jellyfin Web production build on a
separate HTTP origin and use the pinned Chromium executable. Source/build,
dependency and browser identities are verified by the validation input loaders.
Neither client authentication nor responses are injected. A new browser logs in
with the visible server and password forms.

`jellyfin-web.test.js` covers the empty home and a display preference. It verifies
the PostgreSQL value and waits for the client's declared query-cache TTL before
reloading the visible form and checking the actual server readback.

`jellyfin-media.test.js` starts from the same-run stopped native SQLite input,
imports all native tables into a private PostgreSQL schema, and starts
`startProductionInstance`. Its explicit portable media mount uses the independent
local storage plugin. FFmpeg generates a controlled H.264/AAC file **only during
test input preparation**; the server does not encode it. The private media root
also contains an NFO and a copied, tracked PNG. An authenticated administrator
creates the movie library and queues the actual scan through public HTTP APIs.
The NFO consumer deliberately disables the external TMDB plugin.
Ancestor `.ignore` lookups use a separately declared read-only local namespace
and observe the actual host files or absence; they are not replaced by an empty
memory filesystem. This namespace is confined to the ignore reader and adds no
media identity prefix to the persisted portable mount contract.

The browser clicks the library and movie cards, reads the real detail DTO and
local image, favorites the movie, marks it watched, and creates a playlist with
the selected movie. UserData is checked directly in PostgreSQL. The fixture then
closes and reopens the production entry at the same origin, preserving the same
database, paths, plugins and browser session. After the declared client TTL, a
reload checks the actual playlist response and visible member, and browser
history returns to the movie to check server and visible favorite/watched state
against the complete saved UserData rows.

Reports retain source and media hashes, observed HTTP paths/statuses (query keys
only), selected response bodies, browser/runtime errors, screenshots and cleanup
outcomes. Passwords, tokens and database credentials are redacted. Client assets
are represented by hashes rather than republished in test reports. Private
instance/media trees, browser and PostgreSQL schemas are closed and removed.

`jellyfin-playback.test.js` exercises actual H.264/AAC playback using the same
controlled media. Its real server XML declares MinResumePct=1,
MaxResumePct=90 and MinResumeDurationSeconds=30; a public configuration readback
must confirm these values. The browser clicks Play, decodes advancing video,
negotiates DirectPlay, and sends real start/progress/stop reports. Back invokes
the designated player's own stop handler. PostgreSQL must contain the reported
position. After the client's declared TTL, a reload checks the real item and
visible Resume action, then the browser resumes and stops a second time. No
player clock, playback report, authentication or client cache is injected.
The Resume negotiation must send the exact saved ticks, and decoded video must
advance beyond that position. The player's new start-report clock is diagnostic;
each stop report must still match PostgreSQL and the server readback exactly.
The isolated browser grants notifications only to the client origin, matching
the designated client's permission request; the observed permission is recorded
and unexpected page errors still fail the consumer.

The browse/edit consumers do not prove playback; the playback consumer requires
its own successful execution. These tests do not prove remote control, weak
networks, Emby Web, external TMDB, large libraries or production migration. A CI
run establishes only its explicitly selected consumers and platforms. Run on
GitHub Actions with `native_reference`, `native_instance`, `native_sqlite` and
`web_clients` enabled; do not execute local validation.
