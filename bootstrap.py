#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Samryetha 开发环境一键引导。

用法：
    python bootstrap.py                # 检查环境 + 装依赖 + 生成 .env + 迁移 + 种子数据
    python bootstrap.py --dev          # 以上全部，再同时启动前后端 dev server
    python bootstrap.py --skip-install --dev   # 依赖装过了，直接起服务
    python bootstrap.py --skip-db      # 跳过迁移和种子数据

任一命令失败即以非零码退出。
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"

IS_WINDOWS = platform.system() == "Windows"
MIN_NODE_MAJOR = 20


def run(cmd: list[str], cwd: Path, check: bool = True) -> bool:
    """在当前目录跑一条命令，直接透传输出。Windows 下经 shell 以解析 .cmd。"""
    print(f"  $ {' '.join(cmd)}   [{cwd.name}]")
    joined = " ".join(cmd) if IS_WINDOWS else cmd
    proc = subprocess.run(joined if IS_WINDOWS else cmd, cwd=cwd, shell=IS_WINDOWS)
    if check and proc.returncode != 0:
        sys.exit(f"[x] 命令失败: {' '.join(cmd)} (exit {proc.returncode})")
    return proc.returncode == 0


def capture(cmd: list[str]) -> str:
    """跑命令并抓 stdout，用于版本探测。"""
    joined = " ".join(cmd) if IS_WINDOWS else cmd
    proc = subprocess.run(joined if IS_WINDOWS else cmd, shell=IS_WINDOWS,
                          capture_output=True, text=True)
    return (proc.stdout or "").strip()


def check_prereqs() -> None:
    print("==> 检查环境")
    missing = [name for name in ("node", "pnpm") if shutil.which(name) is None]
    if missing:
        sys.exit(f"[x] 缺少工具: {', '.join(missing)}，请先安装 node 和 pnpm")

    node_out = capture(["node", "--version"]) or "v0"
    major = int(node_out.lstrip("vV").split(".")[0] or 0)
    if major < MIN_NODE_MAJOR:
        sys.exit(f"[x] 需要 Node >= {MIN_NODE_MAJOR}，当前 {node_out}")
    pnpm_out = capture(["pnpm", "--version"]) or "?"
    print(f"[ok] node {node_out} / pnpm {pnpm_out}")


def install() -> None:
    for d in (BACKEND, FRONTEND):
        print(f"\n==> 安装依赖 [{d.name}]")
        run(["pnpm", "install"], d)


def setup_env() -> None:
    example, target = BACKEND / ".env.example", BACKEND / ".env"
    if target.exists():
        print("[ok] backend/.env 已存在，跳过")
        return
    if not example.exists():
        print("[!] backend/.env.example 不存在，无法生成 .env")
        return
    shutil.copyfile(example, target)
    print("[+] 已从 .env.example 生成 backend/.env")
    print("    （上线前记得改 ALLOWED_EMAIL_DOMAINS / STORAGE_SECRET）")


def db() -> None:
    # 迁移不需要单独跑 drizzle-kit：本项目用 node:sqlite 内置驱动（sqlite-proxy），
    # server 与 seed 启动时都会自动执行 ./drizzle 下的迁移（runMigrations 默认开启）。
    # drizzle-kit migrate 反而需要 better-sqlite3 驱动，项目不装，会直接报错。
    print("\n==> 写入种子数据（会自动执行迁移）")
    run(["pnpm", "seed"], BACKEND)


def start_dev() -> None:
    procs: list[subprocess.Popen] = []

    def launch(cmd: list[str], cwd: Path, name: str) -> None:
        print(f"\n==> 启动 {name}")
        joined = " ".join(cmd) if IS_WINDOWS else cmd
        procs.append(subprocess.Popen(joined if IS_WINDOWS else cmd,
                                      cwd=cwd, shell=IS_WINDOWS))

    launch(["pnpm", "dev"], BACKEND, "backend  (http://localhost:3001)")
    time.sleep(1)
    launch(["pnpm", "dev"], FRONTEND, "frontend (http://localhost:3000)")

    print("\n  backend  -> http://localhost:3001")
    print("  frontend -> http://localhost:3000")
    print("  Ctrl+C 一起退出\n")

    try:
        while True:
            if any(p.poll() is not None for p in procs):
                print("\n[!] 有服务进程退出了")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[.] 关闭服务...")
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


def main() -> None:
    # Windows 下管道/重定向时 Python 默认按 GBK 输出，Git Bash / VS Code 终端按
    # UTF-8 解码会乱码。强制 UTF-8 输出保持一致。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Samryetha 开发环境引导")
    parser.add_argument("--dev", action="store_true",
                        help="初始化完成后启动前后端 dev server")
    parser.add_argument("--skip-install", action="store_true",
                        help="跳过 pnpm install")
    parser.add_argument("--skip-db", action="store_true",
                        help="跳过迁移与种子数据")
    args = parser.parse_args()

    print(f"Samryetha bootstrap @ {ROOT}\n")

    check_prereqs()
    if not args.skip_install:
        install()
    setup_env()
    if not args.skip_db:
        db()

    print("\n[+] 环境就绪。")
    if args.dev:
        start_dev()
    else:
        print("    加 --dev 直接起前后端：python bootstrap.py --dev")


if __name__ == "__main__":
    main()
