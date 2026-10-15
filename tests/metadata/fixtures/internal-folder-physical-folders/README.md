# Native collection physical folder selection

Twenty-five controls invoke actual CollectionFolder.GetPhysicalFolders, ManagedFileSystem.AreEqual and LibraryManager.FindByPath/GetItemById with repository, mapper and EF SQLite. The physical-root Children array and configuration are explicit controls. Compares selected IDs/names and ordered FindByPath arguments: direct child matching, newest-row fallback, raw case/separator spellings, duplicate locations, owned/extra filtering, cached ID order/missing IDs, files, and declared NULL/empty GUID failures.

The candidate uses real SQLite/real PostgreSQL metadata contexts and repository reads. Root child sort order is seeded to reproduce the recorded array. Complete stored JSON/scalar bytes, arbitrary manager object cache mutation, filesystem resolution, ValidateChildren, monitors and release/full-library acceptance are excluded. The original recorder remains candidateVerified=false.
