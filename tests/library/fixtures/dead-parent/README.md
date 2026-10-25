# Items with dead parents

These 20 observations execute the designated `BaseItemRepository.GetItems`
against real EF SQLite rows. The fixture preserves every BaseItems column,
independent query input, item order, total count, recorder and build provenance.
It does not execute cleanup, metadata providers, HTTP or a full library scan.

The selector requires a non-null immediate ParentId without a matching item
other than the reserved detached-user-data placeholder. Null parents, a living
parent, a self-parent and children of a living orphan remain outside the result.
The empty Guid is a real parent when its row exists. OwnerId and alternate
exclusion retain the repository's default behavior. False and unset flags do not
add a predicate; type filtering, total count and zero, negative and offset limits
remain independently observable.

The recording was copied without changing its original bytes. `provenance.json`
binds the query source, input, assemblies, SDK and recorder. Earlier native
control and build failures remain in the validation archive. Re-record with the
matching isolated assemblies and three new absolute arguments: an instance
directory, output JSON and independent query input JSON.
