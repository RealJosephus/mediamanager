using System.Text.Json;
using System.Security.Cryptography;

internal sealed class FileSharingProbe : IDisposable
{
    private readonly string filename;
    private readonly string mode;
    private readonly FileStream held;
    private readonly FileStream? deletionProbe;
    public string? DeletionProbePath { get; }

    public FileSharingProbe(string filename, string mode)
    {
        this.filename = filename;
        this.mode = mode;
        var original = mode == "delete" ? File.ReadAllBytes(filename) : null;
        held = File.Open(filename, FileMode.Open, FileAccess.Read, mode == "delete" ? FileShare.None : FileShare.Read);
        if (mode == "delete")
        {
            DeletionProbePath = filename + ".admission-probe";
            File.WriteAllBytes(DeletionProbePath, original!);
            deletionProbe = File.Open(DeletionProbePath, FileMode.Open, FileAccess.Read, FileShare.None);
        }
    }

    public object Access()
    {
        object read;
        try { read = new { succeeded = true, bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }; }
        catch (Exception error) { read = new { succeeded = false, error = new { type = error.GetType().Name, message = error.Message } }; }
        object operation;
        try
        {
            if (mode == "delete") File.Delete(DeletionProbePath!);
            // MyXmlSerializer uses this three-argument FileStream constructor.
            // Retain its actual default sharing while avoiding truncation.
            else { using var write = new FileStream(filename, FileMode.Open, FileAccess.Write); }
            operation = new { succeeded = true };
        }
        catch (Exception error) { operation = new { succeeded = false, error = new { type = error.GetType().Name, message = error.Message } }; }
        return new { read, operation };
    }

    public void Dispose()
    {
        deletionProbe?.Dispose();
        held.Dispose();
        if (DeletionProbePath is not null && File.Exists(DeletionProbePath)) File.Delete(DeletionProbePath);
    }

    public static void Hold(string[] args)
    {
        if (args.Length != 3 || args[2] is not ("write" or "delete")) throw new ArgumentException("Expected hold-file, filename and write/delete mode.");
        var filename = Path.GetFullPath(args[1]); var mode = args[2];
        using var holder = new FileSharingProbe(filename, mode);
        void Send(string phase, object? access = null)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { phase, filename, mode, pid = Environment.ProcessId,
                deletionProbePath = holder.DeletionProbePath, access }));
            Console.Out.Flush();
        }
        // Node performs its own operation probe while both real handles live.
        // In delete mode the separately held peer file preserves the original.
        Send("ready");
        while (true)
        {
            var request = Console.ReadLine();
            if (request == "inspect") Send("held");
            else if (request == "release") break;
            else throw new InvalidOperationException("File holder requires inspect or release.");
        }
        holder.Dispose();
        Send("released");
        Console.Error.WriteLine(JsonSerializer.Serialize(AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic)
            .Select(assembly => new { filename = assembly.Location,
                sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() })));
    }
}
