# Current first UserRoot initialization

The fixture uses the same current Native reference, original migrated SQLite
clone, actual repository/mapper and explicit platform SQLite binding as the
existing root navigation components. This separate entry runs the actual
LibraryManager constructor and GetUserRootFolder, including its actual
SpecialFolderResolver, GenericFolderResolver, ResolverHelper, ManagedFileSystem
and ItemPersistenceService. It does not inject a preformed `_userRootFolder` or
use EnsureCreated.

Two independent captures consume five neutral controls: a missing root, an
existing UserRoot whose live Path must reset, a different stored type at the
canonical ID, a controlled initial repository lookup failure, and an actual
ordinary file occupying the required directory. The collision preserves its
original bytes, rejects, and recovers after the fixture removes that exact file.
The Node runtime's storage preparation can already create the owned empty
`root/default` directory. The collision control removes only that empty
directory before installing its ordinary file, before the first measured
getter. A nonempty directory fails this setup. Run `40528381529` completed the
other four Node controls, then failed while installing the file over that
directory; the original failed receipt is retained. The actual getter rejection,
unchanged file bytes and complete database, and recovery checks remain intact.
Only the initial repository lookup is fault controlled; subsequent lookup,
filesystem resolution, save and cold-read operations execute the real services.

Eight initial concurrent reads observe one root's later unsaved Overview; eight
repeated reads consume that same warm value. The separate GetItemById result is
retained: a newly resolved root is absent from the ID cache and repository until
another declared operation registers or saves it. No early save is manufactured
to satisfy a service fixture. A cancelled actual save must leave all tables
unchanged. Fixed neutral metadata then passes through actual SQLite saving,
explicit public registration and a fresh LibraryManager's cold lookup.

The wrong-type control includes a real stored direct Folder before the first
Get. Actual DeepCopy reads and copies Children. A second actual Native save
inserts a late direct child: the warm root retains its original child, and
ReleaseCachedChildren exposes both rows. The Node consumer freezes that exact
actual late BaseItems row as the input mutation, then exercises the formal
physical child source before and after release. The production implementation
keeps the complete warm snapshot in the existing SQL cohort, with bounded
materialization. No private cache shape or resident-array size decides a pass.

Seed rows use actual ItemPersistenceService. Its ancestor collection can call
GetCollectionFolders and acquire the seed manager's root before committing a
child. The measured actual LibraryManager is therefore constructed afresh after
all seed persistence, before the frozen initial database and first measured Get.
The independent Node runtime consumes that same stopped initial database. The
earlier capture that reused the seed manager retained an empty warm child list;
its raw report remains a failed first-acquisition fixture run.

The Node consumer transfers each capture's actual frozen initial SQLite through
the production transfer path into PostgreSQL, constructs the real runtime, and
consumes the same operations before runtime startup. It compares selected live
fields, all non-generated BaseItems columns, complete Data values and provider
rows with the current Native result. All seven date digits are retained; typed
date comparisons use ticks, and independent first-creation clocks are separately
checked against their actual creation intervals. Only the declared root Path
role is rebound between independent program directories. Opaque values are
never rewritten. Before/after reads and cancellation compare every table;
shutdown releases the actual entity owners, followed by a fresh PostgreSQL
runtime's cold read. The separate platform regression also holds an admitted
first lookup across actual runtime shutdown and verifies that no root row is
created and no owner remains.

The input explicitly declares a neutral valid native server identity for this
component's PostgreSQL binding and both runtime owners. It is not a captured
full server's identity. The original descriptive string used here was rejected
by the production binding validator after both Native captures completed; that
failed run does not relax the production native identity contract.

Each Node control declares its one actual owned program directory as a named
portable identity mount and provides the corresponding writable Local VFS
instance, prefix and capabilities to both warm and cold runtimes. The original
wrong-type control includes ordinary Folder rows at `program/old-root` and
`program/children/original`; their original Native Path/Data values remain
unchanged. They require this actual path namespace and are not reclassified as
instance-owned UserRoot state. Run `40523393256`, candidate `7b6629b`, completed
both Native captures and the fresh/stored Node cases, then correctly rejected
the wrong-type import because the fixture had declared an empty mount set.
That Linux and Windows failure is an incomplete fixture input, not a reason to
weaken production transfer validation. The explicit mount now covers every
original child/root path without rewriting rows, removing cases or reducing
the complete database checks.

The shared HTTP catalogue fixture supplies all seed rows, real state files,
storage bindings and plugin inputs before its first root acquisition and before
runtime.start. It uses the ordinary unstarted runtime factory with the same
loopback network configuration. Its previous close-and-reuse preparation and
requirement for a transient root's fictitious repository frame are removed;
close remains a terminal operation. Complete persistent root/virtual-child
rows, HTTP responses, later warm mutations and final owner cleanup stay checked.

Original input bytes, both Native reports/process receipts, source bindings,
original before/after SQLite hashes, complete read/cancel table digests and
candidate values remain in the validation output. Private instance directories
are removed only after their actual runtime owners close. The application-host
path mapping is a declared identity control for the user-root path, which lies
outside DataPath and InternalMetadataPath. Collaborators not consumed by this
root component remain absent. It does not claim Native full-host HTTP,
authentication, metadata-provider refresh, arbitrary plugin resolution,
production scale or final phase/release acceptance.

The actual repository save consumes `BaseItem.PathProtocol` when collecting
ancestors. That gateway calls the current Native `MediaSourceManager` path
resolver with the real `ManagedFileSystem`; unrelated media-source methods
reject unexpected use. The initial run's absent gateway raised a Native
NullReferenceException before its save comparison and remains a failed run.
Ownership observers are released through their actual `release()` contract.
