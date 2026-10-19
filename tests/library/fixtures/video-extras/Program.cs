using System.Reflection;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Naming.Video;
using Emby.Server.Implementations.Library.Resolvers.Movies;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;

var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var naming = new NamingOptions();
var implementation = typeof(MovieResolver).Assembly.GetType("Emby.Server.Implementations.Library.Resolvers.ExtraResolver", true)!;
var loggerType = typeof(NullLogger<>).MakeGenericType(implementation);
var logger = Activator.CreateInstance(loggerType)!;
var directoryService = Stub.Make<IDirectoryService>((method, _) => Stub.Default(method.ReturnType));
var resolver = Activator.CreateInstance(implementation, logger, naming, directoryService)!;
var tryGet = implementation.GetMethod("TryGetExtraTypeForOwner", BindingFlags.Public | BindingFlags.Instance)!;
var getResolvers = implementation.GetMethod("GetResolversForExtraType", BindingFlags.Public | BindingFlags.Instance)!;
var results = new List<object>();

foreach (var sample in input.EnumerateArray())
{
    var ownerPath = sample.GetProperty("ownerPath").GetString()!;
    var ownerDirectory = Path.GetDirectoryName(ownerPath)!;
    var owner = VideoResolver.Resolve(ownerPath, false, naming, true, ownerDirectory)!;
    var candidates = new List<object>();
    foreach (var value in sample.GetProperty("paths").EnumerateArray())
    {
        var candidatePath = value.GetString()!;
        var invocation = new object?[] { candidatePath, owner, null, null, "" };
        var valid = (bool)tryGet.Invoke(resolver, invocation)!;
        var extraType = invocation[2] is ExtraType type ? type : (ExtraType?)null;
        var rule = invocation[3] as ExtraRule;
        var resolved = VideoResolver.Resolve(candidatePath, false, naming, true, "");
        var concreteResolvers = extraType is null ? null : getResolvers.Invoke(resolver, [extraType]);
        candidates.Add(new
        {
            path = candidatePath,
            valid,
            extraType = extraType?.ToString(),
            extraTypeValue = extraType is null ? null : (int?)extraType.Value,
            ruleType = rule?.RuleType.ToString(),
            ruleToken = rule?.Token,
            resolvedName = resolved?.Name,
            resolvedYear = resolved?.Year,
            resolverTypes = concreteResolvers is Array array
                ? array.Cast<object>().Select(value => value.GetType().FullName).ToArray()
                : null
        });
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), owner = new { owner.Name, owner.Year }, candidates });
}

var sourceFiles = new[]
{
    "Emby.Naming/Common/NamingOptions.cs",
    "Emby.Naming/Video/ExtraRuleResolver.cs",
    "Emby.Naming/Video/VideoResolver.cs",
    "Emby.Server.Implementations/Library/Resolvers/ExtraResolver.cs",
    "Emby.Server.Implementations/Library/LibraryManager.cs",
    "MediaBrowser.Controller/Entities/BaseItem.cs",
    "MediaBrowser.Controller/Entities/Video.cs"
};
var assemblies = new[] { typeof(MovieResolver).Assembly, typeof(VideoResolver).Assembly }
    .DistinctBy(value => value.Location)
    .Select(assembly => new
    {
        name = assembly.GetName().Name,
        path = assembly.Location,
        sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    });
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenVideoExtraResolution = true,
    results,
    sourceFiles,
    assemblies,
    scope = "Actual frozen ExtraResolver.TryGetExtraTypeForOwner, ExtraRuleResolver and VideoResolver name/year resolution. File-system enumeration, LibraryManager.FindExtras localization/numbering, ownership selection, repository persistence and native scanning are outside this oracle."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var value = Create<T, Stub>();
        ((Stub)(object)value).Handler = handler;
        return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null
        : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
