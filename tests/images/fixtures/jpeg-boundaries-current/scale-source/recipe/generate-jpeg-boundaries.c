/* Neutral JPEG input producer. This program is compiled and run only in the
 * dedicated Actions input-generation job, never by production image readers. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <jpeglib.h>

int main(int argc, char **argv) {
    if (argc != 4 && argc != 5) {
        fprintf(stderr, "Usage: generate-jpeg-boundaries OUTPUT rgb|cmyk|ycck progressive|sequential [ICC]\n");
        return 2;
    }
    const int rgb = strcmp(argv[2], "rgb") == 0;
    const int cmyk = strcmp(argv[2], "cmyk") == 0;
    const int ycck = strcmp(argv[2], "ycck") == 0;
    if (!rgb && !cmyk && !ycck) return 2;
    FILE *output = fopen(argv[1], "wb");
    if (!output) return 3;
    struct jpeg_compress_struct image;
    struct jpeg_error_mgr errors;
    image.err = jpeg_std_error(&errors);
    jpeg_create_compress(&image);
    jpeg_stdio_dest(&image, output);
    image.image_width = 257;
    image.image_height = 193;
    image.input_components = rgb ? 3 : 4;
    image.in_color_space = rgb ? JCS_RGB : JCS_CMYK;
    jpeg_set_defaults(&image);
    jpeg_set_colorspace(&image, rgb ? JCS_YCbCr : ycck ? JCS_YCCK : JCS_CMYK);
    jpeg_set_quality(&image, 87, TRUE);
    image.dct_method = JDCT_ISLOW;
    for (int channel = 0; channel < image.num_components; channel++) {
        image.comp_info[channel].h_samp_factor = 1;
        image.comp_info[channel].v_samp_factor = 1;
    }
    if (!rgb) image.write_Adobe_marker = TRUE;
    if (strcmp(argv[3], "progressive") == 0) jpeg_simple_progression(&image);
    else if (strcmp(argv[3], "sequential") != 0) return 2;
    jpeg_start_compress(&image, TRUE);
    if (argc == 5) {
        FILE *source = fopen(argv[4], "rb");
        if (!source || fseek(source, 0, SEEK_END) != 0) return 4;
        const long length = ftell(source);
        if (length <= 0 || fseek(source, 0, SEEK_SET) != 0) return 4;
        JOCTET *profile = malloc((size_t)length);
        if (!profile || fread(profile, 1, (size_t)length, source) != (size_t)length) return 4;
        fclose(source);
        jpeg_write_icc_profile(&image, profile, (unsigned int)length);
        free(profile);
    }
    JSAMPLE *row = malloc(image.image_width * image.input_components);
    if (!row) return 5;
    while (image.next_scanline < image.image_height) {
        for (unsigned int x = 0; x < image.image_width; x++) {
            for (int channel = 0; channel < image.input_components; channel++)
                row[x * image.input_components + channel] =
                    (JSAMPLE)((x * (17 + channel * 11) + image.next_scanline * (29 + channel * 7) + channel * 53) & 255);
        }
        JSAMPROW rows[] = { row };
        if (jpeg_write_scanlines(&image, rows, 1) != 1) return 6;
    }
    free(row);
    jpeg_finish_compress(&image);
    jpeg_destroy_compress(&image);
    return fclose(output) == 0 ? 0 : 7;
}
