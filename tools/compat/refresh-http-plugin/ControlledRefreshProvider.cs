// Diagnostic plugin for isolated native instances only; no media files or external services.
using System.Text.Json;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;

public sealed class ControlledRefreshProvider : ICustomMetadataProvider<Movie>, IHasOrder
{
    private static readonly object Gate = new();
    public string Name => "Isolated refresh lifecycle control";
    public int Order => 1000;
    public async Task<ItemUpdateType> FetchAsync(Movie item, MetadataRefreshOptions options, CancellationToken cancellationToken)
    {
        var directory = Environment.GetEnvironmentVariable("MEDIAMANAGER_NATIVE_REFRESH_CONTROL");
        if (directory is null || !item.Name.StartsWith("refresh-control-", StringComparison.Ordinal)) return ItemUpdateType.None;
        var settings = JsonSerializer.Deserialize<Settings>(File.ReadAllText(Path.Combine(directory, "control.json")))!;
        Report("started");
        try
        {
            if (settings.Block == item.Name)
                while (!File.Exists(Path.Combine(directory, "release"))) await Task.Delay(25, cancellationToken);
            if (settings.Cancel == item.Name) throw new OperationCanceledException("Controlled provider cancellation.");
            item.Overview = $"Provider updated {item.Name}";
            Report("completed");
            return ItemUpdateType.MetadataImport;
        }
        catch (OperationCanceledException) { Report("cancelled"); throw; }
        void Report(string phase)
        {
            lock (Gate) File.AppendAllText(Path.Combine(directory, "trace.jsonl"),
                JsonSerializer.Serialize(new { phase, name = item.Name, id = item.Id.ToString("N") }) + "\n");
        }
    }
    private sealed record Settings(string? Block, string? Cancel);
}
