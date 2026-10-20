#!/usr/bin/env bash
set -euo pipefail

UUID="lyricbar@local"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"

mkdir -p "$DEST"
cp applet.js metadata.json settings-schema.json stylesheet.css \
   libmpris.js libaudio.js liblyrics.js "$DEST/"

echo "状态栏歌词插件 已安装到: $DEST"
echo "接下来: 系统设置 → 面板 → 添加小程序 → 状态栏歌词插件"
echo "提示: 没有播放器时插件会自动隐藏，开始播放后自动出现"
