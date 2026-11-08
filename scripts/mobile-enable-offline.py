"""方块鱼手机版：打开「离线（本地）账号」这条路（M2.6）。

上游 Amethyst 把本地登录挡掉了：
1. SelectAuthFragment 的「本地登录」先弹「需要 Java 版账户」对话框，回调永远不执行；
2. LocalLoginFragment 一进去发现没有在线账号就直接跳回主菜单；
3. hasOnlineProfile() 只认微软账号，导致「创建版本/打开文件夹/安装 jar」等入口也全被挡。

我们把这三处改成「离线账号也算有账号」，让离线能完整走通：登录 → 建版本 → 启动。
"""
from pathlib import Path

JAVA = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java")


def patch(rel: str, old: str, new: str, note: str) -> None:
    path = JAVA / rel
    if not path.exists():
        print("缺失:", rel)
        return
    text = path.read_text(encoding="utf-8")
    if new in text:
        print(f"{rel}: 已经是目标状态（{note}）")
        return
    if old not in text:
        print(f"{rel}: 没找到要替换的片段（{note}），跳过")
        return
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"{rel}: 已修改（{note}）")


# 1) 离线账号也算「有账号」
patch(
    "net/kdt/pojavlaunch/Tools.java",
    """    public static boolean hasOnlineProfile(){
        for (MinecraftAccount accountToCheck : getAllProfiles()) {
            if (!accountToCheck.isLocal() && !accountToCheck.isDemo()) {
                return true;
            }
        }
        return false;
    }""",
    """    /** 方块鱼：离线（本地）账号也算「有账号」。
     *  上游只认微软账号，导致没登录微软时所有功能都被「需要 Java 版账户」挡住，
     *  连离线登录都进不去。这里改成任意账号存在即可。 */
    public static boolean hasOnlineProfile(){
        for (MinecraftAccount accountToCheck : getAllProfiles()) {
            if (accountToCheck != null) {
                return true;
            }
        }
        return false;
    }""",
    "hasOnlineProfile 接受离线账号",
)

# 2) 「本地登录」按钮直接进离线登录页
patch(
    "net/kdt/pojavlaunch/fragments/SelectAuthFragment.java",
    "mLocalButton.setOnClickListener(v -> hasNoOnlineProfileDialog(requireActivity(), () -> Tools.swapFragment(requireActivity(), LocalLoginFragment.class, LocalLoginFragment.TAG, null)));",
    "mLocalButton.setOnClickListener(v -> Tools.swapFragment(requireActivity(), LocalLoginFragment.class, LocalLoginFragment.TAG, null));",
    "本地登录不再弹「需要正版」对话框",
)

# 3) 离线登录页不再自动跳回主菜单
patch(
    "net/kdt/pojavlaunch/fragments/LocalLoginFragment.java",
    """        // This is overkill but meh
        if (!hasOnlineProfile()){
            Tools.swapFragment(requireActivity(), MainMenuFragment.class, MainMenuFragment.TAG, null);
        }
""",
    "",
    "离线登录页不再被踢回主菜单",
)
