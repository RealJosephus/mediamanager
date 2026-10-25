using System.Globalization;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using MediaBrowser.Model.Entities;

if (args.Length != 2)
{
    throw new ArgumentException("Usage: Oracle <input.json> <native.json>");
}

var input = JsonSerializer.Deserialize<ProbeInput>(File.ReadAllText(args[0]), new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true
})
    ?? throw new InvalidOperationException("Input was null.");
var results = input.Cases.Select(Run).ToArray();
var output = new
{
    schemaVersion = 1,
    runtime = Environment.Version.ToString(),
    timezone = TimeZoneInfo.Local.Id,
    caseCount = results.Length,
    cases = results
};
File.WriteAllText(args[1], JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }));

static ProbeResult Run(ProbeCase probe)
{
    var json = "{\"Value\":" + probe.ValueJson + "}";
    return probe.Kind switch
    {
        "date" => Execute<DateModel>(probe, json, model => new
        {
            text = model.Value.ToString("O", CultureInfo.InvariantCulture),
            kind = model.Value.Kind.ToString(),
            ticks = model.Value.Ticks,
            utcText = model.Value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)
        }),
        "enum" => Execute<EnumModel>(probe, json, model => new
        {
            text = model.Value.ToString(),
            numeric = Convert.ToInt64(model.Value, CultureInfo.InvariantCulture),
            defined = Enum.IsDefined(model.Value)
        }),
        "int" => Execute<IntModel>(probe, json, model => new { value = model.Value }),
        "long" => Execute<LongModel>(probe, json, model => new { value = model.Value }),
        "double" => Execute<DoubleModel>(probe, json, model => new
        {
            text = model.Value.ToString("R", CultureInfo.InvariantCulture),
            bits = BitConverter.DoubleToInt64Bits(model.Value),
            negativeZero = model.Value == 0D && BitConverter.DoubleToInt64Bits(model.Value) < 0
        }),
        _ => throw new InvalidOperationException("Unknown kind: " + probe.Kind)
    };
}

static ProbeResult Execute<T>(ProbeCase probe, string json, Func<T, object> inspect)
{
    try
    {
        var value = JsonSerializer.Deserialize<T>(json, JsonDefaults.Options)
            ?? throw new InvalidOperationException("Deserialized model was null.");
        return new ProbeResult(probe.Id, probe.Kind, probe.ValueJson, json, true, inspect(value),
            JsonSerializer.Serialize(value, JsonDefaults.Options), null);
    }
    catch (Exception ex)
    {
        return new ProbeResult(probe.Id, probe.Kind, probe.ValueJson, json, false, null, null, Describe(ex));
    }
}

static object Describe(Exception ex) => new
{
    type = ex.GetType().FullName,
    ex.Message,
    inner = ex.InnerException is null ? null : Describe(ex.InnerException)
};

sealed record ProbeInput(ProbeCase[] Cases);
sealed record ProbeCase(string Id, string Kind, string ValueJson);
sealed record ProbeResult(string Id, string Kind, string ValueJson, string Json, bool Success, object? Value, string? Reserialized, object? Error);
sealed class DateModel { public DateTime Value { get; set; } }
sealed class EnumModel { public VideoType Value { get; set; } }
sealed class IntModel { public int Value { get; set; } }
sealed class LongModel { public long Value { get; set; } }
sealed class DoubleModel { public double Value { get; set; } }
