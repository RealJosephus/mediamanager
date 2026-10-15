# Album After native controls

`Program.cs` executes the pinned modified Jellyfin DLL's actual
`AlbumMetadataService.AfterMetadataRefresh` and None refresh. The native album,
`PeopleHelper.AddPerson` and `PeopleRepository.UpdatePeople` run, with a fresh
real EF SQLite database per sample. An existing Actor credit makes preservation,
replacement, order and orphan cleanup observable.

The 49 controls cover empty arrays versus whitespace/null members, AlbumArtist
before Artist, duplicate spelling, CLR whitespace, Unicode ordinal comparisons,
locked and None refresh, null cached arrays, ignored cancellation in the After
hook, cancellation after a successful item-save callback, item-save failure that skips After, and pre-repository or post-credit
failure. ForceSave controls include an actual Audio child because BeforeSave
recomputes artist arrays from tracks before the After hook.

The library's UpdatePeople callback delegates to the real native repository;
explicit failures bracket that call. Cached arrays, empty providers, child
contents and metadata item writes are controlled. SavePeopleMetadataAsync,
person entity creation, NFO, image files and native HTTP are outside this
recording. The recorded credits are native persisted EF rows, while `calls`
records the controlled library callbacks.

Candidate tests compare call order, flags, exceptions and committed credits on
SQLite and real PostgreSQL. Raw cached artist arrays are explicit context
controls in those comparisons because SQL hydration removes empty/null members.
Separate tests use unmodified stored arrays and verify that a people-only update
does not save or emit ItemUpdated for the Album. Candidate person identities and
partial transactions are checked separately; this recording does not establish
native person creation, saver/file failure parity or complete refresh/scan/Web
acceptance.

Record into a new isolated directory after applying the validation environment:

```powershell
node tools/validation/oracle.js tests/metadata/fixtures/album-after-refresh/Oracle.csproj D:/isolated-validation/results/album-after-refresh-oracle-NEW tests/metadata/fixtures/album-after-refresh/input.json '{output}/native.json' '{output}'
```

`provenance.json` seals raw input, native output, oracle/project/build-property
bytes and pinned source/runtime hashes. `candidateVerified` remains false.
