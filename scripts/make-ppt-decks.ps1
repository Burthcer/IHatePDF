# Builds complex .pptx decks with real PowerPoint (COM) and exports PowerPoint's own PDF of each as the reference.
#   powershell -File scripts/make-ppt-decks.ps1   -> test-fixtures/pptx-real/<name>.pptx + <name>.ref.pdf
$ErrorActionPreference = 'Continue'
$out = Join-Path (Resolve-Path "$PSScriptRoot\..").Path 'test-fixtures\pptx-real'
New-Item -ItemType Directory -Force $out | Out-Null
$themes = 'C:\Program Files\Microsoft Office\root\Document Themes 16'
$app = New-Object -ComObject PowerPoint.Application
function RGBc($r, $g, $b) { return $r + 256 * $g + 65536 * $b }
function Try-Step($label, [scriptblock]$b) { try { & $b } catch { Write-Host "  skip $label : $($_.Exception.Message.Split("`n")[0])" } }

function New-Deck($name, $theme, $variant) {
  $p = $app.Presentations.Add($false)
  if ($theme) { Try-Step "theme $theme" { $p.ApplyTemplate("$themes\$theme.thmx") } }
  if ($variant) { Try-Step "variant" { $p.SlideMaster.Theme.ThemeVariants | Out-Null } }
  return $p
}
function Save-Deck($p, $name) {
  $pp = Join-Path $out "$name.pptx"; $rf = Join-Path $out "$name.ref.pdf"
  $p.SaveAs($pp)
  $p.SaveCopyAs($rf, 32)
  $p.Close()
  Write-Host "built $name"
}
function Layout($p, $idx) { return $p.SlideMaster.CustomLayouts.Item($idx) }

# 1. themed decks: layouts with placeholders, theme colours, bullets
foreach ($t in 'Ion', 'Facet', 'Retrospect', 'Dividend-new', 'Gallery', 'Mesh-new', 'Dark Gradient', 'Film Burn') {
  if (-not (Test-Path "$themes\$t.thmx")) { continue }
  $p = New-Deck "t" $t $null
  Try-Step 'title slide' {
    $s = $p.Slides.AddSlide(1, (Layout $p 1))
    $s.Shapes.Item(1).TextFrame.TextRange.Text = "Quarterly Review: $t"
    $s.Shapes.Item(2).TextFrame.TextRange.Text = 'Subtitle with a longer line of text'
  }
  Try-Step 'content slide' {
    $s = $p.Slides.AddSlide(2, (Layout $p 2))
    $s.Shapes.Item(1).TextFrame.TextRange.Text = 'Key points'
    $s.Shapes.Item(2).TextFrame.TextRange.Text = "First bullet with some words`rSecond bullet that is quite a bit longer so that it wraps onto another line in the box`rThird bullet`rFourth"
    $s.Shapes.Item(2).TextFrame.TextRange.Paragraphs(3).IndentLevel = 2
  }
  Try-Step 'two content' {
    $s = $p.Slides.AddSlide(3, (Layout $p 4))
    $s.Shapes.Item(1).TextFrame.TextRange.Text = 'Comparison'
    $s.Shapes.Item(2).TextFrame.TextRange.Text = "Left one`rLeft two"
    $s.Shapes.Item(3).TextFrame.TextRange.Text = "Right one`rRight two"
  }
  Try-Step 'section' { $s = $p.Slides.AddSlide(4, (Layout $p 3)); $s.Shapes.Item(1).TextFrame.TextRange.Text = 'Section header' }
  Save-Deck $p ("theme_" + ($t -replace '[^A-Za-z]', ''))
}

# 2. shapes, fills, transparency, effects on a plain deck
$p = New-Deck 'shapes' $null $null
$s = $p.Slides.AddSlide(1, (Layout $p 7))   # blank
Try-Step 'solid+line' { $x = $s.Shapes.AddShape(1, 30, 30, 200, 100); $x.Fill.ForeColor.RGB = (RGBc 220 50 47); $x.Line.ForeColor.RGB = (RGBc 0 0 0); $x.Line.Weight = 4; $x.TextFrame.TextRange.Text = 'Solid red' }
Try-Step 'theme colour tint' { $x = $s.Shapes.AddShape(5, 260, 30, 200, 100); $x.Fill.ForeColor.ObjectThemeColor = 5; $x.Fill.ForeColor.Brightness = 0.4; $x.Line.Visible = 0; $x.TextFrame.TextRange.Text = 'Accent1 +40%' }
Try-Step 'theme colour dark' { $x = $s.Shapes.AddShape(5, 490, 30, 200, 100); $x.Fill.ForeColor.ObjectThemeColor = 6; $x.Fill.ForeColor.Brightness = -0.5; $x.TextFrame.TextRange.Text = 'Accent2 -50%' }
Try-Step 'gradient 2 stops' { $x = $s.Shapes.AddShape(1, 30, 160, 200, 100); $x.Fill.TwoColorGradient(1, 1); $x.Fill.ForeColor.RGB = (RGBc 255 200 0); $x.Fill.BackColor.RGB = (RGBc 200 0 100); $x.TextFrame.TextRange.Text = 'Linear gradient' }
Try-Step 'gradient radial' { $x = $s.Shapes.AddShape(9, 260, 160, 200, 100); $x.Fill.TwoColorGradient(5, 1); $x.Fill.ForeColor.RGB = (RGBc 255 255 255); $x.Fill.BackColor.RGB = (RGBc 0 90 200); $x.TextFrame.TextRange.Text = 'Radial' }
Try-Step 'gradient preset' { $x = $s.Shapes.AddShape(1, 490, 160, 200, 100); $x.Fill.PresetGradient(1, 1, 7); $x.TextFrame.TextRange.Text = 'Preset gradient' }
Try-Step 'transparency' { $a = $s.Shapes.AddShape(1, 30, 290, 150, 90); $a.Fill.ForeColor.RGB = (RGBc 0 120 255); $b = $s.Shapes.AddShape(1, 100, 320, 150, 90); $b.Fill.ForeColor.RGB = (RGBc 255 60 0); $b.Fill.Transparency = 0.5; $b.TextFrame.TextRange.Text = '50% alpha' }
Try-Step 'shadow' { $x = $s.Shapes.AddShape(5, 290, 300, 150, 80); $x.Fill.ForeColor.RGB = (RGBc 255 255 255); $x.Shadow.Visible = -1; $x.Shadow.OffsetX = 6; $x.Shadow.OffsetY = 6; $x.Shadow.Blur = 8; $x.Shadow.Transparency = 0.5; $x.TextFrame.TextRange.Text = 'Shadow'; $x.TextFrame.TextRange.Font.Color.RGB = 0 }
Try-Step 'rotated' { $x = $s.Shapes.AddShape(1, 490, 300, 150, 60); $x.Rotation = 20; $x.Fill.ForeColor.RGB = (RGBc 40 160 80); $x.TextFrame.TextRange.Text = 'Rotated 20' }
Try-Step 'arrows+line' {
  $l = $s.Shapes.AddLine(30, 430, 300, 430); $l.Line.Weight = 3; $l.Line.DashStyle = 4; $l.Line.EndArrowheadStyle = 2; $l.Line.ForeColor.RGB = (RGBc 80 80 80)
  $x = $s.Shapes.AddShape(33, 330, 410, 120, 50); $x.Fill.ForeColor.RGB = (RGBc 90 90 200)
  $y = $s.Shapes.AddShape(52, 470, 405, 80, 60); $y.Fill.ForeColor.RGB = (RGBc 255 190 0)
  $z = $s.Shapes.AddShape(70, 570, 405, 100, 60); $z.Fill.ForeColor.RGB = (RGBc 200 60 150)
}
Save-Deck $p 'shapes_effects'

# 3. backgrounds: gradient, solid, picture; formatted text
$p = New-Deck 'bg' $null $null
Try-Step 'gradient bg' { $s = $p.Slides.AddSlide(1, (Layout $p 7)); $s.FollowMasterBackground = 0; $s.Background.Fill.TwoColorGradient(1, 1); $s.Background.Fill.ForeColor.RGB = (RGBc 10 30 80); $s.Background.Fill.BackColor.RGB = (RGBc 120 60 200); $t = $s.Shapes.AddTextbox(1, 60, 60, 600, 100); $t.TextFrame.TextRange.Text = 'Gradient background, white text'; $t.TextFrame.TextRange.Font.Size = 32; $t.TextFrame.TextRange.Font.Color.RGB = (RGBc 255 255 255) }
Try-Step 'solid bg' { $s = $p.Slides.AddSlide(2, (Layout $p 7)); $s.FollowMasterBackground = 0; $s.Background.Fill.Solid(); $s.Background.Fill.ForeColor.RGB = (RGBc 255 244 214); $t = $s.Shapes.AddTextbox(1, 60, 60, 600, 100); $t.TextFrame.TextRange.Text = 'Cream background'; $t.TextFrame.TextRange.Font.Size = 32 }
Try-Step 'text formats' {
  $s = $p.Slides.AddSlide(3, (Layout $p 7)); $t = $s.Shapes.AddTextbox(1, 40, 40, 640, 300)
  $r = $t.TextFrame.TextRange; $r.Text = "Bold red heading`rUnderlined italic blue line`rStrike and superscript x2 and subscript H2O`rNumbered one`rNumbered two`rCentered paragraph with spacing"
  $r.Paragraphs(1).Font.Bold = -1; $r.Paragraphs(1).Font.Color.RGB = (RGBc 220 0 0); $r.Paragraphs(1).Font.Size = 28
  $r.Paragraphs(2).Font.Underline = -1; $r.Paragraphs(2).Font.Italic = -1; $r.Paragraphs(2).Font.Color.RGB = (RGBc 0 0 220)
  $r.Paragraphs(4).ParagraphFormat.Bullet.Visible = -1; $r.Paragraphs(4).ParagraphFormat.Bullet.Type = 2
  $r.Paragraphs(5).ParagraphFormat.Bullet.Visible = -1; $r.Paragraphs(5).ParagraphFormat.Bullet.Type = 2
  $r.Paragraphs(6).ParagraphFormat.Alignment = 2; $r.Paragraphs(6).ParagraphFormat.SpaceBefore = 20; $r.Paragraphs(6).Font.Name = 'Georgia'
  $r.Paragraphs(3).Characters(26, 1).Font.Superscript = -1
}
Try-Step 'table' {
  $s = $p.Slides.AddSlide(4, (Layout $p 7)); $tb = $s.Shapes.AddTable(4, 3, 40, 60, 640, 240).Table
  for ($i = 1; $i -le 4; $i++) { for ($j = 1; $j -le 3; $j++) { $tb.Cell($i, $j).Shape.TextFrame.TextRange.Text = "R$i C$j" } }
  $tb.Cell(2, 2).Shape.Fill.ForeColor.RGB = (RGBc 255 220 100); $tb.Cell(3, 3).Shape.Fill.ForeColor.RGB = (RGBc 160 220 160)
}
Try-Step 'group' {
  $s = $p.Slides.AddSlide(5, (Layout $p 7)); $a = $s.Shapes.AddShape(9, 60, 60, 120, 120); $a.Fill.ForeColor.RGB = (RGBc 200 40 40); $b = $s.Shapes.AddShape(1, 140, 100, 160, 80); $b.Fill.ForeColor.RGB = (RGBc 40 40 200)
  $g = $s.Shapes.Range(@($a.Name, $b.Name)).Group(); $g.Rotation = 15; $g.Left = 250
}
Try-Step 'picture' {
  $s = $p.Slides.AddSlide(6, (Layout $p 7)); $img = Join-Path $out 'pic.png'
  Add-Type -AssemblyName System.Drawing; $bm = New-Object System.Drawing.Bitmap 400, 250; $g = [System.Drawing.Graphics]::FromImage($bm)
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 400, 250), [System.Drawing.Color]::Orange, [System.Drawing.Color]::Purple); $g.FillRectangle($br, 0, 0, 400, 250); $bm.Save($img); $g.Dispose(); $bm.Dispose()
  $pc = $s.Shapes.AddPicture($img, 0, -1, 60, 60, 400, 250); $pc.PictureFormat.CropLeft = 40; $pc.Shadow.Visible = -1; $pc.Line.Weight = 3; $pc.Line.ForeColor.RGB = (RGBc 255 255 255)
  $pc2 = $s.Shapes.AddPicture($img, 0, -1, 480, 100, 200, 125); $pc2.Rotation = -10; $pc2.PictureFormat.TransparentBackground = 0
}
Try-Step 'smartart+chart' {
  $s = $p.Slides.AddSlide(7, (Layout $p 7))
  try { $sa = $s.Shapes.AddSmartArt($app.SmartArtLayouts.Item(1), 40, 40, 640, 220) } catch { Write-Host '  skip smartart' }
  try { $c = $s.Shapes.AddChart2(201, 51, 40, 280, 640, 220); $c.Chart.ChartData.Workbook.Close() } catch { Write-Host '  skip chart' }
}
Save-Deck $p 'backgrounds_text_tables'
$app.Quit()
Write-Host 'done'

