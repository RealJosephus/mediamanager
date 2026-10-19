# Built-in Book local provider discovery order

The native helper invokes the designated CoreAppHost assembly discovery,
exported-type enumeration and GetExports<ILocalMetadataProvider<Book>> methods,
then actual ProviderManager.AddParts/GetMetadataProviders. It observes the
built-in tie order Comic Provider, EPUB Metadata, Open Packaging Format. It also
records global and per-library LocalMetadataReaderOrder overrides.

The CoreAppHost is uninitialized except the logger, actual PluginManager with
an absent/empty installed-plugin directory, and DI dependencies required for
the three real Book local provider constructors. Filesystem/logger dependencies
are controlled; no reader executes. This records actual built-in assembly/type
ordering, not complete server startup or external-plugin ordering. The oracle
does not sort or supply a manually ordered provider list.
