# Splashscreen repository selection

Nine independent input cases run the actual post-scan task and `BaseItemRepository` against EF SQLite. Only image encoding is controlled. Every BaseItems column and every image/link model column is preserved in the observations. Image IDs deliberately oppose insertion order, and two cases reverse that control to put an empty path first by ID.

The consumer selects Movie/Series items with Primary, Thumb, or Backdrop images, a parental score of 13 with null subscore, default owner/alternate exclusion, Random ascending order, and a 30-item limit. The repository loads images by image ID. The task drops null/empty first paths after the item limit; it keeps whitespace and never fills the discarded slots. A manual member's rating participates in the maximum-rating predicate; shortcut links do not. Shared presentation keys remain separate.

Random orders and bounded subsets from independent database processes are compared through eligible membership, cardinality, first-image paths, and task query/fallback effects. Random output is retained as an observation. The PostgreSQL test also selects only a single Path field from 20,000 items and 80,000 images without loading repository entities.

The original JSON/C#/project bytes, independent input hash, actual assembly identities, build/run results, and designated-source/build-copy hashes are bound in `provenance.json`. No recording claims a complete build-input closure or final release acceptance.
