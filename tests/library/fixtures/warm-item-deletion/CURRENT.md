# Current warm deletion consumers

`current-profile.json` binds the existing 24 neutral scenarios to
`current/Program.cs`, its project and the shared build properties. The test
records the supplied designated Native runtime during the same Actions run,
then consumes its pre-operation rows in isolated PostgreSQL/VFS state.

The real LibraryManager and EF/SQLite persistence create all Native rows and
perform both deletion stages. Sixteen persistence-only scenarios and eight
created/registered scenarios retain all 72 BaseItems columns, links, file
hashes, lookup results and provider/persistence/event ordering. The candidate
performs its real creation, hydration and deletion operations before comparing
the corresponding states. Missing-row clone/path/save conflicts, concurrent
reinsertion, cache pressure and committed/rolled-back save coverage remain.

Only the driver's own state root and its filesystem separators are projected
to `$STATE`. Data is parsed for that relocation, so these comparisons cover
persistent values rather than claiming raw SQL TEXT bytes. Native SQLite and
all raw input/output, source copies, build logs and process receipts remain in
the isolated validation output. No cache queue representation or snapshot
object freezing is an acceptance condition.

The original input, Native recording, provenance, README, driver, project and
historical absolute references remain intact. Native authentication, HTTP,
complete metadata/scanner coverage, clients, instance exchange and release
acceptance are outside this component fixture.
