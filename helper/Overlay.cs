// Small always-on-top progress box shown during a render. The comp viewer is maximized then, which hides
// the Wireframe panel, so this is the only visible progress and cancel control. It's a separate window,
// so PrintWindow on AE never captures it. Drag it anywhere but the button to move it; it then stays put
// (for as long as the helper runs) instead of following the AE window.

using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

// A label that lets mouse hits through to the form, so the form can treat them as a title-bar drag.
class PassThroughLabel : Label
{
    const int WM_NCHITTEST = 0x84, HTTRANSPARENT = -1;

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCHITTEST) { m.Result = (IntPtr)HTTRANSPARENT; return; }
        base.WndProc(ref m);
    }
}

class OverlayForm : Form
{
    const int WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
    const int WM_NCHITTEST = 0x84, WM_EXITSIZEMOVE = 0x232, HTCLIENT = 1, HTCAPTION = 2;

    public readonly Label Text1 = new PassThroughLabel();
    // Set once the user drags the box; from then on Show() leaves it where it is.
    public bool Moved;
    readonly Button cancel = new Button();

    public OverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.FromArgb(35, 35, 35);
        ForeColor = Color.FromArgb(220, 220, 220);
        Size = new Size(380, 52);
        Padding = new Padding(1);

        Text1.AutoSize = false;
        Text1.Font = new Font("Segoe UI", 9f);
        Text1.TextAlign = ContentAlignment.MiddleLeft;
        Text1.SetBounds(12, 0, 270, 52);
        Cursor = Cursors.SizeAll;

        cancel.Text = "Cancel";
        cancel.FlatStyle = FlatStyle.Flat;
        cancel.FlatAppearance.BorderColor = Color.FromArgb(80, 80, 80);
        cancel.BackColor = Color.FromArgb(50, 50, 50);
        cancel.Font = new Font("Segoe UI", 9f);
        cancel.Cursor = Cursors.Default;
        cancel.SetBounds(290, 12, 78, 28);
        cancel.Click += delegate
        {
            Program.CancelRequested = true;
            Text1.Text = "Cancelling…";
        };

        Controls.Add(Text1);
        Controls.Add(cancel);
    }

    // Never take focus from AE: keystrokes and the viewer must stay where they are.
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    // The whole box (except the button, a child window with its own hit test) drags like a title bar.
    // Windows moves it without activating it, so AE keeps focus.
    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WM_NCHITTEST && (int)m.Result == HTCLIENT) m.Result = (IntPtr)HTCAPTION;
        else if (m.Msg == WM_EXITSIZEMOVE) Moved = true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using (var pen = new Pen(Color.FromArgb(70, 70, 70)))
            e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
    }
}

static class Overlay
{
    static OverlayForm form;
    static readonly ManualResetEvent ready = new ManualResetEvent(false);

    static void EnsureThread()
    {
        if (form != null) return;
        var t = new Thread(delegate ()
        {
            Application.EnableVisualStyles();
            form = new OverlayForm();
            var h = form.Handle; // create the handle so BeginInvoke works before the first Show
            ready.Set();
            Application.Run();
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        ready.WaitOne();
    }

    // Shows (or updates) the box, centred near the bottom of the given screen rect unless the user moved it.
    public static void Show(string text, Native.RECT anchor)
    {
        EnsureThread();
        form.BeginInvoke((Action)delegate
        {
            if (!Program.CancelRequested) form.Text1.Text = text;
            if (!form.Moved)
            {
                int x = anchor.Left + (anchor.Right - anchor.Left - form.Width) / 2;
                int y = anchor.Bottom - form.Height - 60;
                form.Location = new Point(x, y);
            }
            if (!form.Visible) form.Show();
        });
    }

    public static void Hide()
    {
        if (form == null) return;
        form.BeginInvoke((Action)delegate { form.Hide(); });
    }
}
