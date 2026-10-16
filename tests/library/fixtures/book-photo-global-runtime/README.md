# Same-platform Book and Photo global scans

This fixture runs the designated source-built Jellyfin reference on the current Actions runner. It preserves the fourteen scenarios and sixty-one scan steps from the historical `book-photo-global` matrix. Asset bytes retain their original hashes; only their locations are made fixture-relative. The historical recording and its provenance remain unchanged.

The helper runs actual resolver discovery, LibraryManager traversal, Book/Photo providers, image saving, SQLite persistence and cold repository hydration. Every native case has a fresh state directory and records resource release. The candidate uses a fresh PostgreSQL schema with one connection, actual runtime/configuration/scanner services, independent original and sidecar local mounts, and the runner's native path style. NFO and TMDB plugins are explicitly disabled to match the native provider controls.

The comparison covers the existing subject projection: paths, types, metadata, parents, ancestors, image placement, dimensions, BlurHash and bytes. Raw native SQL/state observations and candidate rows are retained alongside each comparison. This is not an all-column equivalence claim. The shared native host retains explicit monitor, post-task sentinel and external-cleanup controls; this fixture does not admit the complete library scan or replace the separate actual-monitor and post-task contracts.

Run this test through GitHub Actions with `native_reference=true`. No historical local DLL, source tree or recording directory is required for this new consumer.
