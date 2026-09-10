#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
权限说明完整性校验：解析 AndroidManifest.xml 的权限声明，
逐条在 docs/publish/android/权限说明.md 中查找对应说明。

用法：python verify_permission_doc.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
MANIFEST = os.path.join(
    REPO, "src", "mobile", "android", "app", "src", "main", "AndroidManifest.xml"
)
DOC = os.path.join(os.path.dirname(HERE), "权限说明.md")


def main():
    with open(MANIFEST, encoding="utf-8") as f:
        manifest = f.read()
    with open(DOC, encoding="utf-8") as f:
        doc = f.read()

    # 1) <uses-permission android:name="..."/>  —— 取 android.permission 后面的短名
    uses = re.findall(r'<uses-permission\s+android:name="([^"]+)"', manifest)
    uses_perms = [u.rsplit(".", 1)[-1] for u in uses]

    # 2) 组件级 android:permission="..." on service/receiver/activity
    comp = re.findall(r'android:permission="([^"]+)"', manifest)
    comp_perms = [c.rsplit(".", 1)[-1] for c in comp]

    print(f"Manifest: {os.path.relpath(MANIFEST, REPO)}")
    print(f"  uses-permission bodies : {len(uses_perms)}")
    print(f"  component permissions  : {len(comp_perms)}")
    print(f"  total                  : {len(uses_perms) + len(comp_perms)}")
    print()

    missing = []
    print(f"{'permission':42} {'in docs':8}")
    print("-" * 54)
    for p in uses_perms + comp_perms:
        present = p in doc
        if not present:
            missing.append(p)
        print(f"{p:42} {('YES' if present else 'MISSING'):8}")

    # 3) cleartext 专项
    print()
    cleartext = 'usesCleartextTraffic="true"' in manifest
    doc_cleartext = "usesCleartextTraffic" in doc
    print(f'manifest has usesCleartextTraffic="true" : {cleartext}')
    print(f"doc covers cleartext section             : {doc_cleartext}")

    print()
    if missing:
        print(f"*** MISSING IN DOC: {missing} ***")
        return 1
    if cleartext and not doc_cleartext:
        print("*** cleartext not documented ***")
        return 1
    print("ALL PERMISSIONS DOCUMENTED — no gaps")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
