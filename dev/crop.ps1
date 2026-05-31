param(
  [string]$src,
  [string]$dst,
  [int]$x, [int]$y, [int]$w, [int]$h
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
$rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
$crop = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0,0,$w,$h)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$crop.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $crop.Dispose(); $img.Dispose()
"Saved $dst ($w x $h)"
