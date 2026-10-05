# EnoughFactory application icon

`icon.svg` is the supplied Enough ink mark from `apps/marketing/public/brand/mark-ink.svg`. Its shapes and colors are unchanged. `icon.png` is a 1024 px raster; `icon.icns` contains native Mac icon sizes from the accompanying iconset. All use the included Enough brand license.

The checked-in assets were rendered using macOS `sips` and assembled using `iconutil`. To regenerate one raster, use `sips -s format png -z 1024 1024 icon.svg --out icon.png`. Render iconset sizes 16, 32, 128, 256 and 512 px at both 1x and 2x, then run `iconutil -c icns EnoughFactory.iconset -o icon.icns`.
