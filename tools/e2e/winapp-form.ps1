# Native WinForms login window for the Windows-app fill E2E (section 10.4).
param([string]$Title = 'TkrTest Login', [string]$Out = '')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = $Title
$f.Width = 360; $f.Height = 220
$f.StartPosition = 'CenterScreen'
$f.TopMost = $true

$lu = New-Object System.Windows.Forms.Label; $lu.Text = 'User'; $lu.Left = 10; $lu.Top = 15; $lu.Width = 70
$u = New-Object System.Windows.Forms.TextBox; $u.Name = 'txtUser'; $u.AccessibleName = 'User'; $u.Left = 90; $u.Top = 12; $u.Width = 220
$lp = New-Object System.Windows.Forms.Label; $lp.Text = 'Password'; $lp.Left = 10; $lp.Top = 50; $lp.Width = 70
$p = New-Object System.Windows.Forms.TextBox; $p.Name = 'txtPw'; $p.AccessibleName = 'Password'; $p.UseSystemPasswordChar = $true; $p.Left = 90; $p.Top = 47; $p.Width = 220
$b = New-Object System.Windows.Forms.Button; $b.Name = 'btnLogin'; $b.Text = 'Login'; $b.Left = 90; $b.Top = 85; $b.Width = 100
$r = New-Object System.Windows.Forms.Label; $r.Name = 'lblResult'; $r.Text = 'idle'; $r.Left = 10; $r.Top = 125; $r.Width = 320
$b.Add_Click({
    $r.Text = 'clicked'
    if ($Out) { [System.IO.File]::WriteAllText($Out, ($u.Text + '|' + $p.Text)) }
})
$f.AcceptButton = $b
$f.Controls.AddRange(@($lu, $u, $lp, $p, $b, $r))
[void]$f.ShowDialog()
