# Extract the first face of Microsoft YaHei / YaHei Bold from the Windows .ttc
# collections into plain .ttf files that Chrome/Edge can load via @font-face.
#
# The generated TTFs are already committed under public/fonts, so this script is
# only needed if the source fonts change.
#
# Usage (from video/): powershell -ExecutionPolicy Bypass -File scripts/extract-fonts.ps1
param(
  [string]$FontDir = (Join-Path $PSScriptRoot '..\public\fonts')
)

$ErrorActionPreference = 'Stop'

python -m pip install --disable-pip-version-check --quiet fonttools

$code = @'
from fontTools.ttLib import TTCollection
import os

font_dir = os.path.abspath(os.environ["FONT_DIR"])
pairs = [
    ("msyh.ttc", "msyh-regular.ttf"),
    ("msyhbd.ttc", "msyh-bold.ttf"),
]

for source, target in pairs:
    source_path = os.path.join(font_dir, source)
    target_path = os.path.join(font_dir, target)
    collection = TTCollection(source_path)
    collection.fonts[0].save(target_path)
    print(f"wrote {target_path}")
'@

$env:FONT_DIR = (Resolve-Path $FontDir).Path
$code | python -
