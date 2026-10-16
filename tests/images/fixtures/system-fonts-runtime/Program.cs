// Observe the actual Jellyfin (GPL-2.0-or-later) static font selection and
// same-platform Skia font manager. This executable is validation-only.
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Drawing.Skia;
using SkiaSharp;

if (args.Length != 2) throw new ArgumentException("Oracle <input.json> <output-root>");
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Input>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
var scalars = input.Texts.SelectMany(text => text.EnumerateRunes().Select(rune => rune.Value)).Concat(input.Probes).Distinct().Order().ToArray();
object? Identity(SKTypeface? face) {
    if (face is null) return null;
    var tableHashes = new Dictionary<string, string>();
    foreach (var tag in new[] { "name", "cmap", "hmtx", "maxp" }) {
        uint value = 0; foreach (var ch in tag) value = (value << 8) | ch;
        tableHashes[tag] = Hash(face.GetTableData(value));
    }
    return new { family = face.FamilyName, postscriptName = face.PostScriptName,
        weight = face.FontWeight, width = face.FontWidth, slant = (int)face.FontSlant,
        tableHashes, glyphs = scalars.Select(codepoint => new { codepoint, glyph = face.GetGlyph(codepoint) }).ToArray(),
        coverage = input.Texts.Select(text => new { text, present = face.ContainsGlyphs(text) }).ToArray() };
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
