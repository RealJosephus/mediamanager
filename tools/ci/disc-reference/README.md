# Original DVD reference acquisition

The manual `disc-reference.yml` workflow acquires one complete original Big Buck
Bunny DVD image on a fresh GitHub-hosted runner. `source.json` fixes the Internet
Archive object, exact image filename, full byte count, published SHA-1 and MD5.
The workflow reads live metadata and retains its original response, acquires
every ISO byte, verifies the complete image and independently reread disk
digests, and calculates the original image's SHA-256. Network, disk, metadata,
archive reader and extraction failures fail the job and retain their own
observations.

The transport uses four bounded workers and 32 MiB HTTPS byte ranges within
the original 100-minute acquisition deadline. Each response must describe its
exact requested interval and the complete original size. A successful full-body
response that ignores Range, a changed strong validator, a truncated interval
or a wrong interval is rejected. Retries stay within the same deadline; a
strong ETag, when supplied, binds subsequent conditional reads. The completed
file must cover the entire original object and pass its published SHA-1/MD5
and any frozen SHA-256 before the existing independent disk read and complete
ISO extraction can proceed. Range or retry progress is diagnostic and never
establishes a complete source. No media bytes are generated, transformed or
replaced by a sample.

The complete NTSC acquisition in Actions run `40494656261` established the
8,294,793,216-byte ISO SHA-256 and the complete 60-entry, 3,190,976,512-byte
VIDEO_TS inventory. Their retained SHA-256 values are now fixed in the source
descriptor and verified on every subsequent acquisition. These SHA-256 values
come from that complete CI observation; the original Archive metadata supplies
the separately checked SHA-1, MD5 and byte size.

The source producer's [license statement](https://peach.blender.org/about/)
covers the DVD data under [CC-BY-3.0](https://creativecommons.org/licenses/by/3.0/).
Attribution: (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org.
The cover, disc print and trademarks are outside that grant. The extraction
keeps the original movie credits and never modifies or encodes the media.

GNU tar cannot supply this input. Linux installs libarchive-tools; Windows and
macOS bind their actual libarchive tar executable. The acquisition records the
executable's path, bytes, SHA-256, version, original command arguments, complete
stdout/stderr and process exit. Executable and producer file hashes are checked
again after extraction. The receipt also binds the dispatched checkout, GitHub
run and attempt, source descriptor and executing Node binary.

The complete ISO lands in a fresh directory under `RUNNER_TEMP`. A full simple
member listing and a full detailed member listing must agree. Extraction keeps
every original regular file and directory below `VIDEO_TS`, including menus,
backups and all VOB segments. The extracted tree must match that entire member
set and every byte size; each complete file receives a SHA-256. The original ISO
must remain unchanged through extraction. Only then is the private temporary
ISO removed and a complete receipt written. The full VIDEO_TS remains on the
runner for later consumers. Free space, response size, process output and
provisioning time are bounded; lack of space fails without trimming the input.

Only the small `evidence/` directory is uploaded: raw metadata, HTTP observations,
all original ISO member names/sizes, archive process logs, the full VIDEO_TS
inventory and its receipt. The 8 GB source and extracted media are not committed
or uploaded as an oversized artifact. A consumer must supply the same pinned
original bytes in its own run; this workflow's receipt alone is not a media
input. Partial acquisition has no complete receipt and is never accepted as an
available DVD service.

This stage establishes original input acquisition only. Native/Node VFS probe,
scan and bidirectional database exchange still need their own actual execution
and comparisons. It does not establish Blu-ray input, playback or release
acceptance. The AVCHD movie author's torrent listing is not acquired disc bytes.

The tool deliberately refuses local execution. No production dependency or
business validation time budget changes are introduced by this workflow.
