#!/usr/bin/env python3
"""TS→Python 迁移差分对拍（S6 收尾工具）。

对一组只读端点，分别请求两个服务（默认 Python 本地 3001；参考实现可指向还活着的
旧 Node/回放服务），归一化 requestId/时间戳等易变字段后比较 JSON。

用法：
    python scripts/diff_check.py                     # 只打 Python 健康
    python scripts/diff_check.py --ref http://127.0.0.1:3101   # 与参考服务差分
"""
import argparse
import json
import sys
import urllib.request

READ_ENDPOINTS = [
    "/api/health",
    "/api/boards",
]


def volatile(o):
    """递归抹掉 requestId 与动态时间类字段，便于比较。"""
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in ("requestId",):
                continue
            out[k] = volatile(v)
        return out
    if isinstance(o, list):
        return [volatile(x) for x in o]
    return o


def fetch(base: str, path: str):
    with urllib.request.urlopen(base + path, timeout=10) as r:
        return r.status, volatile(json.loads(r.read().decode("utf-8")))


def main() -> int:
    ap = argparse.ArgumentParser(description="Samryetha python vs reference diff")
    ap.add_argument("--base", default="http://127.0.0.1:3001")
    ap.add_argument("--ref")
    args = ap.parse_args()
    ok = True
    for p in READ_ENDPOINTS:
        st, body = fetch(args.base, p)
        print(f"[python] {st} {p}")
        if args.ref:
            rst, rbody = fetch(args.ref, p)
            same = body == rbody
            ok = ok and same
            print(f"[ref   ] {rst} {p}  {'SAME' if same else 'DIFF'}")
            if not same:
                print("  py:", json.dumps(body, ensure_ascii=False)[:400])
                print("  ts:", json.dumps(rbody, ensure_ascii=False)[:400])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
