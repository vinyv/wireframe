// Finds the calibration marker (a pure magenta solid covering the whole comp) in a window capture.
// At a zoom where the comp overflows the viewer, the marker's rect is the viewer's visible area instead.
// (The pasteboard colour can't be used for the viewer bounds: AE's tab strip uses the same grey.)

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

static class Calibration
{
    const int MinMarkerPixels = 400;

    // Magenta with slack for display colour management.
    static bool IsMarker(byte b, byte g, byte r)
    {
        return r >= 170 && b >= 170 && g <= 90;
    }

    public static unsafe void Analyze(Bitmap img, Dictionary<string, object> reply)
    {
        if (img.PixelFormat != PixelFormat.Format24bppRgb) throw new Exception("expected a 24bpp image");
        int w = img.Width, h = img.Height;
        var data = img.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, img.PixelFormat);
        try
        {
            byte* scan0 = (byte*)data.Scan0;
            int stride = data.Stride;

            // Marker pixel counts per row and column.
            var rowCount = new int[h];
            var colCount = new int[w];
            long total = 0;
            for (int y = 0; y < h; y++)
            {
                byte* p = scan0 + (long)y * stride;
                for (int x = 0; x < w; x++, p += 3)
                {
                    if (!IsMarker(p[0], p[1], p[2])) continue;
                    rowCount[y]++; colCount[x]++; total++;
                }
            }
            if (total < MinMarkerPixels) throw new Exception("calibration marker not visible in the viewer");

            // The marker's span: rows/columns that are at least half as full as the fullest one.
            // Thin overlay lines crossing the marker only dent a few counts, so they don't split the span.
            int maxRow = 0, maxCol = 0;
            foreach (int c in rowCount) maxRow = Math.Max(maxRow, c);
            foreach (int c in colCount) maxCol = Math.Max(maxCol, c);
            int y0 = -1, y1 = -1, x0 = -1, x1 = -1;
            for (int y = 0; y < h; y++) if (rowCount[y] * 2 >= maxRow) { if (y0 < 0) y0 = y; y1 = y; }
            for (int x = 0; x < w; x++) if (colCount[x] * 2 >= maxCol) { if (x0 < 0) x0 = x; x1 = x; }
            int cw = x1 - x0 + 1, ch = y1 - y0 + 1;

            long inside = 0;
            for (int y = y0; y <= y1; y++)
            {
                byte* p = scan0 + (long)y * stride + x0 * 3;
                for (int x = x0; x <= x1; x++, p += 3) if (IsMarker(p[0], p[1], p[2])) inside++;
            }
            // Overlays drawn on top (layer handles, paths, safe zones) lower the fill without moving the
            // edges; the caller compares fills to pick the cleaner view. Only reject what isn't a rectangle.
            double fill = (double)inside / ((long)cw * ch);
            if (fill < 0.5) throw new Exception("calibration marker is mostly covered (fill " + fill.ToString("0.00") + ")");

            reply["comp"] = new[] { x0, y0, cw, ch };
            reply["fill"] = Math.Round(fill, 4);
            reply["imageSize"] = new[] { w, h };

            // Long lines drawn over the marker (Title/Action Safe, grid, guides), as fractions of the comp
            // size: 0.05 is a horizontal line 5% down from the top. Short marks like the centre cross
            // don't count: a line must cover most of the middle 70% of the marker.
            int mx0 = x0 + cw * 15 / 100, mx1 = x1 - cw * 15 / 100;
            int my0 = y0 + ch * 15 / 100, my1 = y1 - ch * 15 / 100;
            var hLines = new List<double>();
            var vLines = new List<double>();
            int runStart = -1;
            for (int y = y0 + 2; y <= y1 - 1; y++)
            {
                bool line = false;
                if (y <= y1 - 2)
                {
                    int miss = 0;
                    byte* p = scan0 + (long)y * stride + mx0 * 3;
                    for (int x = mx0; x <= mx1; x++, p += 3) if (!IsMarker(p[0], p[1], p[2])) miss++;
                    line = miss * 10 > (mx1 - mx0 + 1) * 6;
                }
                if (line && runStart < 0) runStart = y;
                if (!line && runStart >= 0)
                {
                    hLines.Add(Math.Round(((runStart + y - 1) / 2.0 - y0) / ch, 4));
                    runStart = -1;
                }
            }
            runStart = -1;
            for (int x = x0 + 2; x <= x1 - 1; x++)
            {
                bool line = false;
                if (x <= x1 - 2)
                {
                    int miss = 0;
                    for (int y = my0; y <= my1; y++)
                    {
                        byte* p = scan0 + (long)y * stride + x * 3;
                        if (!IsMarker(p[0], p[1], p[2])) miss++;
                    }
                    line = miss * 10 > (my1 - my0 + 1) * 6;
                }
                if (line && runStart < 0) runStart = x;
                if (!line && runStart >= 0)
                {
                    vLines.Add(Math.Round(((runStart + x - 1) / 2.0 - x0) / cw, 4));
                    runStart = -1;
                }
            }
            var lines = new Dictionary<string, object>();
            lines["h"] = hLines;
            lines["v"] = vLines;
            reply["lines"] = lines;
        }
        finally { img.UnlockBits(data); }
    }
}
