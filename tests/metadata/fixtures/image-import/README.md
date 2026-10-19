# Image import and save-path recording

`native.json` is the unchanged recording previously stored as
`../image-import-oracle.json`. Its dedicated directory keeps this consumer's
fixture boundary separate from unrelated metadata recordings and their runtime
inputs. The relocation does not create a new recording or alter expected paths.

`tests/metadata/image-import.test.js` consumes its 120 ImageSaver path samples,
NFO import observations and image merge observations. Fresh execution of this
consumer belongs in the cross-platform GitHub Actions validation workflow.
