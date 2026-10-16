This is an API-only test host built from the designated D:/alist source at
38316357f1a0507e9e8906ed9ec78e8535ba2d1c, including the current drivers/all.go
change and the two new drivers/hf_aggregate Go files. The source archive retains
all 633 tracked files and both new files byte for byte. It is a separate reference
program, not a library linked into MediaManager. AList's AGPL-3.0 license and the
existing embedded dependency notices remain in the source offer.

The original ignored public/dist is deliberately NOT distributed. Its frontend
contains third-party assets whose redistribution rights have not been established.
The independently authored web/index.html is the sole controlled frontend input;
its raw hash is part of package.json and the build receipt. No Go source is patched.
That independently authored resource is offered under LICENSE-Test-Web.txt (MIT).
This does not reproduce an original AList release or validate its browser UI.

In the designated source, public/public.go embeds all:dist. Startup reads
dist/index.html in server/static/static.go, replaces optional strings and registers
UI fallback routes. The real /ping, /api, /dav, /d and /p routes are registered in
server/router.go before that fallback. The actual-alist helper uses those real
APIs with a newly created PostgreSQL database, generated credentials and synthetic
Local storage. It never opens the user's AList data, HF manifest or remote storage.

package-alist-source.ps1 only prepares source files. It checks the designated HEAD,
exact dirty-file allowlist, ordinary-file paths and byte hashes. The sole reviewed
credential-pattern exception is the unchanged upstream qBittorrent localhost
default in internal/offline_download/qbit/qbit.go, identified by its whole-file
SHA256 and fixed public upstream commit. No credential value is printed.

build-alist.ps1 runs only in Actions. Go 1.23.1 archives are pinned to the official
SHA256 values at https://go.dev/dl/. CGO remains enabled and the original jsoniter
build tag is retained. The isolated build uses the existing go.mod/go.sum without
updates; module verification, compiler identity, source snapshots and executable
hashes are retained. No upstream build script is run and no frontend is downloaded.
The first real build and every test must run in Actions; preparation is not a pass.
