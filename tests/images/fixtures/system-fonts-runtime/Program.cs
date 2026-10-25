// Observe the actual Jellyfin (GPL-2.0-or-later) static font selection and
// same-platform Skia font manager. This executable is validation-only.
using System.Reflection;
using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Drawing.Skia;
using SkiaSharp;
using SkiaSharp.HarfBuzz;

if (args.Length != 2) throw new ArgumentException("Oracle <input.json> <output-root>");
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Input>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
var scalars = input.Texts.SelectMany(text => text.EnumerateRunes().Select(rune => rune.Value)).Concat(input.Probes).Distinct().Order().ToArray();
string Tag(uint value) => Encoding.ASCII.GetString(new[] { (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value });
// Keep only table metadata. Neither raw fonts nor OpenStream bytes are written.
object StreamSummary(SKTypeface face) {
    try {
        using var stream = face.OpenStream(out var collectionIndex);
        if (stream is null) return new { error = "The native face has no stream." };
        using var data = SKData.Create(stream);
        if (data is null) return new { error = "The native stream could not be read." };
        var bytes = data.ToArray();
        uint UInt32(int offset) => BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, 4));
        var start = UInt32(0) == 0x74746366 ? checked((int)UInt32(12 + collectionIndex * 4)) : 0;
        var count = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(start + 4, 2));
        var tables = new List<object>();
        for (var i = 0; i < count; i++) {
            var record = start + 12 + i * 16;
            var offset = checked((int)UInt32(record + 8)); var length = checked((int)UInt32(record + 12));
            tables.Add(new { tag = Tag(UInt32(record)), offset, bytes = length,
                checksum = UInt32(record + 4).ToString("x8"), sha256 = Hash(bytes.AsSpan(offset, length)) });
        }
        return new { bytes = bytes.Length, sha256 = Hash(bytes), signature = UInt32(0).ToString("x8"), collectionIndex,
            faceSignature = UInt32(start).ToString("x8"), tables };
    } catch (Exception error) { return new { error = error.Message }; }
}
object[] TableSummaries(SKTypeface face) => face.GetTableTags().Order().Select(tag => {
    try {
        var bytes = face.GetTableSize(tag) == 0 ? Array.Empty<byte>() : face.GetTableData(tag);
        return (object)new { tag = Tag(tag), bytes = bytes.Length, sha256 = Hash(bytes) };
    } catch (Exception error) { return new { tag = Tag(tag), error = error.Message }; }
}).ToArray();
object? Identity(SKTypeface? face) {
    if (face is null) return null;
    var tableHashes = new Dictionary<string, string>();
    foreach (var tag in new[] { "name", "cmap", "hmtx", "maxp" }) {
        uint value = 0; foreach (var ch in tag) value = (value << 8) | ch;
        tableHashes[tag] = Hash(face.GetTableData(value));
    }
    return new { family = face.FamilyName, postscriptName = face.PostScriptName,
        weight = face.FontWeight, width = face.FontWidth, slant = (int)face.FontSlant,
        tableHashes, tables = TableSummaries(face), stream = StreamSummary(face),
        glyphs = scalars.Select(codepoint => new { codepoint, glyph = face.GetGlyph(codepoint) }).ToArray(),
        coverage = input.Texts.Select(text => new { text, present = face.ContainsGlyphs(text) }).ToArray(),
        shaping = input.Texts.SelectMany(text => new[] { 112f, 56.5f }.Select(size => {
            using var font = new SKFont(face, size);
            using var shaper = new SKShaper(face);
            var result = shaper.Shape(text, font);
            return new { text, size = font.Size, rawWidth = font.MeasureText(text), xHeight = font.Metrics.XHeight,
                glyphs = result.Codepoints, clusters = result.Clusters, width = result.Width,
                positions = result.Points.Select(point => new { x = point.X, y = point.Y }).ToArray() };
        })).ToArray() };
}
var defaultFace = SkiaEncoder.DefaultTypeFace;
var fallbacks = (SKTypeface?[])typeof(SkiaEncoder).GetField("_typefaces", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
var probes = input.Probes.Select(codepoint => new { codepoint,
    face = Identity(SKFontManager.Default.MatchCharacter(null, SKFontStyle.Bold, null, codepoint)) }).ToArray();
Directory.CreateDirectory(args[1]);
File.WriteAllText(Path.Combine(args[1], "native.json"), JsonSerializer.Serialize(new {
    actualSkiaEncoder = true, platform = RuntimeInformation.OSDescription, inputSha256 = Hash(inputBytes),
    defaultFace = Identity(defaultFace), probes, fallbackFaces = fallbacks.Select(Identity).ToArray()
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { probes = probes.Length, fallbackFaces = fallbacks.Length }));
public sealed record Input(int[] Probes, string[] Texts);
