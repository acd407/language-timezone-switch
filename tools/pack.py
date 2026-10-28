#!/usr/bin/env python3
"""打包扩展：生成 dist/<name>-<version>.zip 与 .xpi（两者内容相同，只是扩展名不同）。

- 只打包运行期必需的文件，test/ tools/ reference/ .pi/ dist/ 一律不进包
- 固定时间戳 + 排序，同样的源码永远得到同样的字节（方便对比发布产物）

用法：
    python3 tools/pack.py            # 两个都生成
    python3 tools/pack.py --only zip
"""

import argparse
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 打进包里的东西（目录会被递归展开）
INCLUDE = [
    "manifest.json",
    "common.js",
    "worker.js",
    "icons",
    "inject",
    "options",
    "popup",
    "LICENSE",
    "NOTICE.md",
    "README.md",
]

# 明确禁止进包的东西（防止 INCLUDE 里误加目录）
FORBIDDEN_PREFIXES = ("test/", "tools/", "reference/", ".pi/", "dist/", ".git/")


def fail(message):
    sys.exit("pack: " + message)


def load_manifest():
    path = os.path.join(ROOT, "manifest.json")
    if not os.path.exists(path):
        fail("找不到 manifest.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as error:
        fail("manifest.json 不是合法 JSON：%s" % error)


def check_manifest_references(manifest):
    """manifest 里声明的文件必须真的存在，否则装上去会静默失效。"""
    refs = []
    refs += list(manifest.get("icons", {}).values())
    action = manifest.get("action", {})
    refs += list(action.get("default_icon", {}).values())
    if "default_popup" in action:
        refs.append(action["default_popup"])
    options = manifest.get("options_ui", {})
    if "page" in options:
        refs.append(options["page"])
    background = manifest.get("background", {})
    if "service_worker" in background:
        refs.append(background["service_worker"])
    refs += list(background.get("scripts", []))

    missing = [r for r in refs if not os.path.exists(os.path.join(ROOT, r))]
    if missing:
        fail("manifest.json 引用了不存在的文件：" + ", ".join(sorted(set(missing))))
    return refs


def collect_files():
    files = []
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if not os.path.exists(path):
            fail("缺少必需文件：" + item)
        if os.path.isdir(path):
            for base, dirs, names in os.walk(path):
                dirs.sort()
                for name in sorted(names):
                    if name.startswith("."):
                        continue
                    files.append(os.path.join(base, name))
        else:
            files.append(path)

    for path in files:
        arc = os.path.relpath(path, ROOT).replace(os.sep, "/")
        if arc.startswith(FORBIDDEN_PREFIXES):
            fail("不该被打包的文件：" + arc)
    return files


def build(files, version, name, ext):
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, "%s-%s.%s" % (name, version, ext))

    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            arc = os.path.relpath(path, ROOT).replace(os.sep, "/")
            # 固定 mtime，保证构建可复现
            info = zipfile.ZipInfo(arc, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, "rb") as handle:
                archive.writestr(info, handle.read())

    size = os.path.getsize(out)
    print("  %-46s %3d files  %6.1f KB" % (os.path.relpath(out, ROOT), len(files), size / 1024))
    return out


def main():
    parser = argparse.ArgumentParser(description="打包扩展")
    parser.add_argument("--only", choices=["zip", "xpi"], help="只生成一种产物")
    args = parser.parse_args()

    manifest = load_manifest()
    version = manifest.get("version")
    if not version:
        fail("manifest.json 里没有 version 字段")

    slug = "site-language-timezone-switch"
    check_manifest_references(manifest)
    files = collect_files()

    # MANIFEST_VERSION 之外的基本完整性检查
    if manifest.get("manifest_version") != 3:
        fail("预期 manifest_version = 3，实际是 %r" % manifest.get("manifest_version"))
    if "manifest.json" not in [os.path.relpath(f, ROOT) for f in files]:
        fail("manifest.json 必须位于包根目录")

    print("打包 %s v%s" % (slug, version))
    targets = [args.only] if args.only else ["zip", "xpi"]
    for ext in targets:
        build(files, version, slug, ext)


if __name__ == "__main__":
    main()
