# Frozen collection-membership boundary oracle

`native.json` preserves 36 actual frozen-DLL nullable string/span comparisons, 16 actual standalone-visibility comparisons using the failing library test seeds, a serialized `PhysicalLocations` alias control, and explicit root-child versus nested-folder inputs. `Oracle.cs` and `Oracle.csproj` are the exact successful source/project; their SHA-256 values and four loaded assembly hashes are bound in the fixture. The runtime was .NET 10.0.12. Native raw output and failed first run remain in `.test-input/evidence/full-v2-library-analysis-v1`.

The oracle invokes real `LibraryManager.GetCollectionFolders(item, folders)` and real entity standalone visibility. Entity lookups and the explicit root-folder list are supplied to the frozen code. It does not run a native HTTP server or actual repository `GetCachedChildren`; ParentId-scoped root selection and default binary SortName ordering are separately inferred from the pinned `UserRootFolder.LoadChildren`, `Folder.GetCachedChildren`, query Parent setter, and repository ParentId filter.

The array rows distinguish null Path from empty Path for `String.Equals`, and preserve null/empty elements for span comparison. They do not prove the separate explicit-null-array failure contract. `PhysicalLocations` is a JsonIgnore computed getter; its serialized alias is ignored by native deserialization. Ordinary Folder locations repeat its Path, while CollectionFolder/AggregateFolder expose `PhysicalLocationsList`.

These regressions do not close the full policy or root-menu contracts. Metadata-country inheritance, explicit null arrays, and the separate UserRoot/GetUserViews virtual-child expansion remain outside this matrix. Phase acceptance is false.
