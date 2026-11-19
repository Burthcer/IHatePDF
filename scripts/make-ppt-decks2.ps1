# Second batch of PowerPoint-built decks: SmartArt, charts, WordArt, merged tables, columns, vertical text, connectors.
$ErrorActionPreference = 'Continue'
$out = Join-Path (Resolve-Path "$PSScriptRoot\..").Path 'test-fixtures\pptx-real'
$app = New-Object -ComObject PowerPoint.Application
function RGBc($r, $g, $b) { return $r + 256 * $g + 65536 * $b }
function Try-Step($label, [scriptblock]$b) { try { & $b } catch { Write-Host "  skip $label : $($_.Exception.Message.Split("`n")[0])" } }
$p = $app.Presentations.Add($false)
$blank = $p.SlideMaster.CustomLayouts.Item(7)

Try-Step 'smartart' {
  $s = $p.Slides.AddSlide(1, $blank)
  $lay = $null; foreach ($l in $app.SmartArtLayouts) { if ($l.Name -eq 'Basic Block List') { $lay = $l; break } }
  $sa = $s.Shapes.AddSmartArt($lay, 40, 60, 640, 300)
  $i = 1; foreach ($n in $sa.SmartArt.AllNodes) { $n.TextFrame2.TextRange.Text = "Item $i"; $i++ }
}
Try-Step 'smartart process' {
  $s = $p.Slides.AddSlide(2, $blank)
  $lay = $null; foreach ($l in $app.SmartArtLayouts) { if ($l.Name -eq 'Basic Process') { $lay = $l; break } }
  $sa = $s.Shapes.AddSmartArt($lay, 40, 60, 640, 200)
}
Try-Step 'chart' {
  $s = $p.Slides.AddSlide(3, $blank)
  $c = $s.Shapes.AddChart2(-1, 51, 40, 40, 640, 400)
  $c.Chart.ChartData.Workbook.Close()
}
Try-Step 'pie chart' {
  $s = $p.Slides.AddSlide(4, $blank)
  $c = $s.Shapes.AddChart2(-1, 5, 40, 40, 500, 400)
  $c.Chart.ChartData.Workbook.Close()
}
Try-Step 'wordart' {
  $s = $p.Slides.AddSlide(5, $blank)
  $w = $s.Shapes.AddTextEffect(0, 'WordArt Title', 'Arial', 48, 0, 0, 60, 60)
  $w.Fill.ForeColor.RGB = (RGBc 200 40 40)
  $t = $s.Shapes.AddTextbox(1, 60, 200, 600, 200); $t.TextFrame.TextRange.Text = 'Two columns of text. ' * 30; $t.TextFrame2.Column.Number = 2; $t.TextFrame.TextRange.Font.Size = 16
  $v = $s.Shapes.AddTextbox(1, 640, 60, 60, 300); $v.TextFrame.Orientation = 5; $v.TextFrame.TextRange.Text = 'Vertical text'
}
Try-Step 'merged table' {
  $s = $p.Slides.AddSlide(6, $blank); $tb = $s.Shapes.AddTable(5, 4, 40, 60, 640, 300).Table
  for ($i = 1; $i -le 5; $i++) { for ($j = 1; $j -le 4; $j++) { $tb.Cell($i, $j).Shape.TextFrame.TextRange.Text = "r$i c$j" } }
  $tb.Cell(2, 1).Merge($tb.Cell(3, 2)); $tb.Cell(1, 3).Merge($tb.Cell(1, 4))
  $tb.Cell(4, 4).Shape.Fill.ForeColor.RGB = (RGBc 255 200 200)
  $tb.Cell(5, 1).Shape.TextFrame.TextRange.Font.Size = 24
}
Try-Step 'connectors' {
  $s = $p.Slides.AddSlide(7, $blank)
  $a = $s.Shapes.AddShape(1, 60, 60, 120, 60); $b = $s.Shapes.AddShape(9, 400, 260, 120, 80)
  $c = $s.Shapes.AddConnector(2, 0, 0, 10, 10); $c.ConnectorFormat.BeginConnect($a, 4); $c.ConnectorFormat.EndConnect($b, 1); $c.Line.EndArrowheadStyle = 2; $c.Line.Weight = 3
  $d = $s.Shapes.AddConnector(3, 200, 400, 500, 450); $d.Line.ForeColor.RGB = (RGBc 200 0 0); $d.Line.Weight = 2; $d.Line.BeginArrowheadStyle = 5
  $e = $s.Shapes.AddShape(10, 300, 80, 150, 90); $e.TextFrame.TextRange.Text = 'Hexagon with long text inside the shape'; $e.Fill.ForeColor.RGB = (RGBc 120 200 160)
  $f = $s.Shapes.AddShape(62, 540, 60, 120, 120); $f.TextFrame.TextRange.Text = 'Star'; $g = $s.Shapes.AddShape(86, 60, 200, 160, 100); $g.TextFrame.TextRange.Text = 'Callout'
}
Try-Step 'text spacing' {
  $s = $p.Slides.AddSlide(8, $blank); $t = $s.Shapes.AddTextbox(1, 40, 40, 640, 400); $r = $t.TextFrame.TextRange
  $r.Text = "Line spacing 150% paragraph with enough words to wrap around to a second and a third line in this box.`rSpace before and after paragraph with some text that is long enough to wrap onto two lines at least.`rLevel one`rLevel two`rLevel three"
  $r.Font.Size = 18; $r.Paragraphs(1).ParagraphFormat.SpaceWithin = 1.5; $r.Paragraphs(2).ParagraphFormat.SpaceBefore = 18; $r.Paragraphs(2).ParagraphFormat.SpaceAfter = 18
  $r.Paragraphs(3).ParagraphFormat.Bullet.Visible = -1; $r.Paragraphs(4).ParagraphFormat.Bullet.Visible = -1; $r.Paragraphs(4).IndentLevel = 2; $r.Paragraphs(5).ParagraphFormat.Bullet.Visible = -1; $r.Paragraphs(5).IndentLevel = 3
}
$pp = Join-Path $out 'complex_elements.pptx'
$p.SaveAs($pp); $p.SaveCopyAs((Join-Path $out 'complex_elements.ref.pdf'), 32); $p.Close(); $app.Quit(); Write-Host 'done'
