# Metadata save image lifecycle

The frozen LibraryManager executes its actual saver, image update, remote conversion and repository order over real EF SQLite and files. Saver output, HTTP/file destination and image dimensions/BlurHash are explicit controls. The candidate compares exact phases, image fields, names and PNG hashes through real SQLite/PostgreSQL; this is not complete provider/network/scalar or release acceptance.
