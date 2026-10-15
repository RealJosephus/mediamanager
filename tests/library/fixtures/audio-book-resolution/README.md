# AudioBook resolution oracle

`Program.cs` executes the frozen Jellyfin `AudioResolver` and `AudioBookNameParser` over real files. `input.json` separates multi-item, file and directory calls so the otherwise surprising `.cue`, `.strm`, top-parent and multiple-audio behavior remains visible.

`native.json` is the immutable projection and `provenance.json` binds its source, runtime and assembly identity. Candidate persistence and collapse/expand transactions are verified separately in the JavaScript integration tests; this fixture is not complete scan or release evidence.
