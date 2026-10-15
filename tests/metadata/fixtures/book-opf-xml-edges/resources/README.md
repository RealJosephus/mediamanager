# OPF XML resource boundaries

Nine fresh actual XmlDocument.Load(Stream) and OpfReader observations confirm
the default cumulative MaxCharactersFromEntities budget of 10000000 UTF-16
characters. A single entity at the bound is allowed, the next character is
rejected, and nested entity replacement text also consumes the same budget.
Literal document text does not consume that entity budget. Chains of 300 and
2048 nonrecursive entities succeed; self and mutual cycles throw XmlException.

Returned titles compare UTF-16 length and UTF-8 SHA256, avoiding a large raw
metadata projection. Exact synthetic native input files are stored as gzip
transport assets to keep the fixture small; tests decompress and check every
raw SHA against the unchanged actual-native recording before parsing. Gzip
here is fixture transport only and makes no archive-provider acceptance claim.
The same designated source assemblies are verified by the main Book fixture.
No execution-time, thread, CLR representation, SQL or release claim is made.
