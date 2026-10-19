# Owned extra discovery and refresh dispatch

The sealed oracle calls the frozen workspace's actual `BaseItem.RefreshMetadata`,
`RefreshExtras`, `LibraryManager.FindExtras`, ExtraResolver and AudioResolver,
and `DeleteItem` with EF SQLite over real media and instance files.

All 17 cases compare discovery, localized names, name locks, stable/full refresh,
parent/owner assignment, missing extras, cancellation, selected row columns,
complete stored Data, file hashes, events and cached names on real SQLite and
PostgreSQL. Candidate media uses Memory VFS with controlled creation time; its
instance state file cleanup is real. Read-only writer previews are separate from
the native mutation trace.

Six cases add ordinary Series, Season, MusicArtist and MusicAlbum directory
owners: no extras, direct trailer, nested videos, theme audio, cached rename and
missing cleanup. Stored path separators are retained independently from the
directory enumeration spelling. Disc resolution remains outside this evidence.

The single-item provider performs no save. New extras are live entities and have
no persisted row or Added event in this fixture. Collection membership, savers,
image/media-source lists and extracted-file dispatch are controls. The separate
owned-extra-repository fixture covers first saves. Neither fixture proves the
complete MetadataService, full scalar mapper, .ignore/disc/network handling,
complete scanning, generic deletion, client acceptance or release readiness.
