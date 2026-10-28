// EosHelper — what Eos needs from Windows that Node can't reach:
//   protect | unprotect   DPAPI (this user) — plaintext / base64 on stdin → stdout
//   trash <path>          move to the Recycle Bin
//   keep-awake <pid>      hold off system sleep until <pid> exits (or this is killed)
//   location <timeoutS>   one fix as JSON, same shape as the macOS helper:
//                         {"lat","lon","accuracy","at"} | {"error","message"}
// Exit code 0 = done; non-zero with a message on stderr.

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Windows.Devices.Geolocation;

namespace EosHelper;

internal static partial class Program
{
    private static int Main(string[] args)
    {
        try
        {
            return args.FirstOrDefault() switch
            {
                "protect" => Protect(),
                "unprotect" => Unprotect(),
                "trash" when args.Length == 2 => Trash(args[1]),
                "keep-awake" when args.Length == 2 && int.TryParse(args[1], out var pid) => KeepAwake(pid),
                "location" => Location(args.Length > 1 && int.TryParse(args[1], out var t) ? t : 25),
                _ => Usage(),
            };
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    private static int Usage()
    {
        Console.Error.WriteLine("usage: EosHelper protect|unprotect|trash <path>|keep-awake <pid>|location [timeoutS]");
        return 2;
    }

    private static int Protect()
    {
        var plain = Encoding.UTF8.GetBytes(Console.In.ReadToEnd());
        Console.Out.Write(Convert.ToBase64String(ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser)));
        return 0;
    }

    private static int Unprotect()
    {
        var sealedBytes = Convert.FromBase64String(Console.In.ReadToEnd().Trim());
        Console.Out.Write(Encoding.UTF8.GetString(ProtectedData.Unprotect(sealedBytes, null, DataProtectionScope.CurrentUser)));
        return 0;
    }

    // ---- Recycle Bin -------------------------------------------------------

    private const uint FO_DELETE = 3;
    private const ushort FOF_SILENT = 0x0004, FOF_NOCONFIRMATION = 0x0010, FOF_ALLOWUNDO = 0x0040, FOF_NOERRORUI = 0x0400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public IntPtr pFrom;
        public IntPtr pTo;
        public ushort fFlags;
        public int fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public IntPtr lpszProgressTitle;
    }

    [LibraryImport("shell32.dll", EntryPoint = "SHFileOperationW")]
    private static partial int SHFileOperation(ref SHFILEOPSTRUCT op);

    private static int Trash(string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full) && !Directory.Exists(full)) throw new FileNotFoundException($"not found: {full}");
        // pFrom is a double-null-terminated list.
        var from = Marshal.StringToHGlobalUni(full + "\0");
        try
        {
            var op = new SHFILEOPSTRUCT
            {
                wFunc = FO_DELETE,
                pFrom = from,
                fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            };
            var rc = SHFileOperation(ref op);
            if (rc != 0 || op.fAnyOperationsAborted != 0) throw new IOException($"Recycle Bin move failed (0x{rc:x})");
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(from);
        }
    }

    // ---- Keep awake --------------------------------------------------------

    private const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;

    [LibraryImport("kernel32.dll")]
    private static partial uint SetThreadExecutionState(uint flags);

    private static int KeepAwake(int pid)
    {
        using var owner = Process.GetProcessById(pid);
        if (SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0) throw new InvalidOperationException("SetThreadExecutionState failed");
        owner.WaitForExit();
        return 0;
    }

    // ---- Location ----------------------------------------------------------

    private static int Location(int timeoutS)
    {
        Console.Out.WriteLine(LocateAsync(TimeSpan.FromSeconds(timeoutS)).GetAwaiter().GetResult());
        return 0;
    }

    private static string Error(string code, string message) =>
        $"{{\"error\":\"{code}\",\"message\":\"{message.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"}}";

    private static async Task<string> LocateAsync(TimeSpan timeout)
    {
        var access = await Geolocator.RequestAccessAsync();
        if (access == GeolocationAccessStatus.Denied) return Error("denied", "location access is off for desktop apps (Settings › Privacy & security › Location)");
        if (access != GeolocationAccessStatus.Allowed) return Error("unavailable", "location access is unavailable");
        try
        {
            var locator = new Geolocator { DesiredAccuracy = PositionAccuracy.Default };
            var pos = await locator.GetGeopositionAsync(TimeSpan.FromMinutes(5), timeout);
            var c = pos.Coordinate;
            var at = c.Timestamp.ToUnixTimeMilliseconds();
            return FormattableString.Invariant($"{{\"lat\":{c.Point.Position.Latitude},\"lon\":{c.Point.Position.Longitude},\"accuracy\":{c.Accuracy},\"at\":{at}}}");
        }
        catch (Exception e) when (e is TimeoutException || (uint)e.HResult == 0x800705B4)
        {
            return Error("timeout", "no fix in time");
        }
        catch (Exception e) when ((uint)e.HResult == 0x80070422)
        {
            return Error("disabled", "location services are off");
        }
    }
}
