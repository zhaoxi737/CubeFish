"""把 CI / fetch 脚本也改成「内部 JRE 布局」，和手机里的内置方式一致。"""
from pathlib import Path

WF = Path(r"D:\CubeFish-Mobile\amethyst\.github\workflows\cubefish-mobile.yml")
FETCH = Path(r"D:\CubeFish-Mobile\amethyst\scripts\fetch-jre.ps1")

OLD_WF_BLOCK = '''      - name: Get bundled JRE17/21 (arm64, upstream release assets)
        run: |
          mkdir -p app_pojavlauncher/src/main/assets/components/jre-external
          curl -L --retry 3 -o app_pojavlauncher/src/main/assets/components/jre-external/jre17-android-arm64.tar.xz \\
            https://github.com/AngelAuraMC/angelauramc-openjdk-build/releases/download/download_jre17/jre17-android-arm64.tar.xz
          curl -L --retry 3 -o app_pojavlauncher/src/main/assets/components/jre-external/jre21-android-arm64.tar.xz \\
            https://github.com/AngelAuraMC/angelauramc-openjdk-build/releases/download/download_jre21/jre21-android-arm64.tar.xz
'''

NEW_WF_BLOCK = '''      - name: Get bundled JRE17/21 (internal runtime layout)
        run: |
          set -e
          build_one() {
            folder="$1"; tag="$2"; name="$3"; ver="$4"
            dest="app_pojavlauncher/src/main/assets/components/$folder"
            mkdir -p "$dest"
            curl -L --retry 3 -o "$dest/bin-arm64.tar.xz" \\
              "https://github.com/AngelAuraMC/angelauramc-openjdk-build/releases/download/$tag/$name"
            tar -cJf "$dest/universal.tar.xz" --files-from /dev/null
            printf '%s' "$ver" > "$dest/version"
          }
          build_one jre-new download_jre17 jre17-android-arm64.tar.xz cubefish-jre17-arm64-1
          build_one jre-21 download_jre21 jre21-android-arm64.tar.xz cubefish-jre21-arm64-1
'''


def patch_workflow() -> None:
    text = WF.read_text(encoding="utf-8")
    if "internal runtime layout" in text:
        print("workflow 已是内部布局")
        return
    if OLD_WF_BLOCK not in text:
        print("workflow：没找到旧块，跳过")
        return
    WF.write_text(text.replace(OLD_WF_BLOCK, NEW_WF_BLOCK, 1), encoding="utf-8")
    print("workflow 已改为内部 JRE 布局")


def patch_fetch() -> None:
    text = FETCH.read_text(encoding="utf-8")
    marker = "取 JRE17 / JRE21"
    if marker not in text:
        print("fetch 脚本：没找到旧段，跳过")
        return
    head = text.split("# 取 JRE17")[0] if "# 取 JRE17" in text else text.split('Write-Host "[5/5]')[0]
    new_tail = '''
Write-Host "[5/5] 准备内置 JRE17 / JRE21（内部运行时布局，等于把 Java 塞进 APK，手机不用再下载）"
$external = @(
  @{ folder = 'jre-new'; tag = 'download_jre17'; name = 'jre17-android-arm64.tar.xz'; version = 'cubefish-jre17-arm64-1' },
  @{ folder = 'jre-21'; tag = 'download_jre21'; name = 'jre21-android-arm64.tar.xz'; version = 'cubefish-jre21-arm64-1' }
)
function New-EmptyTarXz([string]$path) {
  $empty = [System.IO.Path]::GetTempFileName()
  try {
    & tar -cJf $path --files-from NUL 2>$null
  } catch {
  }
  if (-not (Test-Path $path) -or (Get-Item $path).Length -lt 60) {
    python -c "import io,tarfile,sys; b=io.BytesIO(); tarfile.open(fileobj=b,mode='w:xz').close(); open(sys.argv[1],'wb').write(b.getvalue())" $path
  }
  if (Test-Path $empty) { Remove-Item $empty -Force }
}
foreach ($item in $external) {
  $dest = Join-Path $PSScriptRoot "..\\app_pojavlauncher\\src\\main\\assets\\components\\$($item.folder)"
  New-Item -ItemType Directory -Force $dest | Out-Null
  $bin = Join-Path $dest 'bin-arm64.tar.xz'
  if (-not (Test-Path $bin) -or (Get-Item $bin).Length -lt 20MB) {
    cmd /d /c "gh release download $($item.tag) -R AngelAuraMC/angelauramc-openjdk-build -p $($item.name) -D `"$dest`" --clobber 2>NUL"
    $downloaded = Join-Path $dest $item.name
    if (Test-Path $downloaded) { Move-Item -Force $downloaded $bin }
  }
  New-EmptyTarXz (Join-Path $dest 'universal.tar.xz')
  [System.IO.File]::WriteAllText((Join-Path $dest 'version'), $item.version, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("      {0}: {1}MB" -f $item.folder, [math]::Round((Get-Item $bin).Length / 1MB, 1))
}
'''
    FETCH.write_text(head + new_tail, encoding="utf-8")
    print("fetch-jre.ps1 已改为内部 JRE 布局")


if __name__ == "__main__":
    patch_workflow()
    patch_fetch()
