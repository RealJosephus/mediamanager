# Native configuration files



The candidate raw reader replays 741 cases. File tests replay 109 helper and plugin cases, use actual native lock holders, and pass the written files to a fresh native reader. Shared helper loading repairs missing/invalid files and rewrites valid named configurations when serialization differs; valid plugin configurations remain untouched. Unknown XML content is preserved while typed values match the native reader. Production branding now shares the raw reader; its named-configuration loading lifecycle is validated separately.

Runtime tests use real PostgreSQL, four Unicode encodings, startup saves and restart. The native consumer reads and changes all eight configuration types, and candidate cold reads verify those writes. Floating-point fields are interpreted according to their declared types when reading lossless JSON evidence; Int64 values remain lossless. Raw evidence bytes are never normalized.
