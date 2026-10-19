/* Libarchive read-only bridge. Archive bytes remain in an operation-owned Node file. */
#include <archive.h>
#include <archive_entry.h>
#include <emscripten.h>
#include <stdint.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    struct archive *archive;
    struct archive_entry *entry;
    int token;
    int64_t position;
    int64_t size;
    unsigned char buffer[65536];
} mm_archive;

EM_JS(int, mm_source_read, (int token, void *buffer, int capacity, double position), {
    return Module.archiveRead(token, buffer, capacity, position);
});

static la_ssize_t source_read(struct archive *archive, void *data, const void **buffer) {
    mm_archive *state = data;
    int count = mm_source_read(state->token, state->buffer, sizeof(state->buffer), (double)state->position);
    if (count < 0) {
        archive_set_error(archive, 5, "Archive source read failed");
        return -1;
    }
    state->position += count;
    *buffer = state->buffer;
    return count;
}

static la_int64_t source_skip(struct archive *archive, void *data, la_int64_t count) {
    (void)archive;
    mm_archive *state = data;
    if (count < 0) return 0;
    if (count > state->size - state->position) count = state->size - state->position;
    state->position += count;
    return count;
}

static la_int64_t source_seek(struct archive *archive, void *data, la_int64_t offset, int whence) {
    mm_archive *state = data;
    int64_t position = whence == SEEK_SET ? offset : whence == SEEK_CUR ? state->position + offset : state->size + offset;
    if (position < 0 || position > state->size) {
        archive_set_error(archive, 22, "Invalid archive source position");
        return -1;
    }
    state->position = position;
    return position;
}

EMSCRIPTEN_KEEPALIVE mm_archive *mm_create(int token, double size, int zip_only) {
    setlocale(LC_CTYPE, "C.UTF-8");
    mm_archive *state = calloc(1, sizeof(mm_archive));
    if (!state) return NULL;
    state->token = token;
    state->size = (int64_t)size;
    state->archive = archive_read_new();
    if (!state->archive) { free(state); return NULL; }
    archive_read_support_filter_none(state->archive);
    if (zip_only) archive_read_support_format_zip_seekable(state->archive);
    else {
        archive_read_support_format_zip_seekable(state->archive);
        archive_read_support_format_tar(state->archive);
        archive_read_support_format_rar(state->archive);
        archive_read_support_format_rar5(state->archive);
        archive_read_support_format_7zip(state->archive);
        /* Fresh Book readers match the native async selected-entry stream:
         * enumeration does not prime solid history; payloads have no CRC wrapper. */
        if (archive_read_set_format_option(state->archive, "rar5",
                "independent-entry", "1") != ARCHIVE_OK) {
            archive_read_free(state->archive);
            free(state);
            return NULL;
        }
    }
    archive_read_set_seek_callback(state->archive, source_seek);
    archive_read_set_skip_callback(state->archive, source_skip);
    archive_read_set_read_callback(state->archive, source_read);
    archive_read_set_callback_data(state->archive, state);
    return state;
}

EMSCRIPTEN_KEEPALIVE int mm_open(mm_archive *state) { return archive_read_open1(state->archive); }
/* Only the transformed RAR4 selected-entry reader enables this,
 * after mm_create and before mm_open while libarchive is in its NEW state. */
EMSCRIPTEN_KEEPALIVE int mm_rar4_independent(mm_archive *state) {
    return archive_read_set_format_option(state->archive, "rar", "jellyfin-entry-stream", "1");
}
EMSCRIPTEN_KEEPALIVE int mm_next(mm_archive *state) { return archive_read_next_header(state->archive, &state->entry); }
EMSCRIPTEN_KEEPALIVE const char *mm_key(mm_archive *state) { return archive_entry_pathname_utf8(state->entry); }
EMSCRIPTEN_KEEPALIVE double mm_size(mm_archive *state) { return (double)archive_entry_size(state->entry); }
EMSCRIPTEN_KEEPALIVE int mm_directory(mm_archive *state) { return archive_entry_filetype(state->entry) == AE_IFDIR; }
EMSCRIPTEN_KEEPALIVE int mm_read(mm_archive *state, void *buffer, int capacity) { return archive_read_data(state->archive, buffer, capacity); }
EMSCRIPTEN_KEEPALIVE int mm_skip(mm_archive *state) { return archive_read_data_skip(state->archive); }
EMSCRIPTEN_KEEPALIVE const char *mm_error(mm_archive *state) { return archive_error_string(state->archive); }
EMSCRIPTEN_KEEPALIVE const char *mm_version(void) { return archive_version_details(); }
EMSCRIPTEN_KEEPALIVE int mm_format(mm_archive *state) { return archive_format(state->archive); }
EMSCRIPTEN_KEEPALIVE double mm_header_position(mm_archive *state) { return (double)archive_read_header_position(state->archive); }
EMSCRIPTEN_KEEPALIVE void mm_free(mm_archive *state) {
    if (!state) return;
    archive_read_free(state->archive);
    free(state);
}
