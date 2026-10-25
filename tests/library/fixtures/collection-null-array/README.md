# Collection null-array boundary fixture

72 actual frozen-DLL cases compare constructor and actual JSON deserialization for CollectionFolder, AggregateFolder and ordinary Folder: omitted, empty and explicit-null PhysicalLocationsList under four path pairs. Native readbacks preserve both instance list and computed PhysicalLocations, every outcome and native exception stack.

Explicit null reaches ArgumentNullException(source) only after Path equality fails; equal paths, both-null Path and ordinary Folder controls avoid the list access. Raw failed compile/native-host-binding attempts and final native-v3 source/provenance remain in `.test-input/evidence/collection-null-array-native-v1`. Assembly hashes match the frozen reference.

The dual-database test loads mechanical raw input through the real library mapper and invokes the actual membership helper. It compares typed-domain type/message/parameter markers; it does not claim HTTP error equivalence, UserRoot cached/virtual-child loading or whole policy acceptance. `phaseAcceptance` is false.
