# Items sorting query binding

This fixture mechanically projects 256 real frozen Jellyfin HTTP responses (128 inputs × modern and legacy endpoints), their complete recorded seed, and 128 actual ASP.NET collection-binder/GetOrderBy results. Two additional actual DLL controls prove partial directions inherit the first direction. The fixture runs without `.test-input`; the projection tool requires original evidence only when regenerating it.

`tools/project-sort-binding-native.mjs` pins original input/HTTP/stage SHA256 and verifies the independent audit. It deduplicates exact complete responses, verifies all 256 endpoint states and three recorded windows equal, and retains the complete state once. The recorded scope is eleven media tables plus UserData and four filesystem domains. Authentication setup, tokens, passwords and password hashes are excluded. Candidate authentication is generated afresh.

The native recorder's original summary remains false: its inherited status gate rejected four legitimate HTTP 400 responses. Independent audit verifies all bodies, content types, states, frozen source/DLL/input bindings, normal server exit and process/port reclamation. Original raw evidence is unchanged.

Coverage includes all thirty defined numeric ItemSortBy values, undefined signed Int32 values, overflow, nondecimal numbers, invalid names, whitespace/case, omitted/empty keys, unknown numeric directions, excess directions, and repeated keys including comma-bearing EnumConverter bitwise OR. LibraryManager tests `Descending`; repository ApplyOrder tests `Ascending`, so unknown numeric directions have different meanings. Undefined keys are ignored in memory and map to SortName in repository ordering.

Memory Random followed by distinct Name is exact because LibraryManager restarts ordering after Shuffle. Repository Random remains a primary random key; its complete DTO members and all recorded state are compared, and original permutations are retained. Every other response preserves exact item order. Only isolated ServerId is normalized.

This finite fixture does not prove every query binder, all numeric enum combinations, cultures/Unicode, cancellation/concurrency or malformed stored data. It does not establish stage acceptance. `MEDIAMANAGER_SORT_BINDING_EVIDENCE` saves complete per-database candidate responses, endpoint states and comparison reports.
