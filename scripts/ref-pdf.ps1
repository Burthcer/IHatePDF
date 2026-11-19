# PowerPoint's own PDF of each given .pptx next to it as <name>.ref.pdf:  powershell -File scripts/ref-pdf.ps1 a.pptx b.pptx
$app = New-Object -ComObject PowerPoint.Application
foreach ($f in $args) { $p = $app.Presentations.Open((Resolve-Path $f).Path, $true, $false, $false); $p.SaveCopyAs(((Resolve-Path $f).Path -replace '\.pptx$', '.ref.pdf'), 32); $p.Close() }
$app.Quit()
