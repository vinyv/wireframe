// Small always-on-top progress box shown during a render. The comp viewer is maximized then, which hides
// the Wireframe panel, so this is the only visible progress and cancel control. It's a separate window,
// so PrintWindow on AE never captures it.

using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

class OverlayForm : Form
{
    const int WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;

    public readonly Label Text1 = new Label();
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

        cancel.Text = "Cancel";
        cancel.FlatStyle = FlatStyle.Flat;
        cancel.FlatAppearance.BorderColor = Color.FromArgb(80, 80, 80);
        cancel.BackColor = Color.FromArgb(50, 50, 50);
        cancel.Font = new Font("Segoe UI", 9f);
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

    // Shows (or updates) the box, centred near the bottom of the given screen rect.
    public static void Show(string text, Native.RECT anchor)
    {
        EnsureThread();
        form.BeginInvoke((Action)delegate
        {
            if (!Program.CancelRequested) form.Text1.Text = text;
            int x = anchor.Left + (anchor.Right - anchor.Left - form.Width) / 2;
            int y = anchor.Bottom - form.Height - 60;
            form.Location = new Point(x, y);
            if (!form.Visible) form.Show();
        });
    }

    public static void Hide()
    {
        if (form == null) return;
        form.BeginInvoke((Action)delegate { form.Hide(); });
    }
}
