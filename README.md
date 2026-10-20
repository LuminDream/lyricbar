# 状态栏歌词插件

Cinnamon 面板上的单行歌词与媒体控制小程序。

播放音乐时在面板里显示当前歌词，并提供上一首、播放/暂停、下一首。没有播放时自动收起，不占用面板空间。

![Cinnamon](https://img.shields.io/badge/Cinnamon-5.x%20%7C%206.x-2ea44f)
![Platform](https://img.shields.io/badge/Platform-X11-lightgrey)
![PipeWire](https://img.shields.io/badge/PipeWire-1.0%2B-important)
![License](https://img.shields.io/badge/License-MIT-blue)
![Version](https://img.shields.io/badge/Version-1.1.0-orange)

![预览](screenshots/lyricbar.png)

折叠效果：

| 紧凑模式 | 仅图标 |
|---|---|
| ![紧凑](screenshots/compact.png) | ![仅图标](screenshots/mini.png) |

## 功能

- **单行同步歌词**：按播放进度逐行滚动，单行显示，过长自动省略
- **媒体控制**：上一首 / 播放暂停 / 下一首
- **自动折叠**：按面板剩余宽度在「完整 → 紧凑 → 仅图标」之间切换，带滞回避免抖动，不挤压其它面板图标
- **自动显示 / 隐藏**：无播放器时收起；暂停时保留（暂停不等于退出）
- **按实时音频选择播放器**：网页播放器与本地播放器同时打开时，显示当前真正在出声的那一个
- **多歌词源**：本地 `.lrc` → 磁盘缓存 → LRCLIB → 网易云
- **网页视频支持**：暴露 MPRIS 的浏览器页面可显示标题并控制
- **事件驱动**：MPRIS 信号、窗口标题变化、PipeWire 音频流事件，不做周期轮询
- **字体跟随系统**：不写死字体族，与面板时钟保持一致

## 适用系统与版本

| 项目 | 要求 / 测试环境 |
|---|---|
| 桌面环境 | Cinnamon 5.x / 6.x<br>**实测：Cinnamon 6.6.9** |
| 操作系统 | Linux Mint 22.x（基于 Ubuntu 24.04 LTS）<br>**实测：Linux Mint 22.3** |
| 其它发行版 | 任何使用 Cinnamon 的 Linux 发行版（Arch、Debian、Fedora 等），只要 Cinnamon 与 PipeWire 版本符合即可 |
| 会话类型 | **X11**（使用 Meta.Window 读取播放器窗口标题）<br>Wayland 会话未测试 |
| 音频服务 | **PipeWire 1.0+**<br>**实测：pipewire-pulse 1.0.5** |
| 内核 | 6.x / 7.x<br>**实测：7.0.0-38-generic（HWE）** |
| 架构 | x86_64（实测）；arm64 未测试 |
| 播放器 | 支持 MPRIS 的播放器，见 [docs/PLAYER_SUPPORT.md](docs/PLAYER_SUPPORT.md) |
| 网络 | 在线歌词需要访问 `lrclib.net`、`music.163.com`；可关闭 |
| 权限 | 普通用户，无需 sudo |

### 依赖检查

```bash
command -v pactl pw-dump
```

| 缺失项 | 影响 |
|---|---|
| `pactl` | 无法判断音频流，多播放器仲裁失效；单播放器仍可用 |
| `pw-dump` | 自动降级为 `pactl` 解析，暂停/静音流判定精度下降 |

## 安装

### 方式一：安装脚本

下载或克隆本仓库后：

```bash
cd 状态栏歌词插件
./install.sh
```

### 方式二：手动复制

```bash
mkdir -p ~/.local/share/cinnamon/applets
cp -r . ~/.local/share/cinnamon/applets/lyricbar@local
```

需要的文件：

```
applet.js  metadata.json  settings-schema.json  stylesheet.css
libmpris.js  libaudio.js  liblyrics.js
```

### 添加到面板

打开 **系统设置 → 面板 → 添加小程序**，选择「状态栏歌词插件」。
建议放在面板右侧。

## 使用

| 操作 | 效果 |
|---|---|
| 左键单击胶囊 | 播放 / 暂停 |
| 中键单击 | 下一首 |
| 滚轮 | 快退 / 快进 5 秒 |
| 悬停 | 查看曲目、歌手、专辑、歌词来源 |
| 右键 → 配置 | 打开设置 |

### 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 显示模式 | 自动折叠 | 自动 / 完整 / 紧凑 / 仅图标 |
| 歌词最大宽度 | 220 | 完整模式下歌词区宽度（逻辑像素） |
| 显示音乐图标 | 开 | 左侧音符图标 |
| 无播放时自动隐藏 | 开 | 无播放器时收起；暂停仍显示 |
| 优先使用本地 .lrc | 开 | 先找音频同目录与 `~/Music` |
| 允许联网搜索歌词 | 开 | LRCLIB → 网易云 |
| 显示译文 | 关 | 预留项 |
| 优先播放器 | 空 | 留空自动；也可填 MPRIS 名，如 `org.mpris.MediaPlayer2.yesplaymusic` |
| 滚轮快进/快退 | 开 | ±5 秒 |

## 歌词匹配顺序

1. **本地**：音频同目录同名 `.lrc`；`~/Music`、`~/音乐`、`~/Music/lyrics` 下的 `歌手 - 歌名.lrc` / `歌名.lrc`
2. **缓存**：`~/.cache/lyricbar/`
3. **LRCLIB**：先用曲名 + 歌手精确查询，再带专辑 / 时长，最后搜索兜底
4. **网易云**：按曲名 + 歌手打分匹配；歌名或歌手不符时宁可不显示，也不返回错误歌词
5. 都没有：显示「歌名 - 歌手」

## 播放器支持

标准 MPRIS 播放器开箱即用：Rhythmbox、VLC、Spotify、Chrome / Chromium、Firefox、mpv 等。

特殊情况与适配方法见 [docs/PLAYER_SUPPORT.md](docs/PLAYER_SUPPORT.md)，包括：

- YesPlayMusic 的 MPRIS 注册问题与标题兜底
- PipeWire 节点状态判定（`running` / `idle`）
- 多播放器仲裁规则
- 适配新播放器的 key 映射

## 工作原理

```
MPRIS 播放器 ──PropertiesChanged / Seeked──┐
Meta.Window ──notify::title───────────────┼─→ 选择播放器 → 拉歌词 → 单行显示
pactl subscribe ──音频流事件──→ pw-dump ──┘
```

- **播放器发现**：`NameOwnerChanged`，播放器启动 / 退出即时感知
- **实时音频判定**：`pactl subscribe` 触发，`pw-dump` 读取节点 `state`；只有 `running` 才算真正出声
- **多播放器仲裁**：优先使用指定播放器；否则只在实际出声的播放器中选择；多个同时出声时取最近开始播放的
- **歌词定位**：播放时用 500ms 本地插值推进，每 5 秒与播放器对时一次，避免漂移
- **暂停 / 退出**：`Paused` 保留显示；播放器从 D-Bus 消失才隐藏
- 所有外部命令以 `LC_ALL=C` 启动，避免本地化输出导致解析失败

## 已知限制

- 不暴露 MPRIS 的播放器无法控制
- 同步歌词依赖 `.lrc` 时间戳；无时间戳时按 5 秒轮播
- Chromium 只提供粗粒度媒体信息，个别网站可能没有曲目元数据
- 在线歌词匹配不到时只显示标题，不会显示错误歌词
- Wayland 会话未适配

## 目录结构

```
状态栏歌词插件/
├── applet.js              # 界面、布局、事件编排
├── libmpris.js            # MPRIS 播放器发现与状态订阅
├── libaudio.js            # PipeWire 实时音频检测
├── liblyrics.js           # LRC 解析、本地/在线歌词与缓存
├── metadata.json
├── settings-schema.json
├── stylesheet.css
├── install.sh
├── docs/
│   └── PLAYER_SUPPORT.md
├── screenshots/
│   ├── lyricbar.png
│   ├── compact.png
│   └── mini.png
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 常见问题

**Q：面板上没有插件？**
没有播放器时插件会自动隐藏，开始播放后出现。若长期不出现，检查播放器是否暴露 MPRIS：

```bash
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.ListNames | grep mpris
```

**Q：有声音但显示「未在播放」？**
播放器没有 MPRIS，或 MPRIS 注册失败。YesPlayMusic 的处理见 `docs/PLAYER_SUPPORT.md`。

**Q：歌词不显示？**
先确认曲名 / 歌手能被在线歌词库匹配；也可在音频同目录放同名 `.lrc`。

**Q：暂停后插件消失了？**
本版本已区分暂停与退出；若仍消失，确认安装的是 1.1.0 及以上版本。

**Q：修改 `lib*.js` 不生效？**
Cinnamon 按模块名缓存 JS，需重命名模块或重启 Cinnamon（Alt+F2 → `r`）。

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请执行：

```bash
node --check applet.js
node --check libmpris.js
node --check libaudio.js
node --check liblyrics.js
python3 -m json.tool settings-schema.json > /dev/null
```

并在 Cinnamon 6.x + PipeWire 环境下实际播放验证一次。

## 版本

当前版本 `1.1.0`，变更见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT License，见 [LICENSE](LICENSE)。
