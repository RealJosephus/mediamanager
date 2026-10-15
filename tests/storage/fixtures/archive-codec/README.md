# Archive codec attribution and package provenance

This wrapper is consumed by the archive-codec-provenance test. It binds four
actual resource manifests and every packaged local file they declare. The
literal wrapper URL lets the existing validation inventory discover those
manifests and recursively bind their required external source/build inputs.

The test reads the manifests and inputs, checks exact license source slices
against the distributed bundle, verifies final link-map/library/runtime source
coverage and published payload hashes, and checks the portable builder source
manifest. It does not reproduce decoder algorithms, run a build, start services
or claim protocol, native differential or release acceptance.
