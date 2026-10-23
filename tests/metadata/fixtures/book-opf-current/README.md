# Current OPF and EPUB observations

This fixture executes the designated same-run source build twice in separate
physical asset directories. It retains the complete original case inputs from
the historical `book-opf-epub` and `book-opf-xml-edges` fixtures: 82 reader,
13 OPF provider, 38 EPUB, five ZIP and nine XML resource cases. Historical
recordings, source seals and archives remain unchanged.

`input.json` pins every stored asset by length and SHA-256. Resource documents
are stored as the original gzip files and expanded only inside each private
execution directory; expanded bytes have their own seals. All other XML and
archive bytes are copied verbatim. Empty directories are explicit inputs.

The native process verifies its actual offset at the declared Asia/Taipei
instant. OPF timestamps retain both the requested 100 ns ticks and the actual
filesystem observations. The Node storage fixture receives those observed
timestamps without rounding, so filesystem precision is an input to the
provider comparison. Independent native observations must agree.

The consumer preserves all declared metadata fields, people, error outcomes,
error log counts, sidecar selection, timestamp comparisons, cover bytes and
formats, ZIP names/order/lookup and resource UTF-16 lengths/UTF-8 hashes.
Unpaired UTF-16 strings use the existing explicit JSON wire projection. CLR
exception names, messages and stacks are diagnostics. Raw native captures and
per-case candidate observations are kept alongside execution records, current
source bindings and build identity. This component does not establish HTTP,
the generic metadata host, full scan or release acceptance.
