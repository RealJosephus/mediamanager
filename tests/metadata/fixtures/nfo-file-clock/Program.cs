using System.Reflection;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Providers;
using MediaBrowser.XbmcMetadata.Providers;
using Microsoft.Extensions.Logging.Abstractions;

var paths = DispatchProxy.Create<IApplicationPaths, AppPaths>();
var files = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
BaseItem.FileSystem = files;
var provider = new MovieNfoProvider(NullLogger<MovieNfoProvider>.Instance, files, null!, null!, null!, null!, new DirectoryService(files));
var saved = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddTicks(5000);
var entries = new List<object>();
foreach (var (name, delta) in new[] { ("before", -1), ("exact", 0), ("after", 1) })
{
    var sidecar = Path.Combine(args[0], name + ".nfo");
    File.WriteAllText(sidecar, "<movie><title>Edited</title></movie>");
    File.SetLastWriteTimeUtc(sidecar, saved.AddMinutes(1).AddTicks(delta));
    var movie = new Movie { Path = Path.ChangeExtension(sidecar, ".mkv"), IsInMixedFolder = true, DateLastSaved = saved };
    entries.Add(new { name, saved = saved.ToString("O"), modified = File.GetLastWriteTimeUtc(sidecar).ToString("O"),
        changed = provider.HasChanged(movie, new DirectoryService(files)) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(entries));

public class AppPaths : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) =>
        method?.Name == "get_TempDirectory" ? Path.GetTempPath() : throw new NotSupportedException(method?.Name);
}
