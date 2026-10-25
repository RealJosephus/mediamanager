/* Neutral RGB JPEG inputs. Compile and run only in the dedicated Actions job. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <jpeglib.h>

static JDIMENSION dimension(const char *text) {
    char *end;
    errno = 0;
    const long value = strtol(text, &end, 10);
    if (errno || *text == '\0' || *end != '\0' || value < 1 || value > 65500) return 0;
    return (JDIMENSION)value;
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "Usage: generate-jpeg-scale-boundaries OUTPUT WIDTH HEIGHT\n");
        return 2;
    }
    const JDIMENSION width = dimension(argv[2]), height = dimension(argv[3]);
    if (!width || !height) return 2;
    FILE *output = fopen(argv[1], "wb");
    if (!output) return 3;
    struct jpeg_compress_struct image;
    struct jpeg_error_mgr errors;
    image.err = jpeg_std_error(&errors);
    jpeg_create_compress(&image);
    jpeg_stdio_dest(&image, output);
    image.image_width = width;
    image.image_height = height;
    image.input_components = 3;
    image.in_color_space = JCS_RGB;
    jpeg_set_defaults(&image);
    jpeg_set_colorspace(&image, JCS_YCbCr);
    jpeg_set_quality(&image, 87, TRUE);
    image.dct_method = JDCT_ISLOW;
    for (int channel = 0; channel < image.num_components; channel++) {
        image.comp_info[channel].h_samp_factor = 1;
        image.comp_info[channel].v_samp_factor = 1;
    }
    jpeg_start_compress(&image, TRUE);
    JSAMPLE *row = malloc((size_t)width * image.input_components);
    if (!row) return 4;
    while (image.next_scanline < image.image_height) {
        for (unsigned int x = 0; x < image.image_width; x++) {
            for (int channel = 0; channel < image.input_components; channel++)
                row[x * image.input_components + channel] =
                    (JSAMPLE)((x * (17 + channel * 11) + image.next_scanline * (29 + channel * 7) + channel * 53) & 255);
        }
        JSAMPROW rows[] = { row };
        if (jpeg_write_scanlines(&image, rows, 1) != 1) return 5;
    }
    free(row);
    jpeg_finish_compress(&image);
    jpeg_destroy_compress(&image);
    return fclose(output) == 0 ? 0 : 6;
}
