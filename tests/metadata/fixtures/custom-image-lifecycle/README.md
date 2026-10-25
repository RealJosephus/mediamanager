# Custom provider image lifecycle

The native recording executes BookMetadataService, ProviderManager, LibraryManager and ItemPersistenceService with real SQLite and local image files. Custom provider operations, an independently saved pre-refresh provider and image dimensions/BlurHash are explicit controls. The candidate uses the same operations through the generic Book host, actual PostgreSQL, VFS image assets and a real image-insert failure.

Node custom providers mutate the existing `context.images` list: append, index replacement and splice removal. Reassigning the provider callback's context property and mutating the projected `item.ImageInfos` are not image-write APIs. Subsequent providers, image processing and final persistence consume the canonical list. An independent probe save followed by context reload preserves that list.

Comparisons cover provider-visible images, successful save/event prefixes, scalar metadata, final stored images and refresh timestamps for first/existing items, ordinary failure, cancellation and SQL failure. Native exception names are not a cross-runtime requirement. Photo decoding, album cover selection, remote downloads, full server execution and release acceptance are outside this fixture.
