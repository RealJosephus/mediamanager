using System.Diagnostics;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Constants;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

var bytes = File.ReadAllBytes(args[0]);
var inputs = JsonDocument.Parse(bytes).RootElement;
var results = new List<object>();
var id = Guid.Parse("981f0000-0000-0000-0000-000000000001");
var user = new User("Detail reader", "reader", "reader") { Id = Guid.Parse("981f0000-0000-0000-0000-000000000002") };
foreach (var input in inputs.EnumerateArray())
{
    var phases = new List<object>();
    var name = input.GetProperty("name").GetString()!;
    var behavior = input.TryGetProperty("behavior", out var mode) ? mode.GetString() : null;
    var clock = DateTime.UtcNow;
    BaseItem item = input.GetProperty("type").GetString() == "Person" ? new Person() : new Movie();
    item.Id = id; item.Name = name;
    item.Overview = input.TryGetProperty("overview", out var overview) ? overview.GetString() : null;
    item.DateLastRefreshed = input.TryGetProperty("minimumDate", out _) ? DateTime.MinValue
        : clock.AddSeconds(-input.GetProperty("ageSeconds").GetInt32());
    if (input.TryGetProperty("primary", out var primary) && primary.GetBoolean())
        item.ImageInfos = [new ItemImageInfo { Type = ImageType.Primary, Path = "controlled-primary.jpg" }];
    using var aborted = new CancellationTokenSource();
    var provider = Boundary.Make<IProviderManager>((method, values) =>
    {
        if (method.Name == "RefreshSingleItem") return Refresh((MetadataRefreshOptions)values![1]!, (CancellationToken)values[2]!);
        if (method.Name == "QueueRefresh")
        {
            phases.Add(new { phase = "queued", options = Options((MetadataRefreshOptions)values![1]!), priority = (int)(RefreshPriority)values[2]! });
            return null;
        }
        throw new InvalidOperationException("Unexpected provider method: " + method.Name);
    });
    BaseItem.ProviderManager = provider;
    var fileSystem = Boundary.Make<IFileSystem>((method, _) => Boundary.Default(method.ReturnType));
    BaseItem.FileSystem = fileSystem;
    var users = Boundary.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : throw new InvalidOperationException(method.Name));
    var library = Boundary.Make<ILibraryManager>((method, _) => method.Name == "GetItemById" ? item : throw new InvalidOperationException(method.Name));
    var dto = Boundary.Make<IDtoService>((method, values) =>
    {
        if (method.Name != "GetBaseItemDto") throw new InvalidOperationException(method.Name);
        phases.Add(new { phase = "dto" });
        return new BaseItemDto { Id = id, Overview = item.Overview };
    });
    var controller = new UserLibraryController(users, null!, library, dto, null!, fileSystem, provider)
    {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            RequestAborted = aborted.Token,
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(InternalClaimTypes.UserId, user.Id.ToString("N"))], "controlled"))
        } }
    };
    string? error = null, responseOverview = null;
    var watch = Stopwatch.StartNew();
    try { responseOverview = (await controller.GetItem(user.Id, id)).Value?.Overview; }
    catch (OperationCanceledException) { error = "cancelled"; }
    catch (InvalidOperationException ex) when (ex.Message == "Controlled provider failure.") { error = "provider failure"; }
    results.Add(new { name, phases, error, overview = item.Overview, responseOverview, elapsedMilliseconds = watch.Elapsed.TotalMilliseconds });

    async Task<ItemUpdateType> Refresh(MetadataRefreshOptions options, CancellationToken token)
    {
        phases.Add(new { phase = "refresh", options = Options(options), cancellable = token.CanBeCanceled });
        try
        {
            if (behavior == "failure") throw new InvalidOperationException("Controlled provider failure.");
            if (behavior == "cancel") throw new OperationCanceledException("Controlled provider cancellation.");
            if (behavior == "request-cancel") aborted.CancelAfter(25);
            if (behavior is "timeout" or "request-cancel") await Task.Delay(Timeout.Infinite, token);
            item.Overview = "Refreshed details";
            phases.Add(new { phase = "completed" });
            return ItemUpdateType.MetadataImport;
        }
        catch (OperationCanceledException) { phases.Add(new { phase = "cancelled" }); throw; }
    }
}
var assemblies = new[] { typeof(UserLibraryController).Assembly, typeof(BaseItem).Assembly, Assembly.Load("jellyfin") }
    .Distinct().Select(assembly => new { assembly.FullName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualControllerExecution = true, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), results, assemblies,
    scope = "Actual UserLibraryController.GetItem and BaseItem.RefreshMetadata. User/library lookup, DTO projection and provider boundaries are controlled. Verifies refresh admission, options, completion ordering, cancellation and priority; not real provider persistence or full HTTP binding."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static object Options(MetadataRefreshOptions value) => new {
    MetadataRefreshMode = value.MetadataRefreshMode.ToString(), ImageRefreshMode = value.ImageRefreshMode.ToString(), value.ForceSave
};
public class Boundary : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var proxy = Create<T, Boundary>(); ((Boundary)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
