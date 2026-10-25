# Current password, JSON and file readers

The six registered tests preserve all original input groups: two password
scenarios, two task documents, two configuration states, six WPL/ZPL layouts,
and 590 subtitle layouts. The public JSON boundary additionally covers Single
and Double negative zero, Int64 endpoints, seven-digit dates, null dictionary
values, surrogate replacement, and non-finite rejection.

`timestamp-map-input.json` adds ten neutral WebVTT scenarios alongside the
unchanged 590 layouts: nonzero and short LOCAL values, case and space variants,
later segment maps, map text inside a NOTE, zero/negative/out-of-range offsets,
submillisecond media clocks, and preserved or relocated playback windows.

`current-readers.js` verifies the profile files and the designated same-job Native
build, including its source offer and runtime closure. Its source bindings name
the relevant Jellyfin consumers; the full source manifest binds the remaining
designated Jellyfin source files. The runtime closure and the oracle's loaded
assembly hashes bind external dependencies, including PlaylistsNET and
SubtitleEdit. The copied original inputs are neutral scenarios, not a substitute
for executing those consumers.

- Node generates a fresh password hash through `createPasswordHash`, and derives
  and serializes a second hash with a salt containing zero. Native verifies the
  actual current strings. Node verifies fresh Native CSPRNG and contained-zero
  hashes, including rejection of a changed password.
- The current Node public JSON writer feeds the Native typed JSON reader and
  serializer. Node reads independently generated Native output. The comparison
  uses public values; the complete strings and rejection diagnostics remain in
  the recording.
- `ScheduledTaskFileStore` writes the task inputs. Native reads those physical
  files through the actual task DTO serializer and writes new files. A fresh
  Node store imports, reads and rewrites them, preserving ticks, enums, dates,
  and history text values.
- `ServerConfigurationStore` edits the original XML on disk. Native reads the
  result and records the unknown elements' namespaces, attributes, mixed text,
  and child order. The Native serializer's loss of unmodeled elements remains
  visible. Node reads the actual Native rewrite and continues a configuration
  update. The original Node edit retains every byte outside the changed
  `ContentTypes` element, as well as the unknown elements' reader-visible values.
- `serializePlaylistFile` generates WPL and ZPL for three links, including a
  duplicate. Attribute order and BOM/LF variants come from those current bytes.
  Native reads both the neutral input and current Node output, writes sidecars,
  and reads them again. Metadata fields, path order and duplicates are compared;
  Node parses the actual Native sidecar files.
- Node converts every subtitle input through the current converter. Native
  independently parses all 590 neutral layouts and all successful Node outputs,
  writes each subtitle through SubRip or WebVTT, and reads its rewrite. Node then
  reads that Native output. Only CRLF/LF/CR representation is normalized while
  retaining line order and empty lines. Cue IDs, times, text, markup and failure
  outcomes remain strict. Runtime exception names and messages are diagnostic.
  The additional time-map inputs also pass through the designated Native
  `SubtitleEncoder.FilterEvents` with the same start/end and preservation
  options as Node. Both sides write the resulting cues and read the other
  side's output. This checks that mapping occurs before clipping or relocation
  and is applied exactly once when the rewritten subtitle is read again.

The output directory is `consumer-readers-current-*` under the isolated
validation root. It retains `capture-report.json`, `consumer-input.json`, the
current Node task and configuration files, the Native build/process receipt and
logs, `native.json`, actual Native task/configuration/playlist files, and the
reverse Node observations. A successful recording sets only
`nativeExecutionRecorded`; `phaseAcceptance` and `releaseAcceptance` stay false.

This is component reader/writer evidence. The captured historical HTTP subtitle
bodies remain inputs, and this test does not claim a fresh HTTP delivery, whole
server takeover, database exchange, or release acceptance.
