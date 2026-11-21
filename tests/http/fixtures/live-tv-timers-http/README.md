# Saved Live TV timer HTTP fixture

This comparison reads and cancels saved timers through the real Native and Node HTTP controllers and authenticated WebSockets. All scheduled dates are one to six days ahead with 100 ns fractions. The timers stay idle while the fixture observes binding, authorization, persistence and events. [Test](../../live-tv-timers-native.test.js) · [Scenario](scenario.js)

## Instance setup

1. Start a private Native instance with empty timer documents. Request the global Live TV view and wait for its DateLastRefreshed commit before taking snapshots. Stop Native, seed the private SQLite database with channel, program, series, ancestor and image rows, then install the populated documents.
2. Start Native again. For each primary Node stage, use a fresh PostgreSQL schema with the same rows in insertion order, the same PNG and the original timer bytes. Check that timer state is absent before ordinary runtime initialization imports the files.
3. Compare the public reads and cancellations. After Native stops, its post-cancellation documents initialize a second Node schema. Delete the surviving childless series through Node, shut it down and give the exported documents to a third Native process. Native reads that change and cancels another series. Import its output into a third, cold Node schema and compare the final public reads.

## Assertions

| Surface | What the comparison checks |
| --- | --- |
| Reads | Anonymous, invalid, ordinary, Live-TV-disabled, administrator and API-key callers. Collections, details, Defaults, channel/series filters, sorting, status overrides and unbound selectors. Status, content type, full body, Guid binding and 100 ns dates. Zero-GUID Defaults returns 400. |
| Cancellation | DELETE binds string IDs, enforces LiveTvManagement and distinguishes completed, missing, already-cancelled, linked and unlinked timers. Missing targets return a plain-text 404 even with a JSON Accept header. Series cancellation preserves child order across statuses. |
| WebSockets | The two sessions with LiveTvAccess receive complete ordered envelopes. Management-only, denied, administrator-without-access and userless API-key sessions are excluded. MessageId is fresh per broadcast and shared by its eligible recipients. |
| Persistence | Compare typed timer identity, order, manual flag, status and remaining series. Node binds exact document bytes and hashes to its PG indexes. Content edits preserve copied business tables. After replacing Node's source files with empty bytes, warm reads still use committed PG state and reopening restores the published documents. |
| Diagnostics | Retain request-scoped errors, before/after snapshots, image identity, listener and schema cleanup. Compare public failure responses and check for unexpected errors through delivery and shutdown. |

The four POST create/update routes have separate binding and provider-state checks. The recording fixture exercises active files, tuner conflicts, retry, completion and playback. [Mutation HTTP tests](../../live-tv-timer-mutations.test.js) · [DVR playback](../../../playback/live-tv-dvr-native.test.js)
