# Historical evidence integrity checks

The two `.txt` files contain the exact Git blob bytes from commit
`649dcb08ba575319c262ef66943a85f94398709f`, before separating historical
recording revalidation from current functional validation. They are archival
source, not executable tests and not replacement native observations.

| Original repository path | Bytes | SHA-256 |
| --- | ---: | --- |
| `tests/library/native-evidence-closure.test.js` | 11723 | `28bf4805fbcf795c843f7661adc548786ef224ea4bd440537f46873bc9c32961` |
| `tests/library/native-identity-inputs.test.js` | 7069 | `e42a009087f38a79ccba9609761b58de405c4ca46bb5bb82d38209c77f6399db` |

The retired checks require the original initialization database, preparation
files, independent audits, executable trees, and repeated recording directories.
Those original inputs and seals are unchanged. Archiving these checks does not
claim that their unavailable inputs were verified or that today's instance can
substitute for them. Historical functional consumers and their helpers remain
until separately migrated to a current, explicitly supplied native comparison.

The active `native-evidence-closure.test.js` retains both temporary artifact
manifest controls (raw-byte digests, exact membership, traversal and links) and
an explicitly synthetic executable-binding control. The active
`native-identity-inputs.test.js` retains synthetic HTTP count, order, content-type
and added-field controls through the shared comparator. Existing
`full-filter-wire.test.js` covers the other DTO, status, identity, JSON and text
controls; `tests/validation/runner.test.js` covers protected output roots; and
`tests/validation/ci-scope.test.js` covers current build input corruption and
directory membership. No new native host or scenario matrix is introduced.
