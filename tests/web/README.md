# Browser validation

These tests launch pinned Chromium and sign in through each client's visible forms. Jellyfin tests serve the designated production Web build on a separate origin. Emby uses the version captured from its official host for that run. The input loaders verify the client and browser identities. Supply `native_reference`, `native_instance` and `native_sqlite` to the validation workflow, plus `web_clients` for Jellyfin or `emby_web` for Emby. [Workflow inputs](../../.github/workflows/ci.yml)

## Choose a consumer

| Scenario | What to observe |
| --- | --- |
| Login and a display preference | Open the empty Jellyfin home, save the preference, check PostgreSQL, wait for the client's query-cache TTL and reload the visible form. [Jellyfin preferences](jellyfin-web.test.js) |
| Browse, edit and restart | Open the scanned movie, load its image, favorite it, mark it watched and add it to a playlist. Restart the production entry in a separate Node process at the same origin. After the declared TTL, reopen the observed playlist and movie URLs in the same tab. Check the returned member, visible state, complete saved UserData rows and a fresh authenticated WebSocket handshake. [Jellyfin media](jellyfin-media.test.js) |
| DirectPlay and resume | Play H.264/AAC, observe advancing decoded video, then stop with the player's Back action. Check the PG position. After the TTL, use the visible Resume action. Its negotiation must send the exact saved ticks, decoding must advance past them and each stop must match PG. The public server configuration supplies MinResumePct 1, MaxResumePct 90 and MinResumeDurationSeconds 30. [Jellyfin playback](jellyfin-playback.test.js) |
| Remote control | Two browser contexts sign in as the same user. The controller selects the receiver's session in the cast menu, then pauses, resumes and stops playback. Pair controller HTTP actions with ordered receiver WebSocket commands, decoded video and PG playback state. Bind reports to the receiver's actual media URL and item/source IDs. [Jellyfin remote control](jellyfin-remote-control.test.js) |
| Universal audio | Play the frozen mono FLAC from the Songs view. Check the universal audio GET, HTTP 200 or 206, `audio/flac`, and the audio element's source, ready state and advancing clock. [Jellyfin audio](jellyfin-universal-audio.test.js) |
| Live TV | Open the Guide channel from the official M3U tuner. Follow the client's real auto-open and direct playback, check original bytes, decoded video, session reports, stop and released stream. Repeat with the same user and check the channel rows and play count. [Jellyfin Live TV](jellyfin-live-tv.test.js) |
| Emby authentication and settings | Use a fresh touch-capable context and the connection wizard at `/emby`. With legacy authorization disabled, check public discovery, authenticated Info/WS, PG device identity and capabilities, reconnect after reload and a visible preference saved and read back. Live TV access is disabled for this user. [Emby authentication](emby-auth-info.test.js) |

## Inputs and observations

The media, playback and remote-control scenarios start a production instance from the same-run stopped Native SQLite database imported into a private PG schema. Their mapped local library contains a tracked PNG, NFO and controlled video. Preparation copies the existing H.264 and first AAC streams from the frozen VobSub fixture into MP4 and repeats them to at least 90 seconds. It verifies packet payloads, order and rational timing against a shared video origin, and records each container's own hash. A separate read-only namespace serves ancestor `.ignore` lookups. The library scan uses public HTTP APIs. [Media fixture](web-fixture.js)

Emby capture records the version, entry, manifest, service worker catalog, startup plugin modules and resource hashes. It rechecks the entry and worker after capture. Runtime observations bind the browser's served assets and external Cast scripts to those inputs. The Emby test covers the auth/info and settings interactions listed above.

Reports keep media and client hashes, selected HTTP observations, browser exceptions, runtime diagnostics, screenshots and cleanup results. Grant notification permission only to the client origin when requested by the fixture. After a restart, assess the actual HTTP, UI, WebSocket and PG observations alongside diagnostics from the offline interval. Private media, browser, processes and schemas are released after their owners close. Credentials are redacted from published reports.
