# Music library exchange

This Actions-only scenario uses the designated same-run Native build and its
isolated initialized instance. It removes only the documented two synthetic
preparation rows from a private clone before its first boot. No Artist, Album,
Audio, stream, aggregate or music relation is seeded into either database.

The initial Native scan resolves one artist folder, one album folder and two
real WAV tracks. PostgreSQL imports the complete stopped database; the production
Node entry point scans a third track, saves album and track metadata through HTTP,
writes the album NFO, favorites a retained track and deletes another track through
HTTP. A subsequent actual scan updates the remaining music hierarchy and
aggregates. A newly opened PostgreSQL connection and newly started production runtime
must read those changes. The complete exported SQLite database is then installed
in the stopped private Native clone. Native reads all Node changes, scans a fourth
track, saves further metadata and NFO changes, and stops. A fresh PostgreSQL schema
imports the returned complete database and a fresh production runtime reads it.

The four deterministic PCM WAV inputs have different lengths and RIFF INFO
title, artist, album, track, year and genre tags. Their construction uses standard
RIFF chunks; the designated ATL 7.16.0 package's
[WAV reader](https://github.com/Zeugma440/atldotnet/blob/09e9703ecc18d416cd4c0ea02179d05315c63904/ATL/AudioData/IO/WAV.cs)
maps those INFO fields to its audio tag consumer. The test uses real Native
ffprobe/ATL and Node ffprobe through the actual storage/probe path, with no probe
substitute. Its private HTTP proxy on the workspace's required port 5244 can read
only the four declared business filenames and validates each file's complete
bytes. A deleted file has no retained-input fallback.

At each exchange boundary, all 31 business tables, both EF tables, migration
history, SQLite sequences and the Native schema fingerprint are checked.
Music snapshots preserve complete rows, raw Data TEXT and all item relations.
Public checks cover identity, hierarchy, artist membership, tagged fields, actual
PCM stream information, Artist/Album runtime and genre aggregation, metadata
edits and favorites. Deleted items,
their relations and source bytes must stay absent; other tracks and the unrelated
album asset must retain their exact bytes. Album NFO checks use its real title and
review fields and preserve its complete raw bytes in the report.

The output retains original input JSON and WAV bytes as base64, HTTP requests and
responses, actual scan task results, Native source/build bindings and process
logs, full exchange digests, music row snapshots, NFO bytes, proxy observations
and cleanup outcomes. Only filtered reports are published; private instance
databases and credentials are removed after all owners stop. This test does not
claim other music formats, playback, arbitrary library layouts, full instance
state-package migration, production-scale coverage or release acceptance.
