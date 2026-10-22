#!/bin/bash
# 从已固定版本的官方地址准备任务局部SDK，然后调用仓库构建脚本。
set -euo pipefail
AUDIT_CACHE_DIR="${1:?Usage: bash scripts/setup-evidence-audit.sh /absolute/cache/path}"
case "$AUDIT_CACHE_DIR" in /*) ;; *) echo 'Cache path must be absolute' >&2; exit 2;; esac
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This verified toolchain recipe targets macOS arm64.' >&2
  exit 2
fi
AUDIT_PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$AUDIT_CACHE_DIR"
SDK_ARCHIVE="$AUDIT_CACHE_DIR/cangjie-sdk-mac-aarch64-1.1.3.tar.gz"
STDX_ARCHIVE="$AUDIT_CACHE_DIR/cangjie-stdx-v1.1.3.1-source.tar.gz"
SDK_URL='https://cangjie-lang.cn/v1/files/auth/downLoad?nsId=142267&fileName=cangjie-sdk-mac-aarch64-1.1.3.tar.gz&objectKey=6a19312721f5a8178d6fd225'
STDX_URL='https://codeload.github.com/cangjielanguage/cangjie_stdx/tar.gz/refs/tags/v1.1.3.1'
if [ ! -f "$SDK_ARCHIVE" ]; then curl -fSL --connect-timeout 20 --max-time 600 "$SDK_URL" -o "$SDK_ARCHIVE"; fi
if [ ! -f "$STDX_ARCHIVE" ]; then curl -fSL --connect-timeout 20 --max-time 600 "$STDX_URL" -o "$STDX_ARCHIVE"; fi
printf '%s  %s\n' '7eff8d3b9119535cf3d05cb81526c5df391137dce908d744449f4edb99da3199' "$SDK_ARCHIVE" | shasum -a 256 -c -
printf '%s  %s\n' 'afaf5f11dc5a48b551f0fc6c3303d1fd93add4592ab96424789126c40b3b55f5' "$STDX_ARCHIVE" | shasum -a 256 -c -
if [ ! -d "$AUDIT_CACHE_DIR/cangjie" ]; then tar -xzf "$SDK_ARCHIVE" -C "$AUDIT_CACHE_DIR"; fi
if [ ! -d "$AUDIT_CACHE_DIR/cangjie_stdx-1.1.3.1" ]; then tar -xzf "$STDX_ARCHIVE" -C "$AUDIT_CACHE_DIR"; fi
node "$AUDIT_PROJECT_ROOT/scripts/build-evidence-audit.mjs" --sdk "$AUDIT_CACHE_DIR/cangjie" --stdx-source "$AUDIT_CACHE_DIR/cangjie_stdx-1.1.3.1"
