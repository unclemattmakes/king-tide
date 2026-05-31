param(
  [string]$src, [string]$dst,
  [int]$x, [int]$y, [int]$w, [int]$h,
  [int]$canvas = 1024, [int]$pad = 80
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
# crop region
$srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
# scale crop to fit inside (canvas - 2*pad) preserving aspect
$avail = $canvas - 2*$pad
$scale = [Math]::Min($avail / $w, $avail / $h)
$dw = [int]($w * $scale); $dh = [int]($h * $scale)
$ox = [int](($canvas - $dw) / 2); $oy = [int](($canvas - $dh) / 2)
$out = New-Object System.Drawing.Bitmap($canvas, $canvas)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$dstRect = New-Object System.Drawing.Rectangle($ox, $oy, $dw, $dh)
$g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$out.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $out.Dispose(); $img.Dispose()
"Saved $dst ($canvas x $canvas), object $dw x $dh centered"
