# Current general-leaf deletion consumer

The original `README.md`, input, Native observations and provenance remain
unchanged under their recorded digests. The current consumer still compares
all 105 original scenes, complete final rows, media files, call order and
failure prefixes.

The Native oracle injects one controlled external provider with a private
marker directory. The candidate keeps that same dependency through its public
`deleteItemFiles` wrapper: record the call, inject the declared target failure,
await the real ExternalDataManager, then remove the provider marker on success.
A real manager failure preserves that marker. Production private path
calculation is not overridden.

Video internal cleanup can remove actual attachment/subtitle directories
before the external provider is invoked. Those files do not stand in for this
independent provider marker. Audio HTTP deletion tests instead create files
at the real managed paths and prove that actual attachment cleanup occurs.

Run the current test in GitHub Actions on Windows, Linux and macOS. The
original fixture seal and actual deletion results are separate checks; current
documentation changes do not rewrite the old recording or its digest.
