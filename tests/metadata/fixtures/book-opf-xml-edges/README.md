# OPF XML edges

This fresh actual OpfReader and XmlDocument recording adds twelve focused XML
observations to the unchanged Book OPF/EPUB fixture. All bytes are synthetic.
It covers entity markup and attribute rejection, first duplicate declaration,
recursive and fake CDATA declarations, internal DTD default attributes and
parameter entities, namespace errors, 140 nested elements and a 10001-character
entity. These demonstrate functional parser behavior, not arbitrary parser
library limits. Native recordings before fixes remain preserved externally.

The test binds these raw observations and their input/source bytes; the main
Book OPF/EPUB test separately verifies the same native DLL assemblies and both
designated source copies. No SQL, HTTP, generic host or release claim is made.
