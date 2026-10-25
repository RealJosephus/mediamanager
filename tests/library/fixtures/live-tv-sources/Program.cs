using System.Reflection;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Extensions.Json;
using Jellyfin.Api.Models.LiveTvDtos;
using Jellyfin.LiveTv.Listings;
using Jellyfin.LiveTv.TunerHosts;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var serializer = new MyXmlSerializer();
// Mirror the API's actual MVC JSON options, keeping the MVC default ignore-case binding.
var mvcOptions = new Microsoft.AspNetCore.Mvc.JsonOptions().JsonSerializerOptions;
mvcOptions.ReadCommentHandling = JsonDefaults.PascalCaseOptions.ReadCommentHandling;
mvcOptions.WriteIndented = JsonDefaults.PascalCaseOptions.WriteIndented;
mvcOptions.DefaultIgnoreCondition = JsonDefaults.PascalCaseOptions.DefaultIgnoreCondition;
mvcOptions.NumberHandling = JsonDefaults.PascalCaseOptions.NumberHandling;
mvcOptions.PropertyNamingPolicy = JsonDefaults.PascalCaseOptions.PropertyNamingPolicy;
mvcOptions.Converters.Clear();
foreach (var converter in JsonDefaults.PascalCaseOptions.Converters) mvcOptions.Converters.Add(converter);
var typedBindings = new List<object>();
foreach (var sample in input.GetProperty("bindings").EnumerateArray()) {
    object? value = null; Dictionary<string, string[]>? errors = null; string? path = null;
    var type = sample.GetProperty("type").GetString() switch { "tuner" => typeof(TunerHostInfo), "listings" => typeof(ListingsProviderInfo), _ => typeof(SetChannelMappingDto) };
    try {
        var decoded = JsonSerializer.Deserialize(sample.GetProperty("source").GetString()!, type, mvcOptions)!;
        var validation = new List<ValidationResult>();
        if (Validator.TryValidateObject(decoded, new ValidationContext(decoded), validation, true)) value = decoded;
        else errors = validation.SelectMany(result => result.MemberNames.Select(name => new { name, message = result.ErrorMessage! }))
            .GroupBy(result => result.name).ToDictionary(group => group.Key, group => group.Select(result => result.message).ToArray());
    } catch (JsonException error) { path = error.Path; }
    typedBindings.Add(new { name = sample.GetProperty("name").GetString(), value, errors, path });
}
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var root = Path.Combine(args[2], sample.GetProperty("name").GetString()!);
    var cache = Path.Combine(root, "cache"); Directory.CreateDirectory(Path.Combine(cache, "xmltv"));
    var filename = Path.Combine(root, "livetv.xml");
    var configuration = sample.GetProperty("configuration").Deserialize<LiveTvOptions>(JsonDefaults.Options)!;
    serializer.SerializeToFile(configuration, filename);
    foreach (var value in input.GetProperty("cacheFiles").EnumerateArray()) File.WriteAllText(Path.Combine(cache, value.GetString()!.Replace('/', Path.DirectorySeparatorChar)), "cache marker");
    var calls = new List<object>();
    JsonElement request = default;
    string? Failure() => request.ValueKind == JsonValueKind.Object && request.TryGetProperty("failure", out var failure) ? failure.GetString() : null;
    void Trace(string action, object? value = null) => calls.Add(new { action, value = JsonSerializer.SerializeToElement(value, options) });
    var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cache : Stub.Default(method.ReturnType));
    var config = Stub.Make<IConfigurationManager>((method, values) => {
        if (method.Name == "get_CommonApplicationPaths") return paths;
        if (method.Name == "GetConfiguration") return configuration;
        if (method.Name == "SaveConfiguration") {
            Trace("save", configuration);
            if (Failure() == "save") throw new IOException("Controlled configuration save failure.");
            serializer.SerializeToFile(configuration, filename); return null;
        }
        return Stub.Default(method.ReturnType);
    });
    var tasks = Stub.Make<ITaskManager>((method, _) => {
        if (method.Name == "CancelIfRunningAndQueue") {
            Trace("refresh"); if (Failure() == "refresh") throw new InvalidOperationException("Controlled refresh failure.");
        }
        return Stub.Default(method.ReturnType);
    });
    var tunerDefinitions = input.GetProperty("tuners").EnumerateArray().ToArray();
    var tuners = tunerDefinitions.Select(definition => new Tuner(definition, Trace, Failure)).ToArray();
    var tunerManager = new TunerHostManager(NullLogger<TunerHostManager>.Instance, config, tasks, tuners);
    var listings = input.GetProperty("listings").EnumerateArray().Select(definition => new Listings(definition, Trace, Failure)).ToArray();
    var manager = new ListingsManager(NullLogger<ListingsManager>.Instance, config, tasks, tunerManager, listings);
    var bindings = new Dictionary<string, string>();
    string? Resolve(string? value) => value is not null && value.StartsWith('@') ? bindings[value[1..]] : value;
    var observations = new List<object>();
    foreach (var operation in sample.GetProperty("operations").EnumerateArray()) {
        request = operation; calls.Clear(); object? value = null, argument = null; string? error = null;
        var kind = operation.GetProperty("operation").GetString();
        var name = operation.GetProperty("name").GetString()!;
        string? Text(string property) => operation.TryGetProperty(property, out var text) ? Resolve(text.GetString()) : null;
        bool Flag(string property) => operation.TryGetProperty(property, out var flag) && flag.GetBoolean();
        try {
            if (kind == "types") value = tunerManager.GetTunerHostTypes().ToArray();
            else if (kind == "discover") {
                var devices = new List<TunerHostInfo>(); await foreach (var device in tunerManager.DiscoverTuners(Flag("newDevicesOnly"))) devices.Add(device);
                value = devices;
            }
            else if (kind == "saveTuner") {
                var info = operation.GetProperty("info").Deserialize<TunerHostInfo>(JsonDefaults.Options)!; argument = info;
                info.Id = Resolve(info.Id); value = await tunerManager.SaveTunerHost(info, !Flag("unchanged"));
                if (operation.TryGetProperty("assignedId", out var binding)) bindings[binding.GetString()!] = ((TunerHostInfo)value).Id;
            }
            else if (kind == "deleteTuner") tunerManager.DeleteTunerHost(Text("id"));
            else if (kind == "scan") await tunerManager.ScanForTunerDeviceChanges(CancellationToken.None);
            else if (kind == "saveListings") {
                var info = operation.GetProperty("info").Deserialize<ListingsProviderInfo>(JsonDefaults.Options)!; argument = info;
                info.Id = Resolve(info.Id); value = await manager.SaveListingProvider(info, Flag("validateLogin"), Flag("validateListings"));
                if (operation.TryGetProperty("assignedId", out var binding)) bindings[binding.GetString()!] = ((ListingsProviderInfo)value).Id;
            }
            else if (kind == "deleteListings") manager.DeleteListingsProvider(Text("id"));
            else if (kind == "lineups") value = await manager.GetLineups(Text("type"), Text("id"), Text("country"), Text("location"));
            else if (kind == "mapping") value = await manager.GetChannelMappingOptions(Text("id"));
            else if (kind == "setMapping") value = await manager.SetChannelMapping(Text("id")!, Text("tunerChannelId")!, Text("providerChannelId")!);
            else if (kind == "programs") {
                var channel = operation.GetProperty("channel").Deserialize<ChannelInfo>(JsonDefaults.Options)!;
                value = (await manager.GetProgramsAsync(channel, new DateTime(2500, 1, 1, 0, 0, 0, DateTimeKind.Utc),
                    new DateTime(2500, 1, 2, 0, 0, 0, DateTimeKind.Utc), CancellationToken.None)).Select(program => new { program.Id, program.ChannelId, program.Name }).ToArray();
            }
            else if (kind == "metadata") {
                var channels = operation.GetProperty("channels").Deserialize<ChannelInfo[]>(JsonDefaults.Options)!;
                await manager.AddProviderMetadata(channels, !Flag("disableCache"), CancellationToken.None);
                value = channels.Select(channel => new { channel.Id, channel.ImageUrl }).ToArray();
            }
            else throw new InvalidOperationException("Unknown operation.");
        } catch (Exception caught) { error = caught.GetType().Name; }
        var files = input.GetProperty("cacheFiles").EnumerateArray().Select(value => new { name = value.GetString(), exists = File.Exists(Path.Combine(cache, value.GetString()!.Replace('/', Path.DirectorySeparatorChar))) });
        var disk = serializer.DeserializeFromFile(typeof(LiveTvOptions), filename);
        observations.Add(new { name, value = JsonSerializer.SerializeToElement(value, options), error,
            argument = JsonSerializer.SerializeToElement(argument, options), calls = calls.ToArray(), configuration = JsonSerializer.SerializeToElement(configuration, options),
            diskConfiguration = disk, cacheFiles = files.ToArray() });
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), bindings, observations });
}
var assemblies = new[] { typeof(TunerHostManager).Assembly, typeof(ListingsManager).Assembly, typeof(TunerHostInfo).Assembly, typeof(MyXmlSerializer).Assembly, typeof(SetChannelMappingDto).Assembly }
    .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualTunerHostManager = true, actualListingsManager = true, actualCacheFiles = true, actualXmlSerializer = true,
    controlledConfigurationSaveBoundary = true, controlledGuideQueue = true, controlledProviders = true,
    recordingExecutorsStarted = false, bindings = typedBindings, results, assemblies }, options));

public class Tuner(JsonElement source, Action<string, object?> trace, Func<string?> failure) : ITunerHost, IConfigurableTunerHost {
    public string Name => source.GetProperty("name").GetString()!;
    public string Type => source.GetProperty("type").GetString()!;
    public bool IsSupported => !source.TryGetProperty("isSupported", out var value) || value.GetBoolean();
    public Task Validate(TunerHostInfo info) {
        trace("tuner.validate", new { type = Type, info });
        if (failure() == "validate") throw new InvalidOperationException("Controlled tuner validation failure.");
        info.FriendlyName = (info.FriendlyName ?? "") + " verified"; return Task.CompletedTask;
    }
    public Task<List<ChannelInfo>> GetChannels(bool enableCache, CancellationToken cancellationToken) {
        trace("tuner.channels", new { type = Type, enableCache });
        if (source.TryGetProperty("channelsFailure", out var value) && value.GetBoolean()) throw new IOException("Controlled tuner channel failure.");
        return Task.FromResult(source.GetProperty("channels").Deserialize<List<ChannelInfo>>(JsonDefaults.Options)!);
    }
    public Task<List<TunerHostInfo>> DiscoverDevices(int duration, CancellationToken cancellationToken) {
        trace("tuner.discover", new { type = Type, duration });
        if (source.TryGetProperty("discoveryFailure", out var value) && value.GetBoolean()) throw new IOException("Controlled discovery failure.");
        return Task.FromResult(source.GetProperty("devices").Deserialize<List<TunerHostInfo>>(JsonDefaults.Options)!);
    }
    public Task<ILiveStream> GetChannelStream(string channelId, string streamId, IList<ILiveStream> currentLiveStreams, CancellationToken cancellationToken) => throw new NotSupportedException();
    public Task<List<MediaSourceInfo>> GetChannelStreamMediaSources(string channelId, CancellationToken cancellationToken) => throw new NotSupportedException();
}
public class Listings(JsonElement source, Action<string, object?> trace, Func<string?> failure) : IListingsProvider {
    public string Name => source.GetProperty("name").GetString()!;
    public string Type => source.GetProperty("type").GetString()!;
    public Task Validate(ListingsProviderInfo info, bool validateLogin, bool validateListings) {
        trace("listings.validate", new { type = Type, info, validateLogin, validateListings });
        if (failure() == "validate") throw new InvalidOperationException("Controlled listing validation failure.");
        info.Username = (info.Username ?? "") + " verified"; return Task.CompletedTask;
    }
    public Task<List<NameIdPair>> GetLineups(ListingsProviderInfo info, string country, string location) {
        trace("listings.lineups", new { type = Type, id = info?.Id, country, location });
        return Task.FromResult(new List<NameIdPair> { new() { Name = country, Id = location } });
    }
    public Task<List<ChannelInfo>> GetChannels(ListingsProviderInfo info, CancellationToken cancellationToken) {
        trace("listings.channels", new { type = Type, id = info.Id });
        if (failure() == "providerChannels") throw new IOException("Controlled listing channel failure.");
        return Task.FromResult(source.GetProperty("channels").Deserialize<List<ChannelInfo>>(JsonDefaults.Options)!);
    }
    public Task<IEnumerable<ProgramInfo>> GetProgramsAsync(ListingsProviderInfo info, string channelId, DateTime start, DateTime end, CancellationToken cancellationToken) {
        trace("listings.programs", new { type = Type, channelId });
        return Task.FromResult<IEnumerable<ProgramInfo>>(new[] { new ProgramInfo { Id = "program", Name = "Controlled program" } });
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
