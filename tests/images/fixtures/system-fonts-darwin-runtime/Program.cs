// Validation-only: draw explicit glyphs with the specified SkiaSharp build's
// actual system-selected face. No text shaping or fallback is inferred here.
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using SkiaSharp;

if (!OperatingSystem.IsMacOS()) throw new PlatformNotSupportedException("This oracle requires macOS CoreText.");
if (args.Length != 2) throw new ArgumentException("Oracle <input.json> <output-root>");
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Input>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
uint Tag(string value) => value.Aggregate(0u, (result, ch) => (result << 8) | ch);
Directory.CreateDirectory(args[1]);
var results = new List<object>();
foreach (var sample in input.Cases) {
    using var face = SKFontManager.Default.MatchCharacter(null, SKFontStyle.Bold, null, sample.Probe)
        ?? throw new InvalidOperationException("No system face for the declared probe.");
    var glyphs = sample.Codepoints.Select(codepoint => face.GetGlyph(codepoint)).ToArray();
    var positions = sample.Positions.Select(point => new SKPoint(point.X, point.Y)).ToArray();
    if (positions.Length != glyphs.Length) throw new ArgumentException("Every glyph requires one position.");
    using var font = new SKFont(face, sample.Size) { Edging = SKFontEdging.Antialias, Subpixel = true, BaselineSnap = false };
    var advances = font.GetGlyphWidths(glyphs);
    using var bitmap = new SKBitmap(new SKImageInfo(input.Width, input.Height, SKColorType.Rgba8888, SKAlphaType.Premul));
    using var canvas = new SKCanvas(bitmap);
    canvas.Clear(SKColors.Transparent);
    if (glyphs.Length > 0) {
        using var builder = new SKTextBlobBuilder();
        builder.AddPositionedRun(glyphs, font, positions);
        using var blob = builder.Build() ?? throw new InvalidOperationException("Could not create the positioned glyph run.");
        using var paint = new SKPaint { Color = SKColors.White, IsAntialias = true };
        canvas.DrawText(blob, 0, 0, paint);
    }
    canvas.Flush();
    var pixels = bitmap.Bytes;
    File.WriteAllBytes(Path.Combine(args[1], sample.Name + ".rgba"), pixels);
    using var image = SKImage.FromBitmap(bitmap);
    using var png = image.Encode(SKEncodedImageFormat.Png, 100);
    File.WriteAllBytes(Path.Combine(args[1], sample.Name + ".png"), png.ToArray());
    // SkiaSharp exposes no public CTFont handle. This independent public OS
    // readback reconstructs the native-selected PostScript name; the actual
    // Skia bitmap above separately checks that reconstruction's glyph shape.
    var namedFace = CoreText.NamedFace(face.PostScriptName);
    results.Add(new { sample, glyphs, advances, positions = sample.Positions,
        face = new { family = face.FamilyName, postscriptName = face.PostScriptName,
            weight = face.FontWeight, width = face.FontWidth, slant = (int)face.FontSlant,
            nameTableSha256 = Hash(face.GetTableData(Tag("name"))),
            outlineBytes = face.GetTableSize(Tag(input.RequiredOutlineTag)), namedFace },
        font = new { font.Size, font.Subpixel, font.BaselineSnap, edging = font.Edging.ToString(), hinting = font.Hinting.ToString() },
        output = new { width = input.Width, height = input.Height, format = "rgba-premultiplied", bytes = pixels.Length, sha256 = Hash(pixels) } });
}
File.WriteAllText(Path.Combine(args[1], "native.json"), JsonSerializer.Serialize(new {
    actualSkiaGlyphDrawing = true, platform = RuntimeInformation.OSDescription, inputSha256 = Hash(inputBytes), results
}, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count }));

public sealed record Input(int Width, int Height, string RequiredOutlineTag, Sample[] Cases);
public sealed record Sample(string Name, int Probe, int[] Codepoints, float Size, Point[] Positions);
public sealed record Point(float X, float Y);
public sealed record Variation(uint Axis, double Value);
public static class CoreText {
    const string CT = "/System/Library/Frameworks/CoreText.framework/CoreText";
    const string CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    [DllImport(CF)] static extern IntPtr CFStringCreateWithCString(IntPtr allocator, [MarshalAs(UnmanagedType.LPUTF8Str)] string value, uint encoding);
    [DllImport(CF)] static extern void CFRelease(IntPtr value);
    [DllImport(CF)] static extern nint CFDictionaryGetCount(IntPtr value);
    [DllImport(CF)] static extern void CFDictionaryGetKeysAndValues(IntPtr value, [Out] IntPtr[] keys, [Out] IntPtr[] values);
    [DllImport(CF)] [return: MarshalAs(UnmanagedType.I1)] static extern bool CFNumberGetValue(IntPtr number, int type, out double value);
    [DllImport(CF)] static extern nint CFDataGetLength(IntPtr data);
    [DllImport(CF)] static extern IntPtr CFDataGetBytePtr(IntPtr data);
    [DllImport(CT)] static extern IntPtr CTFontCreateWithName(IntPtr name, double size, IntPtr matrix);
    [DllImport(CT)] static extern IntPtr CTFontCopyVariation(IntPtr font);
    [DllImport(CT)] static extern IntPtr CTFontCopyTable(IntPtr font, uint tag, uint options);
    public static object NamedFace(string postscriptName) {
        IntPtr name = IntPtr.Zero, font = IntPtr.Zero, variation = IntPtr.Zero, table = IntPtr.Zero;
        try {
            name = CFStringCreateWithCString(IntPtr.Zero, postscriptName, 0x08000100);
            if (name == IntPtr.Zero) throw new InvalidOperationException("CoreText name allocation failed.");
            font = CTFontCreateWithName(name, 0, IntPtr.Zero);
            if (font == IntPtr.Zero) throw new InvalidOperationException("CoreText named face creation failed.");
            variation = CTFontCopyVariation(font);
            var coordinates = new List<Variation>();
            if (variation != IntPtr.Zero) {
                var count = checked((int)CFDictionaryGetCount(variation));
                var keys = new IntPtr[count]; var values = new IntPtr[count];
                if (count > 0) CFDictionaryGetKeysAndValues(variation, keys, values);
                for (var index = 0; index < count; index++) {
                    if (!CFNumberGetValue(keys[index], 13, out var axis) || !CFNumberGetValue(values[index], 13, out var value))
                        throw new InvalidOperationException("CoreText variation could not be read.");
                    coordinates.Add(new Variation(checked((uint)axis), value));
                }
            }
            table = CTFontCopyTable(font, 0x6e616d65, 0);
            if (table == IntPtr.Zero) throw new InvalidOperationException("CoreText named face has no name table.");
            var bytes = new byte[checked((int)CFDataGetLength(table))];
            Marshal.Copy(CFDataGetBytePtr(table), bytes, 0, bytes.Length);
            return new { variations = coordinates.OrderBy(value => value.Axis).ToArray(),
                nameTableSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() };
        } finally {
            if (table != IntPtr.Zero) CFRelease(table);
            if (variation != IntPtr.Zero) CFRelease(variation);
            if (font != IntPtr.Zero) CFRelease(font);
            if (name != IntPtr.Zero) CFRelease(name);
        }
    }
}
