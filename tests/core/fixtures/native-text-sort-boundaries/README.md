This fixture records the pinned native Movie and Person SortName getters and pairwise CompareInfo comparisons of their results. It includes NUL, SOH, digits, literal percent and underscore, CLR whitespace, BOM, and non-BMP characters.

The recorder executes the real loaded native assemblies without changing the designated source. The current recording uses zh-CN CurrentCulture; InvariantCulture observations are recorded separately. It does not prove every culture, arbitrary sort configuration, or a complete build input closure.

Regenerate with:

    node tools/compat/record-native-text-sort-boundaries.mjs NEW_OUTPUT_DIRECTORY ISOLATED_SOURCE_DIRECTORY DESIGNATED_SOURCE_DIRECTORY

Set MEDIAMANAGER_JELLYFIN_DLL and MEDIAMANAGER_DOTNET to the frozen native runtime and provide a new isolated output directory. The recorder retains raw output, process/build receipts, source and dependency hashes before and after execution.
