using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Providers;

public sealed class StackReplacementSeed
{
    public string Directory { get; set; } = "";
    public StackReplacementStep[] Steps { get; set; } = [];
}
public sealed class StackReplacementStep
{
    public string Name { get; set; } = "";
    public string[] Write { get; set; } = [];
    public string[] Delete { get; set; } = [];
    public bool RefreshBeforeScan { get; set; }
}

public static class StackReplacementRecording
{
    public static async Task<object> RunAsync(NativeScanHost host)
    {
        var seed = host.Scenario.StackReplacement!;
        var directory = host.MediaPath(seed.Directory);
        // Native top-level validation deliberately skips empty library paths.
        // Supply the first stage's real files before discovering its physical
        // parent; the non-recursive initialization does not scan those files.
        ApplyFiles(seed.Steps.First());
        await host.Manager.ValidateTopLibraryFolders(CancellationToken.None);
        var parent = host.Manager.RootFolder.Children.OfType<Folder>()
            .Single(item => host.FileSystem.AreEqual(item.Path, directory));
        var collectionType = host.Manager.GetContentType(parent)?.ToString();
        if (collectionType != "movies") throw new InvalidOperationException("Expected the actual movies library context.");
        var controls = new {
            collectionType,
            metadataServices = host.MetadataServices.Select(value => value.GetType().FullName).ToArray(),
            metadataProviders = host.MetadataProviders.Select(value => value.GetType().FullName).ToArray(),
            imageProviders = host.ImageProviders.Select(value => value.GetType().FullName).ToArray(),
            metadataSavers = host.MetadataSavers.Select(value => value.GetType().FullName).ToArray()
        };
        var stages = new List<object>();
        for (var stepIndex = 0; stepIndex < seed.Steps.Length; stepIndex++)
        {
            var step = seed.Steps[stepIndex];
            if (stepIndex > 0) ApplyFiles(step);
            host.DirectoryService.Invalidate(directory);
            string? exception = null;
            try
            {
                await host.ObserveOperationAsync(async () => {
                    if (step.RefreshBeforeScan)
                    {
                        var owner = parent.Children.OfType<Movie>().Single();
                        await owner.RefreshMetadata(Options(), CancellationToken.None);
                    }
                    await parent.ValidateChildren(new Progress<double>(), Options(), recursive: true,
                        cancellationToken: CancellationToken.None);
                });
            }
            catch (Exception error) { exception = error.ToString(); }
            stages.Add(new { step.Name, exception, sql = host.SnapshotSql(), trace = host.Trace.ToArray(),
                files = Directory.EnumerateFiles(directory).Order(StringComparer.Ordinal).Select(filename => new {
                    name = Path.GetFileName(filename),
                    sha256 = Convert.ToHexString(SHA256.HashData(System.IO.File.ReadAllBytes(filename))).ToLowerInvariant()
                }).ToArray() });
            // Preserve every preceding observation even if a later operation
            // or disposal fails. Never rewrite an old native recording.
            await System.IO.File.WriteAllTextAsync(Path.Combine(host.CaseRoot, "stack-replacement-observation.json"),
                JsonSerializer.Serialize(new { host.Scenario.Name, directory, controls, stages }, new JsonSerializerOptions { WriteIndented = true }));
        }
        await host.DisposeAsync();
        return new { host.Scenario.Name, directory, parentId = parent.Id, controls, stages,
            release = new { completed = host.DisposalCompleted, resources = host.ReleasedResources.ToArray() } };

        void ApplyFiles(StackReplacementStep step)
        {
            foreach (var name in step.Write) System.IO.File.WriteAllBytes(SourcePath(name), System.Text.Encoding.UTF8.GetBytes(name));
            foreach (var name in step.Delete) System.IO.File.Delete(SourcePath(name));
        }
        string SourcePath(string name)
        {
            if (Path.GetFileName(name) != name) throw new ArgumentException("Expected a file name.");
            return Path.Combine(directory, name);
        }
        MetadataRefreshOptions Options() => new(host.DirectoryService) {
            MetadataRefreshMode = MetadataRefreshMode.None, ImageRefreshMode = MetadataRefreshMode.None
        };
    }
}
