using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library.Validators;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging;

var input = File.ReadAllBytes(args[0]);
var samples = JsonSerializer.Deserialize<Sample[]>(input)!;
var results = new List<object>();
foreach (var sample in samples) {
    var calls = new List<object>(); var logs = new List<object>(); var progress = new List<double>();
    var libraries = sample.Libraries.Select((definition, index) => new Folder { Id = Id(index + 1), Name = definition.Name }).ToList();
    var root = new AggregateFolder { Id = Id(9999), Children = libraries };
    var boxes = sample.Boxes.Select((name, index) => (BaseItem)new BoxSet { Id = Id(10000 + index), Name = name! }).ToList();
    // GetItemList deserializes fresh repository entities. GetItemById owns a
    // separate cache branch, so manager mutations do not rename this cohort.
    var cachedBoxes = boxes.Select(item => new BoxSet { Id = item.Id, Name = item.Name }).ToList();
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "get_RootFolder") { if (sample.FailRoot) throw new IOException("Controlled root failure"); return root; }
        if (method.Name == "GetLibraryOptions") {
            var folder = (BaseItem)values![0]!; var index = libraries.FindIndex(value => value.Id == folder.Id);
            calls.Add(new { action = "options", folder.Name });
            return new LibraryOptions { AutomaticallyAddToCollection = sample.Libraries[index].Enabled };
        }
        if (method.Name == "GetItemList") {
            var query = (InternalItemsQuery)values![0]!;
            if (query.ParentId == Guid.Empty) {
                calls.Add(new { action = "boxsets", includeTypes = query.IncludeItemTypes, query.CollapseBoxSetItems, query.Recursive });
                if (sample.FailBoxes) throw new IOException("Controlled BoxSet selection failure"); return boxes;
            }
            var folderIndex = libraries.FindIndex(value => value.Id == query.ParentId);
            calls.Add(new { action = "movies", libraries[folderIndex].Name, query.ParentId, query.ParentType, includeTypes = query.IncludeItemTypes, query.MediaTypes,
                query.IsVirtualItem, order = query.OrderBy.Select(value => new { name = value.OrderBy.ToString(), direction = value.SortOrder.ToString() }), query.StartIndex, query.Limit, query.Recursive });
            if (sample.FailMovies) throw new IOException("Controlled Movie selection failure");
            var definitions = sample.Libraries[folderIndex].Movies;
            return definitions.Skip(query.StartIndex ?? 0).Take(query.Limit ?? int.MaxValue).Select(definition => (BaseItem)new Movie {
                Id = Id(definition.Number), Name = "Movie " + definition.Number, TmdbCollectionName = definition.Collection,
                PrimaryVersionId = definition.Primary is null ? null : Guid.Parse(definition.Primary)
            }).ToList();
        }
        return Stub.Default(method.ReturnType);
    });
    var created = 0;
    var collection = Stub.Make<ICollectionManager>((method, values) => {
        if (method.Name == "CreateCollectionAsync") {
            var options = (CollectionCreationOptions)values![0]!;
            calls.Add(new { action = "create", options.Name, options.IsLocked, options.ParentId, options.ItemIdList, options.ProviderIds, options.UserIds });
            if (options.Name == sample.FailCreate) throw new IOException("Controlled creation failure");
            if (options.Name == sample.CancelCreate) throw new OperationCanceledException("Controlled provider cancellation");
            return Task.FromResult(new BoxSet { Id = Id(20000 + created++), Name = options.Name });
        }
        if (method.Name == "AddToCollectionAsync") {
            var id = (Guid)values![0]!; var members = ((IEnumerable<Guid>)values[1]!).ToArray();
            calls.Add(new { action = "add", id, members });
            if (sample.FailAdd) throw new IOException("Controlled membership failure");
            if (sample.RenameFirstBox is not null && cachedBoxes.Count > 0) cachedBoxes[0].Name = sample.RenameFirstBox;
            return Task.CompletedTask;
        }
        return Stub.Default(method.ReturnType);
    });
    using var cancellation = new CancellationTokenSource(); if (sample.CancelInitial) cancellation.Cancel();
    Exception? failure = null;
    try {
        await new CollectionPostScanTask(library, collection, new Recorder<CollectionPostScanTask>(logs))
            .Run(new ProgressSink(value => { progress.Add(value); if (sample.FailProgressAt == progress.Count) throw new IOException("Controlled progress failure"); }), cancellation.Token);
    } catch (Exception error) { failure = error; }
    results.Add(new { sample.Name, calls, progress, logs, failure = failure is null ? null : new { type = failure.GetType().Name, failure.Message } });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(input)), actualCollectionPostScanTask = true,
    rootAndRepositoryControlled = true, collectionManagerControlled = true, candidateVerified = false,
    repositoryBoxSetsAndCachedManagerItemsAreIndependent = true,
    mediaOpened = false, portOpened = false, results
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Guid Id(int number) => Guid.Parse($"bc100000-0000-0000-0000-{number:000000000000}");
public class Sample {
    public string Name { get; set; } = "";
    public LibraryDefinition[] Libraries { get; set; } = [];
    public string?[] Boxes { get; set; } = [];
    public bool CancelInitial { get; set; }
    public bool FailRoot { get; set; }
    public bool FailMovies { get; set; }
    public bool FailBoxes { get; set; }
    public bool FailAdd { get; set; }
    public string? FailCreate { get; set; }
    public string? CancelCreate { get; set; }
    public string? RenameFirstBox { get; set; }
    public int FailProgressAt { get; set; }
}
public class LibraryDefinition {
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public MovieDefinition[] Movies { get; set; } = [];
}
public class MovieDefinition {
    public int Number { get; set; }
    public string? Collection { get; set; }
    public string? Primary { get; set; }
}
public class ProgressSink(Action<double> callback) : IProgress<double> { public void Report(double value) => callback(value); }
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class Recorder<T>(List<object> entries) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter)
        => entries.Add(new { level = level.ToString(), message = formatter(state, error), errorType = error?.GetType().Name });
}
