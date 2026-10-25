// Validation-only native detector and mechanical model constant exporter.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using UtfUnknown;
using UtfUnknown.Core;
using UtfUnknown.Core.Models;
using UtfUnknown.Core.Probers;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var input = JsonDocument.Parse(File.ReadAllBytes(args[0])).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true };
var assembly = typeof(CharsetDetector).Assembly;
var singleProbers = (CharsetProber[])Field(new SBCSGroupProber(), "probers")!;
var multiProbers = (CharsetProber[])Field(new MBCSGroupProber(), "probers")!;
var matrices = new Dictionary<string, string>();
var sequences = singleProbers.Select(prober =>
{
    if (prober is HebrewProber) return (object)new { kind = "Hebrew" };
    var model = (SequenceModel)Field(prober, "model")!;
    var matrix = Enumerable.Range(0, model.FreqCharCount * model.FreqCharCount)
        .Select(model.GetPrecedence).ToArray();
    var key = Convert.ToHexStringLower(SHA256.HashData(matrix));
    matrices.TryAdd(key, Convert.ToBase64String(matrix));
    return new { kind = "SingleByte", model = model.GetType().Name, name = model.CharsetName,
        orders = Convert.ToBase64String(Enumerable.Range(0, 256).Select(i => model.GetOrder((byte)i)).ToArray()),
        matrix = key, count = model.FreqCharCount, ratio = model.TypicalPositiveRatio,
        keepEnglishLetter = model.KeepEnglishLetter, reversed = (bool)Field(prober, "reversed")!,
        hebrew = Field(prober, "nameProber") != null };
}).ToArray();
var multibyte = multiProbers.Select(prober =>
{
    var machine = Field(prober, "codingSM")!;
    var model = (StateMachineModel)Field(machine, "model")!;
    var analyser = Field(prober, "distributionAnalyser") ?? Field(prober, "analyser");
    return new { kind = prober.GetType().Name, name = prober.GetCharsetName(), machine = ExportMachine(model),
        distribution = analyser == null ? null : new {
            orders = (int[])Field(analyser, "charToFreqOrder")!, ratio = (float)Field(analyser, "typicalDistributionRatio")! } };
}).ToArray();
var escape = ((CodingStateMachine[])Field(new EscCharsetProber(), "codingSM")!)
    .Select(machine => ExportMachine((StateMachineModel)Field(machine, "model")!)).ToArray();
var japanese = (byte[,])Field(null, "jp2CharContext", assembly.GetType("UtfUnknown.Core.Analyzers.Japanese.JapaneseContextAnalyser")!)!;
var japaneseBytes = new byte[japanese.Length];
Buffer.BlockCopy(japanese, 0, japaneseBytes, 0, japaneseBytes.Length);
var latin = typeof(Latin1Prober);
var names = assembly.GetType("UtfUnknown.Core.CodepageName")!.GetFields(BindingFlags.Static | BindingFlags.NonPublic)
    .Where(field => field.IsLiteral).Select(field => (string)field.GetRawConstantValue()!).Distinct().ToArray();
var encodings = names.ToDictionary(name => name, name => new DetectionDetail(name, 0).Encoding?.WebName);
var tables = new { schemaVersion = 1, upstream = "UTF.Unknown/2.7.0", sequences, matrices, multibyte, escape,
    japaneseContext = Convert.ToBase64String(japaneseBytes), japaneseWidth = japanese.GetLength(1),
    latinClasses = Convert.ToBase64String((byte[])Field(null, "Latin1_CharToClass", latin)!),
    latinModel = Convert.ToBase64String((byte[])Field(null, "Latin1ClassModel", latin)!), encodings };
File.WriteAllText(args[2], JsonSerializer.Serialize(tables, json) + "\n", new UTF8Encoding(false));

var samples = new List<object>();
var repetitions = input.GetProperty("repetitions").EnumerateArray().Select(v => v.GetInt32()).ToArray();
var prefixes = input.GetProperty("prefixLengths").EnumerateArray().Select(v => v.GetInt32()).ToArray();
foreach (var language in input.GetProperty("languages").EnumerateArray())
foreach (var label in language.GetProperty("encodings").EnumerateArray())
{
    var encoding = Encoding.GetEncoding(label.GetString()!);
    foreach (var repeat in repetitions)
    foreach (var prefix in prefixes)
    {
        var text = new string('a', prefix) + string.Concat(Enumerable.Repeat(language.GetProperty("text").GetString(), repeat));
        Add($"{language.GetProperty("name").GetString()}-{label.GetString()}-{repeat}-{prefix}", encoding.GetBytes(text));
    }
}
foreach (var value in input.GetProperty("hexCases").EnumerateArray())
    Add(value.GetProperty("name").GetString()!, Convert.FromHexString(value.GetProperty("hex").GetString()!));
if (input.GetProperty("singleBytes").GetBoolean())
    for (var b = 0; b <= 255; b++) Add($"single-byte-{b:x2}", [(byte)b]);
var lengths = input.GetProperty("randomLengths").EnumerateArray().Select(v => v.GetInt32()).ToArray();
for (var index = 0; index < input.GetProperty("randomCases").GetInt32(); index++)
{
    var bytes = new byte[lengths[index % lengths.Length]];
    for (var offset = 0; offset < bytes.Length; offset += 32)
    {
        var hash = SHA256.HashData(Encoding.ASCII.GetBytes($"neutral-charset-{index}-{offset}"));
        hash.AsSpan(0, Math.Min(32, bytes.Length - offset)).CopyTo(bytes.AsSpan(offset));
    }
    Add($"binary-{index}-{bytes.Length}", bytes);
}
var loaded = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
    .Select(a => new { name = a.GetName().Name, path = a.Location,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { schemaVersion = 1, samples, loadedAssemblies = loaded }, json) + "\n", new UTF8Encoding(false));

void Add(string name, byte[] bytes) => samples.Add(new { name, bytes = Convert.ToBase64String(bytes),
    buffer = Detect(() => CharsetDetector.DetectFromBytes(bytes)),
    stream = Detect(() => CharsetDetector.DetectFromStream(new MemoryStream(bytes))) });

object Detect(Func<DetectionResult> callback)
{
    try
    {
        var result = callback();
        return new { details = result.Details?.Select(detail => new { name = detail.EncodingName,
            confidence = detail.Confidence, confidenceBits = BitConverter.SingleToUInt32Bits(detail.Confidence),
            encoding = detail.Encoding?.WebName, bom = detail.HasBOM }).ToArray(), error = (string?)null };
    }
    catch (Exception error) { return new { details = (object?)null, error = error.GetType().FullName }; }
}

object ExportMachine(StateMachineModel model) => new { name = model.Name, factor = model.ClassFactor,
    classes = Enumerable.Range(0, 256).Select(i => model.GetClass((byte)i)).ToArray(),
    states = Enumerable.Range(0, ((int[])Field(model.stateTable, "data")!).Length << (int)Field(model.stateTable, "indexShift")!)
        .Select(model.stateTable.Unpack).ToArray(), lengths = model.charLenTable };

static object? Field(object? target, string name, Type? type = null)
{
    for (var current = type ?? target!.GetType(); current != null; current = current.BaseType)
    {
        var field = current.GetField(name, BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        if (field != null) return field.GetValue(target);
    }
    return null;
}
