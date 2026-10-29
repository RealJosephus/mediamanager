# Complete original Blu-ray/AVCHD reference acquisition

The workflow requires an explicit original source choice. Its default is the
Blender Foundation's complete official Sintel Blu-ray ISO, published at
`https://download.blender.org/durian/movies/Sintel-Bluray.iso`. The separate
`avchdcoder` choice retains Twan Wintjes's authored AVCHD test disc. Each choice
has its own source descriptor, identity checks and acquisition result. A failed
source remains failed throughout that run.

| Source choice | Original input and identity | Required readers |
| --- | --- | --- |
| `sintel` (default) | `sintel.json`; complete 1,593,180,160-byte `Sintel-Bluray.iso`; official adjacent MD5 `edef70074bc275190a016f9eaeb478dd` | actual standalone `7zz` ELF and `bd_info` ELF |
| `avchdcoder` | unchanged `source.json`; original ISO and MDS, complete torrent raw info identity and all 657 original SHA1 pieces | same readers plus actual `aria2c` ELF |

The Sintel descriptor binds the original official directory listing, adjacent
MD5, movie permission page, sharing terms, and sharing-page HTTP receipt as
unchanged small metadata files under `metadata/`. That directory's attributes
preserve their exact original bytes. The permission pages identify CC-BY 3.0
and require the entire credits scroll when showing or distributing the movie;
logos and unrelated trademarks remain outside that grant. All original media
and credits stay intact. Current publisher and permission pages are also
recorded in CI, with HTTP headers and raw body hashes. Page layout and timestamp
changes do not become new media identity conditions.

The official HTTPS response streams into a new private disk file. It must be a
successful full-object response from a declared publisher host, with the complete
published size and matching adjacent MD5. Streaming SHA256 and MD5 are recorded;
an independent full disk read must reproduce both hashes and the size. Sintel's
SHA256 is frozen from the stream and independent complete disk reads in
[run 40512414913](https://github.com/RealJosephus/mediamanager/actions/runs/40512414913)
at candidate `bbf6a29`: `693ac48a9ecc53071d014ef485d7850f916abef624c8dafa1d5801d828158c69`.
The unmodified small acquisition, full member/file inventories and actual
libbluray output are retained with their hashes in `first-sintel-ci/`; the
original report still marks this first observation as previously unfrozen.
That run read all 1,593,180,160 ISO bytes, extracted all 14 original BDMV files
(1,592,116,024 bytes), and completed all seven reader/dependency processes with
exit zero. It proves Linux source acquisition only. Every later acquisition
enforces the frozen SHA256. Partial, oversized, truncated, stalled and checksum-inexact input
fails acquisition, while preserving the available small progress evidence.

Both sources then use the same complete original UDF verification. The actual
7-Zip reader lists every original member, tests the entire ISO, and extracts
every file and directory. A full extracted inventory must match every listed
path, kind and size. Every extracted file receives a disk SHA256; all BDMV
members receive a separate complete inventory. Exactly one BDMV index and
nonempty MovieObject, playlist, clip-information and stream members are required.
The real libbluray `bd_info` process must detect the extracted complete disc.
Original ISO/MDS digests, source metadata, producer code, executable ELF files,
and their actual linked libraries are checked again before success.

The runner retains the complete original and complete extracted disc for a
same-job consumer through `MEDIAMANAGER_TEST_BLURAY_ISO`,
`MEDIAMANAGER_TEST_BDMV_ROOT` and `MEDIAMANAGER_TEST_BLURAY_DISC_ROOT`. The artifact
contains only small original-source and verification evidence; it cannot supply
media to a later job. No media is acquired or generated on the development
computer. This controlled original disc input does not establish commercial
BD-ROM, encryption, BD-J/menu decoding, 3D, library, complete-instance,
production-scale or release acceptance.

The AVCHDCoder torrent has a single old tracker and no webseed. Its availability
remains unproven until CI downloads both original files and independently
verifies every original piece, including the final short MDS piece. The verifier
retains the concatenated file order at every piece boundary. The torrent's
complete SHA256, raw info-dictionary SHA1, filenames/sizes and piece-array SHA256
remain pinned. Its movie grants are separately recorded in the descriptor and
do not relicense the author's added intro/menu or unrelated trademarks.
Run `40503504770` failed before acquisition because a tool argument was empty.
Run `40506667351` bound all three real tool ELFs successfully, then failed at
`download-complete-original-torrent` with aria2 exit 7: the old tracker failed DNS
resolution and five minutes passed with zero transferred bytes and zero peers.
Those runs supply no complete original media or BDMV success claim.

Ubuntu 24.04 supplies `/usr/lib/7zip/7zz` through `7zip-standalone`; `/usr/bin/7zz`
is its launcher. The workflow binds the real ELF. Installation output, selected
package versions and complete package file lists are retained with acquisition
evidence. Required options, missing executables, execute permissions and ELF
identity failures are recorded before failure. The default source needs no
torrent client. Each download is bounded at 45 minutes and five minutes without
progress, all acquisition/verification shares a 55-minute deadline, and the
workflow job retains its 60-minute budget.
