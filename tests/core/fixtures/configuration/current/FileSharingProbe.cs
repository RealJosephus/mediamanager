using System.Text.Json;

internal static class FileSharingProbe
{
    public static object Access(string filename)
    {
        object Read()
        {
            try { return new { succeeded = true, bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }; }
            catch (Exception error) { return new { succeeded = false, error = new { type = error.GetType().Name, message = error.Message } }; }
        }
        object Write(FileShare share)
        {
            try { using var handle = File.Open(filename, FileMode.Open, FileAccess.Write, share); return new { succeeded = true }; }
            catch (Exception error) { return new { succeeded = false, error = new { type = error.GetType().Name, message = error.Message } }; }
        }
        return new { read = Read(), sharedWrite = Write(FileShare.Read), exclusiveWrite = Write(FileShare.None) };
    }

    public static void Hold(string[] args)
    {
        if (args.Length != 3 || args[2] is not ("read" or "none")) throw new ArgumentException("Expected hold-file, filename and read/none mode.");
        var filename = Path.GetFullPath(args[1]); var mode = args[2];
        using var held = File.Open(filename, FileMode.Open, FileAccess.Read, mode == "none" ? FileShare.None : FileShare.Read);
        void Send(string phase, bool inspect) {
            Console.WriteLine(JsonSerializer.Serialize(new { phase, filename, mode, pid = Environment.ProcessId, access = inspect ? Access(filename) : null }));
            Console.Out.Flush();
        }
        Send("ready", true);
        while (true) {
            var request = Console.ReadLine();
            if (request == "inspect") Send("held", true);
            else if (request == "release") break;
            else throw new InvalidOperationException("File holder requires an explicit inspect or release request.");
        }
        held.Dispose(); Send("released", false);
    }
}
