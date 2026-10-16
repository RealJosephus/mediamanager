// Test observations of Jellyfin's GPL-2.0-or-later StripCollageBuilder and SkiaEncoder.
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Drawing.Skia;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Drawing;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;

if (args.Length != 2) throw new ArgumentException("Oracle <input.json> <output-root>");
var inputBytes = File.ReadAllBytes(args[0]);
var samples = JsonSerializer.Deserialize<List<Sample>>(inputBytes)!;
var root = Path.GetFullPath(args[1]);
var assets = Path.Combine(root, "assets"); Directory.CreateDirectory(assets);
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
string Pixels(SKBitmap bitmap) {
    var pixels = new byte[bitmap.ByteCount]; Marshal.Copy(bitmap.GetPixels(), pixels, 0, pixels.Length);
    if (bitmap.ColorType == SKColorType.Bgra8888) for (var i = 0; i < pixels.Length; i += 4) (pixels[i], pixels[i + 2]) = (pixels[i + 2], pixels[i]);
    return Hash(pixels);
}
foreach (var (name, width, height, alpha) in new[] {
    ("same", 960, 540, false), ("small", 160, 90, false), ("large", 1920, 1080, false),
    ("portrait", 240, 360, false), ("wide", 960, 120, false), ("alpha", 960, 540, true),
    ("small-markers", 160, 90, false), ("portrait-markers", 240, 360, false) }) {
    using var bitmap = new SKBitmap(width, height);
    for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
        var color = name.EndsWith("-markers", StringComparison.Ordinal)
            ? new SKColor((byte)(40 + 70 * (x * 3 / width)), (byte)(40 + 70 * (y * 3 / height)), 100)
            : new SKColor((byte)(x * 17 + y * 3), (byte)(x * 5 + y * 11), (byte)(x * 7 + y * 19), alpha ? (byte)(30 + (x + y) % 226) : (byte)255);
        bitmap.SetPixel(x, y, color);
    }
    using var stream = File.Create(Path.Combine(assets, name + ".png")); bitmap.Encode(stream, SKEncodedImageFormat.Png, 90);
}
File.WriteAllText(Path.Combine(assets, "broken.png"), "Not an image");
File.WriteAllText(Path.Combine(assets, "vector.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"960\" height=\"540\"><rect width=\"960\" height=\"540\" fill=\"red\"/></svg>");
File.WriteAllBytes(Path.Combine(assets, "static.gif"), Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
Directory.CreateDirectory(Path.Combine(assets, "directory.png"));
var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name switch {
    "get_DataPath" => root, "get_CachePath" => Path.Combine(root, "cache"), "get_TempDirectory" => Path.Combine(root, "temp"), _ => Stub.Default(method.ReturnType) });
var encoder = new SkiaEncoder(NullLogger<SkiaEncoder>.Instance, paths);

var defaultFace = SkiaEncoder.DefaultTypeFace!;
var faces = ((SKTypeface?[])typeof(SkiaEncoder).GetField("_typefaces", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!).Where(face => face is not null).Cast<SKTypeface>().ToArray();
var drawText = typeof(StripCollageBuilder).GetMethod("DrawText", BindingFlags.Static | BindingFlags.NonPublic)!;
object? Layout(string? text) {
    if (string.IsNullOrWhiteSpace(text)) return null;
    using var font = new SKFont(defaultFace, 112);
    using var paint = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill, IsAntialias = true };
    var initialWidth = font.MeasureText(text);
    if (initialWidth > 960 * 0.95) font.Size = 0.9f * 960 * font.Size / initialWidth;
    var firstSize = font.Size;
    float Measure() => (float)drawText.Invoke(null, [null, 0f, 270f + font.Metrics.XHeight / 2, text, paint, font, false])!;
    var measured = Measure(); var beforeFallbackResize = measured;
    if (measured > 960 * 0.95) { font.Size = 0.9f * 960 * font.Size / measured; measured = Measure(); }
    return new { initialWidth, firstSize, beforeFallbackResize, size = font.Size, measured,
        xHeight = font.Metrics.XHeight, y = 270f + font.Metrics.XHeight / 2, padding = (960 - measured) / 2,
        direction = Regex.IsMatch(text, @"\p{IsArabic}|\p{IsArmenian}|\p{IsHebrew}|\p{IsSyriac}|\p{IsThaana}") ? "rtl" : "ltr",
        glyphFamilies = System.Globalization.StringInfo.GetTextElementEnumerator(text).AsElements()
            .Select(element => new { text = element, family = defaultFace.ContainsGlyphs(element) ? defaultFace.FamilyName : SkiaEncoder.GetFontForCharacter(element)?.FamilyName }).ToArray() };
}
var results = new List<object>();
foreach (var sample in samples) {
    var filename = Path.Combine(root, sample.Name + ".png"); Exception? failure = null;
    try { encoder.CreateImageCollage(new ImageCollageOptions { Width = 960, Height = 540, InputPaths = sample.Paths.Select(value => Path.Combine(assets, value)).ToArray(), OutputPath = filename }, sample.Text); }
    catch (Exception error) { failure = error; }
    using var bitmap = File.Exists(filename) ? SKBitmap.Decode(filename) : null;
    results.Add(new { sample, error = failure is null ? null : new { type = failure.GetType().Name, failure.Message },
        output = bitmap is null ? null : new { bitmap.Width, bitmap.Height, pixelHash = Pixels(bitmap), sha256 = Hash(File.ReadAllBytes(filename)) },
        layout = bitmap is null || sample.Name is "empty" or "invalid" ? null : Layout(sample.Text) });
}
object FontIdentity(SKTypeface face) {
    using var stream = face.OpenStream(out var collectionIndex);
    var bytes = stream is null ? null : new byte[stream.Length];
    if (bytes is not null && stream!.Read(bytes, bytes.Length) != bytes.Length) throw new IOException("Could not read the selected system font.");
    return new { face.FamilyName, face.FontWeight, face.FontWidth, face.FontSlant, collectionIndex, bytes = bytes?.Length, sha256 = bytes is null ? null : Hash(bytes) };
}
var inputs = Directory.GetFiles(assets).Order().Select(filename => new { path = "assets/" + Path.GetFileName(filename), bytes = new FileInfo(filename).Length, sha256 = Hash(File.ReadAllBytes(filename)) }).ToArray();
File.WriteAllText(Path.Combine(root, "native.json"), JsonSerializer.Serialize(new {
    actualSkiaEncoder = true, actualStripCollageBuilder = true, actualDrawTextMeasurements = true,
    inputSha256 = Hash(inputBytes),
    platform = RuntimeInformation.OSDescription, architecture = RuntimeInformation.ProcessArchitecture.ToString(),
    defaultFont = FontIdentity(defaultFace), fallbackFonts = faces.Select(FontIdentity), inputs, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count, defaultFont = defaultFace.FamilyName }));

public sealed record Sample(string Name, string[] Paths, string? Text);
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public static class TextElements {
    public static IEnumerable<string> AsElements(this System.Globalization.TextElementEnumerator enumerator) {
        while (enumerator.MoveNext()) yield return enumerator.GetTextElement();
    }
}
