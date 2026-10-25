/* MediaManager JPEG pixel bridge. Decoder and color conversion sources retain
 * their upstream licenses in source-archives/ and the accompanying notices. */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <jpeglib.h>
#include <jerror.h>
#include <skcms.h>

typedef struct {
    struct jpeg_decompress_struct decoder;
    struct jpeg_error_mgr errors;
    jmp_buf failure;
    int created;
    int succeeded;
    int decoding_rows;
    uint32_t width;
    uint32_t height;
    uint8_t *pixels;
    uint8_t *profile_bytes;
    char message[JMSG_LENGTH_MAX];
} mm_jpeg;

static void fail(j_common_ptr common) {
    mm_jpeg *image = (mm_jpeg *)common->client_data;
    common->err->format_message(common, image->message);
    longjmp(image->failure, 1);
}

static void message(j_common_ptr common, int level) {
    if (level < 0) {
        mm_jpeg *image = (mm_jpeg *)common->client_data;
        common->err->format_message(common, image->message);
    }
}

static boolean input_exhausted(j_decompress_ptr decoder) {
    decoder->src->next_input_byte = NULL;
    decoder->src->bytes_in_buffer = 0;
    return FALSE;
}

static void skip_input(j_decompress_ptr decoder, long count) {
    if (count <= 0) return;
    if ((size_t)count > decoder->src->bytes_in_buffer) ERREXIT(decoder, JERR_INPUT_EOF);
    decoder->src->next_input_byte += count;
    decoder->src->bytes_in_buffer -= (size_t)count;
}

static unsigned char multiply_255(unsigned int left, unsigned int right) {
    unsigned int value = left * right + 128;
    return (unsigned char)((value + (value >> 8)) >> 8);
}

static int profile_matches(const skcms_ICCProfile *profile, J_COLOR_SPACE color) {
    if (color == JCS_CMYK || color == JCS_YCCK)
        return profile->data_color_space == skcms_Signature_CMYK;
    if (color == JCS_GRAYSCALE)
        return profile->data_color_space == skcms_Signature_Gray || profile->data_color_space == skcms_Signature_RGB;
    return profile->data_color_space == skcms_Signature_RGB;
}

/* The numerator selects libjpeg's actual IDCT scale, rather than resizing a
 * full-resolution RGB decode. The input and output are operation-owned bytes. */
mm_jpeg *mm_jpeg_decode(const uint8_t *bytes, size_t length, unsigned int numerator) {
    mm_jpeg *image = calloc(1, sizeof(mm_jpeg));
    if (!image) return NULL;
    if (!bytes || !length || numerator < 1 || numerator > 8) {
        snprintf(image->message, sizeof(image->message), "Invalid JPEG decode input.");
        return image;
    }
    image->decoder.err = jpeg_std_error(&image->errors);
    image->errors.error_exit = fail;
    image->errors.emit_message = message;
    image->decoder.client_data = image;
    if (setjmp(image->failure)) {
        if (image->created) jpeg_destroy_decompress(&image->decoder);
        image->created = 0;
        if (image->decoding_rows && image->pixels) {
            memset(image->pixels, 0, (size_t)image->width * image->height * 4);
            image->succeeded = 1;
        }
        return image;
    }
    jpeg_create_decompress(&image->decoder);
    image->created = 1;
    jpeg_mem_src(&image->decoder, bytes, (unsigned long)length);
    // EOF suspends decoding; synthesizing an EOI would fabricate missing pixels.
    image->decoder.src->fill_input_buffer = input_exhausted;
    image->decoder.src->skip_input_data = skip_input;
    jpeg_save_markers(&image->decoder, JPEG_APP0 + 2, 0xffff);
    if (jpeg_read_header(&image->decoder, TRUE) != JPEG_HEADER_OK) goto invalid;
    image->decoder.scale_num = numerator;
    image->decoder.scale_denom = 8;
    image->decoder.dct_method = JDCT_ISLOW;
    const int cmyk = image->decoder.jpeg_color_space == JCS_CMYK || image->decoder.jpeg_color_space == JCS_YCCK;
    image->decoder.out_color_space = cmyk ? JCS_CMYK : JCS_EXT_RGBA;
    skcms_ICCProfile profile;
    unsigned int profile_length = 0;
    int transform = jpeg_read_icc_profile(&image->decoder, &image->profile_bytes, &profile_length)
        && skcms_Parse(image->profile_bytes, profile_length, &profile)
        && profile_matches(&profile, image->decoder.jpeg_color_space);
    if (!jpeg_start_decompress(&image->decoder) || image->decoder.output_components != 4) goto invalid;
    image->width = image->decoder.output_width;
    image->height = image->decoder.output_height;
    if (!image->width || !image->height || image->width > SIZE_MAX / 4 / image->height) goto invalid;
    const size_t row_bytes = (size_t)image->width * 4;
    image->pixels = calloc(1, row_bytes * image->height);
    if (!image->pixels) goto invalid;
    image->decoding_rows = 1;
    while (image->decoder.output_scanline < image->decoder.output_height) {
        JSAMPROW row = image->pixels + row_bytes * image->decoder.output_scanline;
        if (jpeg_read_scanlines(&image->decoder, &row, 1) != 1) {
            // Complete decoded rows remain available; unread rows are black.
            memset(row, 0, row_bytes * (image->height - image->decoder.output_scanline));
            break;
        }
        if (transform) {
            if (!skcms_Transform(row, skcms_PixelFormat_RGBA_8888, skcms_AlphaFormat_Unpremul, &profile,
                                 row, skcms_PixelFormat_RGBA_8888, skcms_AlphaFormat_Opaque, skcms_sRGB_profile(), image->width))
                goto invalid;
        } else if (cmyk) {
            for (uint32_t x = 0; x < image->width; x++) {
                uint8_t *pixel = row + 4 * x;
                pixel[0] = multiply_255(pixel[0], pixel[3]);
                pixel[1] = multiply_255(pixel[1], pixel[3]);
                pixel[2] = multiply_255(pixel[2], pixel[3]);
                pixel[3] = 255;
            }
        }
    }
    image->decoding_rows = 0;
    jpeg_destroy_decompress(&image->decoder);
    image->created = 0;
    image->succeeded = 1;
    return image;

invalid:
    if (!image->message[0]) snprintf(image->message, sizeof(image->message), "JPEG decoding failed.");
    if (image->created) jpeg_destroy_decompress(&image->decoder);
    image->created = 0;
    return image;
}

int mm_jpeg_succeeded(const mm_jpeg *image) { return image && image->succeeded; }
uint32_t mm_jpeg_width(const mm_jpeg *image) { return image ? image->width : 0; }
uint32_t mm_jpeg_height(const mm_jpeg *image) { return image ? image->height : 0; }
const uint8_t *mm_jpeg_pixels(const mm_jpeg *image) { return image && image->succeeded ? image->pixels : NULL; }
const char *mm_jpeg_error(const mm_jpeg *image) { return image ? image->message : "JPEG allocation failed."; }
void mm_jpeg_free(mm_jpeg *image) {
    if (!image) return;
    if (image->created) jpeg_destroy_decompress(&image->decoder);
    free(image->pixels);
    free(image->profile_bytes);
    free(image);
}
