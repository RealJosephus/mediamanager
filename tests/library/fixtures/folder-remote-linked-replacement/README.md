# Native remote-linked replacement boundary

This fixture invokes the frozen Jellyfin `Folder.ValidateChildrenInternal` against
real warm `CreateItems` state and EF SQLite persistence. Before reconciliation,
the old 2160p primary owns ordinary local-version rows and a separately persisted
`LinkedAlternateVersion` (`ChildType=3`) whose item path is
`https://media.invalid/film-linked.mkv`. A real BoxSet supplies a manual incoming
link so reroute and metadata-saver ordering also execute.

The two-version primary-removal case succeeds. Native treats the HTTP alternate
as missing because `ManagedFileSystem.FileExists` returns false, deletes it before
deleting the old primary, promotes the 1080p row, and reroutes the BoxSet.

The three-version primary-removal case deletes that HTTP alternate and then ends
with the genuine foreign-key `DbUpdateException` already frozen for the local-only
branch. Its output preserves the committed prefix.

The two-stage exact-primary case first adds `Film.mkv`. Demotion succeeds and
updates the remote row's `PrimaryVersionId`, but the new exact primary does not
retain a `ChildType=3` link. Removing `Film.mkv` on the next validation produces a
genuine `DbUpdateException`; the remote row remains and still points to the now
physically missing exact primary. The BoxSet link has already moved back to 2160p.

The fixture records compact BaseItems/LinkedChildren snapshots and persistence,
external-cleanup and saver order. It excludes network access, saver file contents,
recursive scanning, Web behavior, migrations and release acceptance.
