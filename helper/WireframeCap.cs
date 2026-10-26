// wireframe-cap: long-running capture helper for the Wireframe panel.
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id":1,"cmd":"ping"}
//   {"id":2,"cmd":"find"}                                   -> AE main window: hwnd, rect, size, dpi
//   {"id":3,"cmd":"grab","rect":[x,y,w,h],"out":"C:/a.png"} -> one capture (rect/out optional)
//   {"id":4,"cmd":"grabStable","rect":[...],"out":"...","prevHash":"...","stableMs":300,...}
//   {"id":5,"cmd":"measure","prevHash":"..."}               -> stable grab + locate marker: comp, viewer rects
//   {"id":6,"cmd":"measureFile","path":"C:/a.png"}          -> same analysis on a saved image
//   {"id":7,"cmd":"overlay","text":"Frame 3/100"}            -> progress box over AE ({"hide":true} to hide)
//   {"cmd":"sendKey","char":"'","shift":true}             -> press a shortcut in AE (AE must be active)
//   {"cmd":"resizeWindow","sizes":[fromW,fromH,toW,toH]}  -> resize the extension window whose client
//                                                           area is from (CSS px) to to, kept on screen
//   {"id":8,"cmd":"cancelState"} / {"cmd":"cancel"} / {"cmd":"resetCancel"}
//                                                           -> cancel flag (also set by the box's button / Esc in AE)
//   {"id":9,"cmd":"quit"}
// Every reply includes "cancel": true once the user asked to cancel.
// Rects are relative to the window bitmap (same space as GetWindowRect, invisible borders included).
// Built with the .NET Framework 4 csc.exe that ships with Windows (C# 5: no interpolation, no ?.).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class Native
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    public const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    // ---- key presses (sendKeys) ----
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    public const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 2;
    public const ushort VK_LSHIFT = 0xA0, VK_LCONTROL = 0xA2, VK_LMENU = 0xA4;
    public const uint MAPVK_VK_TO_VSC = 0;
    [DllImport("user32.dll")] public static extern uint MapVirtualKeyExW(uint code, uint mapType, IntPtr hkl);

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern short VkKeyScanExW(char ch, IntPtr hkl);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    public const int VK_ESCAPE = 0x1B;
    public const uint GA_ROOTOWNER = 3;

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
        public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant;
    }

    public const uint PW_RENDERFULLCONTENT = 2;
    public const uint GW_OWNER = 4;
}

// A top-down 32bpp DIB section that PrintWindow draws into. Reused while the window size stays the same.
class Surface : IDisposable
{
    public readonly int Width, Height, Stride;
    public readonly IntPtr Bits;
    readonly IntPtr dc, bmp, old;

    public Surface(int w, int h)
    {
        Width = w; Height = h; Stride = w * 4;
        var bi = new Native.BITMAPINFOHEADER();
        bi.biSize = (uint)Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
        bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
        IntPtr screen = Native.GetDC(IntPtr.Zero);
        dc = Native.CreateCompatibleDC(screen);
        Native.ReleaseDC(IntPtr.Zero, screen);
        IntPtr bits;
        bmp = Native.CreateDIBSection(dc, ref bi, 0, out bits, IntPtr.Zero, 0);
        if (bmp == IntPtr.Zero) { Native.DeleteDC(dc); throw new Exception("CreateDIBSection failed"); }
        Bits = bits;
        old = Native.SelectObject(dc, bmp);
    }

    public void Capture(IntPtr hwnd)
    {
        if (!Native.PrintWindow(hwnd, dc, Native.PW_RENDERFULLCONTENT)) throw new Exception("PrintWindow failed");
    }

    // FNV-1a 64 over 32-bit pixels (alpha byte masked) inside the rect.
    public unsafe string Hash(Rectangle r)
    {
        ulong h = 14695981039346656037UL;
        for (int y = r.Top; y < r.Bottom; y++)
        {
            uint* p = (uint*)((byte*)Bits + (long)y * Stride) + r.Left;
            for (int x = 0; x < r.Width; x++) { h ^= p[x] & 0xFFFFFFu; h *= 1099511628211UL; }
        }
        return h.ToString("x16");
    }

    // Copies the rect out as an independent 24bpp bitmap.
    public Bitmap Copy(Rectangle r)
    {
        using (var view = new Bitmap(Width, Height, Stride, PixelFormat.Format32bppRgb, Bits))
            return view.Clone(r, PixelFormat.Format24bppRgb);
    }

    public void Dispose()
    {
        Native.SelectObject(dc, old);
        Native.DeleteObject(bmp);
        Native.DeleteDC(dc);
    }
}

class AeWindow
{
    public IntPtr Hwnd;
    public string Title;
    public Native.RECT Rect;
    public int Width { get { return Rect.Right - Rect.Left; } }
    public int Height { get { return Rect.Bottom - Rect.Top; } }
}

class Program
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static IntPtr currentHwnd = IntPtr.Zero;

    // Set by the overlay's Cancel button or Esc pressed while AE is the active app.
    public static volatile bool CancelRequested;

    static void PollEscape()
    {
        if ((Native.GetAsyncKeyState(Native.VK_ESCAPE) & 0x8000) == 0 || currentHwnd == IntPtr.Zero) return;
        var fg = Native.GetForegroundWindow();
        if (fg != IntPtr.Zero && Native.GetAncestor(fg, Native.GA_ROOTOWNER) == currentHwnd) CancelRequested = true;
    }

    static int Main(string[] args)
    {
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } // per-monitor v2: real pixels
        catch { try { Native.SetProcessDPIAware(); } catch { } }

        var utf8 = new UTF8Encoding(false);
        var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8);
        stdout.AutoFlush = true;

        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            object id = null;
            Dictionary<string, object> reply;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                req.TryGetValue("id", out id);
                string cmd = Str(req, "cmd", "");
                if (cmd == "quit") { stdout.WriteLine(Json.Serialize(Ok(id))); return 0; }
                reply = Handle(cmd, req);
            }
            catch (Exception ex)
            {
                reply = new Dictionary<string, object>();
                reply["ok"] = false;
                reply["error"] = ex.Message;
            }
            reply["id"] = id;
            PollEscape();
            if (CancelRequested) reply["cancel"] = true;
            stdout.WriteLine(Json.Serialize(reply));
        }
        return 0;
    }

    static Dictionary<string, object> Handle(string cmd, Dictionary<string, object> req)
    {
        switch (cmd)
        {
            case "ping":
                var r = Ok(null);
                r["version"] = "0.2.0";
                r["pid"] = Process.GetCurrentProcess().Id;
                return r;
            case "find": return Find(req);
            case "grab": return Grab(req);
            case "grabStable": return GrabStable(req);
            case "measure": return Measure(req);
            case "measureFile": return MeasureFile(req);
            case "overlay":
                if (req.ContainsKey("hide") && Convert.ToBoolean(req["hide"])) Overlay.Hide();
                else
                {
                    Native.RECT wr;
                    Native.GetWindowRect(Target(req), out wr);
                    Overlay.Show(Str(req, "text", ""), wr);
                }
                return Ok(null);
            case "sendKey": return SendKey(req);
            case "resizeWindow": return ResizeWindow(req);
            case "cancelState": return Ok(null); // "cancel" is added to every reply
            case "cancel":
                CancelRequested = true;
                return Ok(null);
            case "resetCancel":
                CancelRequested = false;
                return Ok(null);
            default: throw new Exception("unknown cmd: " + cmd);
        }
    }

    // ---- window lookup -------------------------------------------------------------------

    static List<AeWindow> AeWindows()
    {
        var pids = new HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("AfterFX")) pids.Add((uint)p.Id);
        var list = new List<AeWindow>();
        Native.EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint pid;
            if (!Native.IsWindowVisible(h)) return true;
            if (Native.GetWindow(h, Native.GW_OWNER) != IntPtr.Zero) return true; // dialogs, floating panels
            Native.GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid)) return true;
            var w = new AeWindow { Hwnd = h };
            Native.GetWindowRect(h, out w.Rect);
            var sb = new StringBuilder(512);
            Native.GetWindowText(h, sb, 512);
            w.Title = sb.ToString();
            list.Add(w);
            return true;
        }, IntPtr.Zero);
        list.Sort(delegate (AeWindow a, AeWindow b) { return (b.Width * b.Height).CompareTo(a.Width * a.Height); });
        return list;
    }

    static Dictionary<string, object> Find(Dictionary<string, object> req)
    {
        var wins = AeWindows();
        if (wins.Count == 0) throw new Exception("After Effects window not found");
        var w = wins[0];
        currentHwnd = w.Hwnd;
        var r = Ok(null);
        r["hwnd"] = w.Hwnd.ToInt64();
        r["title"] = w.Title;
        r["rect"] = new[] { w.Rect.Left, w.Rect.Top, w.Rect.Right, w.Rect.Bottom };
        r["size"] = new[] { w.Width, w.Height };
        r["dpi"] = Native.GetDpiForWindow(w.Hwnd);
        r["minimized"] = Native.IsIconic(w.Hwnd);
        return r;
    }

    static IntPtr Target(Dictionary<string, object> req)
    {
        object v;
        if (req.TryGetValue("hwnd", out v) && v != null) currentHwnd = new IntPtr(Convert.ToInt64(v));
        if (currentHwnd == IntPtr.Zero || !Native.IsWindow(currentHwnd)) Find(req);
        if (Native.IsIconic(currentHwnd)) throw new Exception("After Effects is minimized");
        return currentHwnd;
    }

    // ---- capture ---------------------------------------------------------------------------

    static Surface surface;

    // Captures the whole window into the shared surface and returns the clamped rect to use.
    static Rectangle CaptureInto(IntPtr hwnd, int[] rect)
    {
        Native.RECT wr;
        Native.GetWindowRect(hwnd, out wr);
        int w = wr.Right - wr.Left, h = wr.Bottom - wr.Top;
        if (w <= 0 || h <= 0) throw new Exception("window has no size");
        if (surface == null || surface.Width != w || surface.Height != h)
        {
            if (surface != null) surface.Dispose();
            surface = new Surface(w, h);
        }
        surface.Capture(hwnd);
        var full = new Rectangle(0, 0, w, h);
        if (rect == null) return full;
        var area = Rectangle.Intersect(new Rectangle(rect[0], rect[1], rect[2], rect[3]), full);
        if (area.Width <= 0 || area.Height <= 0) throw new Exception("rect is outside the window");
        return area;
    }

    static void Save(Bitmap bmp, string path, int jpegQuality)
    {
        string dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".jpg" || ext == ".jpeg")
        {
            ImageCodecInfo codec = null;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) codec = c;
            var ps = new EncoderParameters(1);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)jpegQuality);
            bmp.Save(path, codec, ps);
        }
        else if (ext == ".tif" || ext == ".tiff")
        {
            // LZW: lossless, and much smaller than GDI+'s default for these flat UI-heavy frames.
            ImageCodecInfo codec = null;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Tiff.Guid) codec = c;
            var ps = new EncoderParameters(1);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Compression, (long)EncoderValue.CompressionLZW);
            bmp.Save(path, codec, ps);
        }
        else if (ext == ".bmp") bmp.Save(path, ImageFormat.Bmp);
        else bmp.Save(path, ImageFormat.Png);
    }

    static Dictionary<string, object> Grab(Dictionary<string, object> req)
    {
        var hwnd = Target(req);
        var sw = Stopwatch.StartNew();
        var area = CaptureInto(hwnd, IntArray(req, "rect"));
        var r = Ok(null);
        r["hash"] = surface.Hash(area);
        r["size"] = new[] { area.Width, area.Height };
        string outPath = Str(req, "out", null);
        if (outPath != null)
        {
            using (var bmp = surface.Copy(area)) Save(bmp, outPath, Int(req, "jpegQuality", 95));
            r["out"] = outPath;
        }
        r["ms"] = sw.ElapsedMilliseconds;
        return r;
    }

    // Grabs repeatedly until the image has stayed the same for stableMs and returns that image.
    // If prevHash is given, first waits for the image to differ from it (the new frame started drawing);
    // after changeTimeoutMs without a change the frame is assumed identical to the previous one.
    // "watch" ([x,y,w,h], optional) is the region hashed for change/stability; it defaults to rect. Watching
    // the viewer plus its footer catches a frame change instantly (the timecode changes) even when the
    // picture doesn't. Stops early if the user cancels.
    // Fills hash, grabs, timedOut, sameAsPrev into the reply.
    static Bitmap WaitStable(IntPtr hwnd, int[] rect, Dictionary<string, object> req, Dictionary<string, object> reply)
    {
        int[] watch = IntArray(req, "watch");
        string prevHash = Str(req, "prevHash", null);
        int stableMs = Int(req, "stableMs", 300);
        int intervalMs = Int(req, "intervalMs", 30);
        int changeTimeoutMs = Int(req, "changeTimeoutMs", 1000);
        int timeoutMs = Int(req, "timeoutMs", 15000);

        var sw = Stopwatch.StartNew();
        bool changed = prevHash == null;
        Bitmap candidate = null;
        string candHash = null;
        long candSince = 0;
        int grabs = 0;
        bool timedOut = false;
        try
        {
            while (true)
            {
                long t0 = sw.ElapsedMilliseconds;
                var area = CaptureInto(hwnd, rect);
                var watchArea = watch == null ? area : Rectangle.Intersect(
                    new Rectangle(watch[0], watch[1], watch[2], watch[3]), new Rectangle(0, 0, surface.Width, surface.Height));
                grabs++;
                string h = surface.Hash(watchArea);
                long now = sw.ElapsedMilliseconds;

                if (!changed && (h != prevHash || now >= changeTimeoutMs)) changed = true;
                if (h != candHash)
                {
                    // Only copy pixels out when the image changed; identical grabs cost just the hash.
                    if (candidate != null) candidate.Dispose();
                    candidate = surface.Copy(area); candHash = h; candSince = t0;
                }

                if (changed && now - candSince >= stableMs) break;
                if (now >= timeoutMs) { timedOut = true; break; }
                PollEscape();
                if (CancelRequested) break;
                int wait = intervalMs - (int)(sw.ElapsedMilliseconds - t0);
                if (wait > 0) Thread.Sleep(wait);
            }
        }
        catch
        {
            if (candidate != null) candidate.Dispose();
            throw;
        }
        reply["hash"] = candHash;
        reply["grabs"] = grabs;
        reply["timedOut"] = timedOut;
        reply["sameAsPrev"] = candHash == prevHash;
        return candidate;
    }

    static Dictionary<string, object> GrabStable(Dictionary<string, object> req)
    {
        var hwnd = Target(req);
        var sw = Stopwatch.StartNew();
        var r = Ok(null);
        using (var img = WaitStable(hwnd, IntArray(req, "rect"), req, r))
        {
            r["size"] = new[] { img.Width, img.Height };
            string outPath = Str(req, "out", null);
            // A cancelled wait may have stopped mid-redraw; don't write a possibly half-drawn frame.
            if (outPath != null && !CancelRequested) { Save(img, outPath, Int(req, "jpegQuality", 95)); r["out"] = outPath; }
        }
        r["ms"] = sw.ElapsedMilliseconds;
        return r;
    }

    // ---- calibration -----------------------------------------------------------------------

    // Stable capture of the whole window, then locate the magenta marker layer (= the comp on screen)
    // and the viewer's pasteboard around it. "debugOut" saves the analysed image.
    static Dictionary<string, object> Measure(Dictionary<string, object> req)
    {
        var hwnd = Target(req);
        var sw = Stopwatch.StartNew();
        var r = Ok(null);
        using (var img = WaitStable(hwnd, null, req, r))
        {
            string dbg = Str(req, "debugOut", null);
            if (dbg != null) Save(img, dbg, 95);
            try { Calibration.Analyze(img, r); }
            catch
            {
                // Keep the capture that failed so the problem can be seen, then report the error.
                string failOut = Str(req, "failOut", null);
                if (failOut != null) try { Save(img, failOut, 95); } catch { }
                throw;
            }
        }
        r["ms"] = sw.ElapsedMilliseconds;
        return r;
    }

    // Same analysis on an image file (for testing without AE).
    static Dictionary<string, object> MeasureFile(Dictionary<string, object> req)
    {
        var r = Ok(null);
        using (var img = new Bitmap(Str(req, "path", "")))
        using (var rgb = img.Clone(new Rectangle(0, 0, img.Width, img.Height), PixelFormat.Format24bppRgb))
            Calibration.Analyze(rgb, r);
        return r;
    }

    // ---- key presses -----------------------------------------------------------------------

    // Presses one shortcut in AE, e.g. {"char":"'","shift":true}. Used only for viewer toggles that
    // scripting can't reach (Title/Action Safe). AE must be the active app; keyboard focus is moved
    // from a CEP panel (a separate process) to AE's own window first, so the key goes to AE.
    static Dictionary<string, object> SendKey(Dictionary<string, object> req)
    {
        var hwnd = Target(req);
        uint aePid;
        uint aeThread = Native.GetWindowThreadProcessId(hwnd, out aePid);

        var fg = Native.GetForegroundWindow();
        if (fg == IntPtr.Zero || Native.GetAncestor(fg, Native.GA_ROOTOWNER) != hwnd)
        {
            Native.SetForegroundWindow(hwnd);
            Thread.Sleep(50);
            fg = Native.GetForegroundWindow();
            if (fg != IntPtr.Zero && Native.GetAncestor(fg, Native.GA_ROOTOWNER) != hwnd)
            {
                // Windows only lets the foreground app hand focus away: borrow its input queue to do it.
                uint fgPid;
                uint fgThread = Native.GetWindowThreadProcessId(fg, out fgPid);
                uint me = Native.GetCurrentThreadId();
                Native.AttachThreadInput(me, fgThread, true);
                Native.SetForegroundWindow(hwnd);
                Native.AttachThreadInput(me, fgThread, false);
                Thread.Sleep(100);
                fg = Native.GetForegroundWindow();
            }
            if (fg == IntPtr.Zero || Native.GetAncestor(fg, Native.GA_ROOTOWNER) != hwnd)
                throw new Exception("After Effects isn't the active app");
        }

        var r = Ok(null);
        var gti = new Native.GUITHREADINFO();
        gti.cbSize = (uint)Marshal.SizeOf(typeof(Native.GUITHREADINFO));
        uint focusPid = 0;
        if (Native.GetGUIThreadInfo(aeThread, ref gti) && gti.hwndFocus != IntPtr.Zero)
            Native.GetWindowThreadProcessId(gti.hwndFocus, out focusPid);
        if (focusPid != aePid)
        {
            uint me = Native.GetCurrentThreadId();
            Native.AttachThreadInput(me, aeThread, true);
            Native.SetFocus(hwnd);
            Native.AttachThreadInput(me, aeThread, false);
            r["focusMoved"] = true;
        }

        string ch = Str(req, "char", "");
        if (ch.Length != 1) throw new Exception("char must be one character");
        IntPtr layout = Native.GetKeyboardLayout(aeThread);
        short scan = Native.VkKeyScanExW(ch[0], layout);
        if (scan == -1) throw new Exception("this keyboard layout has no key for '" + ch + "'");
        ushort vk = (ushort)(scan & 0xFF);
        int layoutMods = (scan >> 8) & 0xFF; // 1 shift, 2 ctrl, 4 alt needed to type the character itself
        bool shift = Bool(req, "shift") || (layoutMods & 1) != 0;
        bool ctrl = Bool(req, "ctrl") || (layoutMods & 2) != 0;
        bool alt = Bool(req, "alt") || (layoutMods & 4) != 0;

        var seq = new List<Native.INPUT>();
        Action<ushort, bool> key = delegate (ushort v, bool up)
        {
            var i = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            i.u.ki.wVk = v;
            // AE ignores modifiers without a hardware scan code (a scan-less Shift+' arrives as plain ',
            // which cycles the grid), so send the left-hand keys with their real scan codes.
            i.u.ki.wScan = (ushort)Native.MapVirtualKeyExW(v, Native.MAPVK_VK_TO_VSC, layout);
            i.u.ki.dwFlags = up ? Native.KEYEVENTF_KEYUP : 0;
            seq.Add(i);
        };
        if (ctrl) key(Native.VK_LCONTROL, false);
        if (alt) key(Native.VK_LMENU, false);
        if (shift) key(Native.VK_LSHIFT, false);
        key(vk, false);
        key(vk, true);
        if (shift) key(Native.VK_LSHIFT, true);
        if (alt) key(Native.VK_LMENU, true);
        if (ctrl) key(Native.VK_LCONTROL, true);
        var arr = seq.ToArray();
        uint sent = Native.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(Native.INPUT)));
        if (sent != arr.Length) throw new Exception("SendInput was blocked (" + Marshal.GetLastWin32Error() + ")");
        r["vk"] = vk;
        return r;
    }

    // CEP can't resize its own Modeless windows (resizeContent and resizeTo are ignored), so the
    // Settings window asks for it here. It's an AE-owned window of CEP's native class; the current
    // client size tells it apart from other extensions' windows.
    static Dictionary<string, object> ResizeWindow(Dictionary<string, object> req)
    {
        int[] sizes = IntArray(req, "sizes");
        if (sizes == null) throw new Exception("sizes is required");
        int[] from = { sizes[0], sizes[1] }, to = { sizes[2], sizes[3] };
        var pids = new HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("AfterFX")) pids.Add((uint)p.Id);
        IntPtr found = IntPtr.Zero;
        double scale = 1;
        var seen = new List<string>();
        Native.EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid) || !Native.IsWindowVisible(h)) return true;
            var cls = new StringBuilder(128);
            Native.GetClassName(h, cls, 128);
            if (cls.ToString() != "PLUGPLUG_UI_NATIVE_WINDOW_CLASS_NAME") return true;
            Native.RECT c;
            Native.GetClientRect(h, out c);
            double s = Native.GetDpiForWindow(h) / 96.0;
            seen.Add(c.Right + "x" + c.Bottom + "@" + s);
            if (Math.Abs(c.Right - from[0] * s) > 2 || Math.Abs(c.Bottom - from[1] * s) > 2) return true;
            found = h; scale = s;
            return false;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) throw new Exception("extension window not found (open ones: " + string.Join(", ", seen.ToArray()) + ")");

        Native.RECT wr, cr;
        Native.GetWindowRect(found, out wr);
        Native.GetClientRect(found, out cr);
        int frameW = (wr.Right - wr.Left) - cr.Right, frameH = (wr.Bottom - wr.Top) - cr.Bottom;
        var work = System.Windows.Forms.Screen.FromHandle(found).WorkingArea;
        int outW = Math.Min((int)Math.Round(to[0] * scale) + frameW, work.Width);
        int outH = Math.Min((int)Math.Round(to[1] * scale) + frameH, work.Height);
        int x = Math.Max(work.Left, Math.Min(wr.Left, work.Right - outW));
        int y = Math.Max(work.Top, Math.Min(wr.Top, work.Bottom - outH));
        Native.SetWindowPos(found, IntPtr.Zero, x, y, outW, outH, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
        return Ok(null);
    }

    // ---- json helpers ----------------------------------------------------------------------

    static bool Bool(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) && v != null && Convert.ToBoolean(v);
    }

    static Dictionary<string, object> Ok(object id)
    {
        var r = new Dictionary<string, object>();
        r["ok"] = true;
        if (id != null) r["id"] = id;
        return r;
    }

    static string Str(Dictionary<string, object> d, string key, string def)
    {
        object v;
        return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : def;
    }

    static int Int(Dictionary<string, object> d, string key, int def)
    {
        object v;
        return d.TryGetValue(key, out v) && v != null ? (int)Math.Round(Convert.ToDouble(v)) : def;
    }

    static int[] IntArray(Dictionary<string, object> d, string key)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return null;
        var arr = v as System.Collections.ArrayList;
        if (arr == null || arr.Count != 4) throw new Exception(key + " must be [x, y, w, h]");
        var res = new int[4];
        for (int i = 0; i < 4; i++) res[i] = (int)Math.Round(Convert.ToDouble(arr[i]));
        return res;
    }
}
