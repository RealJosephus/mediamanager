using MediaBrowser.Common.Plugins;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Model.MediaSegments;
using Microsoft.Extensions.DependencyInjection;

namespace MediaManager.EmbyChapterMarkers;

public sealed class Plugin : BasePlugin
{
    public Plugin(IApplicationPaths paths)
    {
        var assembly = typeof(Plugin).Assembly;
        SetAttributes(assembly.Location, Path.Combine(paths.DataPath, "EmbyChapterMarkers"), assembly.GetName().Version!);
    }

    internal const string ProviderName = "Emby Chapter Markers";
    public override string Name => ProviderName;
    public override Guid Id => new("c967be0f-173c-4478-9c4d-41fc635ca993");
    public override string Description => "Reads previously imported Emby opening and closing credit markers.";
}

public sealed class Registration : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost host)
    {
        services.AddSingleton<IMediaSegmentProvider, MarkerProvider>();
        services.AddSingleton<IMediaSegmentProvider, AnalysisProvider>();
    }
}

public class MarkerProvider : IMediaSegmentProvider
{
    public virtual string Name => Plugin.ProviderName;

    // The exchange owns these rows. Ordinary scans leave previously imported timestamps alone.
    public ValueTask<bool> Supports(BaseItem item) => ValueTask.FromResult(false);

    public Task<IReadOnlyList<MediaSegmentDto>> GetMediaSegments(MediaSegmentGenerationRequest request, CancellationToken token)
        => Task.FromResult<IReadOnlyList<MediaSegmentDto>>(request.ExistingSegments);

    public Task CleanupExtractedData(Guid itemId, CancellationToken token) => Task.CompletedTask;
}

public sealed class AnalysisProvider : MarkerProvider
{
    public override string Name => "MediaManager Intro and Credits";
}
