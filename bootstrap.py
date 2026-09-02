#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Samryetha 开发环境一键引导（Python/FastAPI 后端 + React 前端）。

用法：
    python bootstrap.py                # 检查环境 + 装依赖 + 生成 .env
    python bootstrap.py --dev          # 以上全部，再同时启动前后端 dev server
    python bootstrap.py --skip-install --dev   # 依赖装过了，直接起服务

说明：后端为 Python(FastAPI)，SQLite 存量库直接打开无需迁移；内建 admin/dev
账号在服务启动时幂等确保。前端仍为 Node/React（vite SSR）。
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


def run(cmd: list[str], cwd: Path, check: bool = True) -> bool:
    """在当前目录跑一条命令，直接透传输出。Windows 下经 shell 以解析 .cmd。"""
    print(f"  $ {' '.join(cmd)}   [{cwd.name}]")
    joined = " ".join(cmd) if IS_WINDOWS else cmd
    proc = subprocess.run(joined if IS_WINDOWS else cmd, cwd=cwd, shell=IS_WINDOWS)
    if check and proc.returncode != 0:
        sys.exit(f"[x] 命令失败: {' '.join(cmd)} (exit {proc.returncode})")
    return proc.returncode == 0


def capture(cmd: list[str]) -> str:
    joined = " ".join(cmd) if IS_WINDOWS else cmd
    proc = subprocess.run(joined if IS_WINDOWS else cmd, shell=IS_WINDOWS,
                          capture_output=True, text=True)
    return (proc.stdout or "").strip()


def check_prereqs() -> None:
    print("==> 检查环境")
    missing = []
    if shutil.which("uv") is None:
        missing.append("uv")
    if shutil.which("python") is None and shutil.which("python3") is None:
        missing.append("python")
    # 前端
    if shutil.which("node") is None:
        missing.append("node")
    if shutil.which("pnpm") is None:
        missing.append("pnpm")
    if missing:
        sys.exit(f"[x] 缺少工具: {', '.join(missing)}，请先安装")
    uv_out = capture(["uv", "--version"]) or "?"
    node_out = capture(["node", "--version"]) or "?"
    print(f"[ok] uv {uv_out} / node {node_out} / pnpm {capture(['pnpm', '--version'])}")


def install() -> None:
    print("\n==> 安装后端依赖 (uv sync)")
    run(["uv", "sync"], BACKEND)
    print("\n==> 安装前端依赖 (pnpm install)")
    run(["pnpm", "install"], FRONTEND)


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
    print("    （上线前记得改 ADMIN_PASSWORD / DEV_PASSWORD / STORAGE_SECRET）")


def start_dev() -> None:
    procs: list[subprocess.Popen] = []

    def launch(cmd: list[str], cwd: Path, name: str) -> None:
        print(f"\n==> 启动 {name}")
        joined = " ".join(cmd) if IS_WINDOWS else cmd
        procs.append(subprocess.Popen(joined if IS_WINDOWS else cmd,
                                      cwd=cwd, shell=IS_WINDOWS))

    launch(["uv", "run", "python", "-m", "samryetha.main"], BACKEND, "backend  (http://localhost:3001)")
    time.sleep(2)
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
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Samryetha 开发环境引导")
    parser.add_argument("--dev", action="store_true", help="初始化完成后启动前后端 dev server")
    parser.add_argument("--skip-install", action="store_true", help="跳过依赖安装")
    args = parser.parse_args()

    print(f"Samryetha bootstrap @ {ROOT}\n")

    check_prereqs()
    if not args.skip_install:
        install()
    setup_env()

    print("\n[+] 环境就绪。")
    if args.dev:
        start_dev()
    else:
        print("    加 --dev 直接起前后端：python bootstrap.py --dev")


if __name__ == "__main__":
    main()
