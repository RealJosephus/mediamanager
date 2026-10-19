# Same-platform EPUB providers

The input retains all 38 EPUB cases and the 37 original archive byte streams from
the historical `book-opf-epub` fixture. That fixture and its provenance remain
unchanged. The new manifest binds each copied input by size and SHA-256.

`Program.cs` executes the designated current native EPUB metadata and image
providers on the runner's own OS. It copies verified inputs into a new isolated
directory, creates the original directory control, captures errors and fields,
and disposes each returned image stream. The test binds the current build and
compares the actual candidate archive reader through independent media and
metadata stores. Archive keys follow native host path rules; media identity
mapping remains independent of the host OS.

This consumer declares UTC in its input manifest. Its isolated Node test
process passes UTC to the oracle, and both hosts record and check the actual
offset for the rich archive's date, `2024-03-02T23:04:05Z`. Windows .NET reads
the system time zone independently of `TZ`; an incompatible host fails
explicitly. The parent strict runner's environment is unchanged. This aligns
the test input; production date parsing continues to use the Node process
time zone and the original metadata date comparisons remain exact.

The original rich archive uses Windows-style archive keys, so its metadata is
not read by the native EPUB provider on POSIX. All 37 original archive byte
streams and all 38 original provider cases remain unchanged, with their full
existing comparisons.

This is provider evidence. The separate Book/Photo global scan suite covers the
database and global scan lifecycle. Neither suite is final release acceptance.
