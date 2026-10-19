# Frozen owned-item support oracle

The actual frozen virtual support/search getters execute for Movie, Video, Episode, Audio, AudioBook, Folder, Season, UserRootFolder, AggregateFolder and CollectionFolder. Episode source-count branches include local/group links, a primary reference and a primary cycle; the protocol and linked-version arrays are explicit controls.

This records getter behavior only, not native SQL or complete refresh acceptance. Hashes and the frozen workspace/assembly identities are sealed in `provenance.json`.
