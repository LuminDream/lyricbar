# 播放器支持说明

状态栏歌词插件 通过 MPRIS 读取播放器状态，通过 PipeWire 判断是否真的在出声。

## 支持情况

| 播放器 | 曲目信息 | 播放控制 | 进度 | 备注 |
|---|---|---|---|---|
| Rhythmbox | 是 | 是 | 是 | 原生 MPRIS |
| VLC | 是 | 是 | 是 | `vlc` 需启用 MPRIS 接口 |
| Spotify | 是 | 是 | 是 | 原生 MPRIS |
| Chrome / Chromium | 是 | 是 | 是 | 网页媒体会话 |
| Firefox | 是 | 是 | 是 | 需 `media.hardwaremediakeys.enabled` |
| mpv | 是 | 是 | 是 | 需 `--script` 或 MPRIS 插件 |
| YesPlayMusic | 标题兜底 | 是 | 是 | 见下文 |

## YesPlayMusic

### 问题一：MPRIS 未注册

YesPlayMusic 启动时会先检查「OSD Lyrics 支持」：

```js
if (settings.enableOsdlyricsSupport) {
    await bus.getProxyObject("org.osdlyrics.Daemon", ...)
}
// 之后才是 MPRIS 初始化
```

系统没有安装 `osdlyrics` 时，`getProxyObject` 抛异常，后面的 MPRIS 初始化被跳过。
表现是：播放器正常运行，但 `org.mpris.MediaPlayer2.yesplaymusic` 不存在。

处理方式：关闭该选项并重启应用。

```bash
CFG="$HOME/.config/yesplaymusic/config.json"
cp "$CFG" "$CFG.bak"
python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault('settings', {})['enableOsdlyricsSupport'] = False
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
PY
```

验证：

```bash
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.ListNames | grep yesplaymusic
```

### 问题二：Metadata 为空

YesPlayMusic 注册的 MPRIS 接口会返回空的 `Metadata`（`@a{sv} {}`），只有
`PlaybackStatus` 和 `Position` 有值。

状态栏歌词插件 的处理：读取播放器窗口标题，格式为

```
歌名 · 歌手 - YesPlayMusic
```

通过 `Meta.Window` 的 `notify::title` 事件获取，不轮询。最小化时依然可读。

如果标题只有 `YesPlayMusic`（没有曲目），插件会视为无内容并保持隐藏。

## 音频判定

MPRIS 的 `PlaybackStatus=Playing` 不代表真的有声音。Chromium/Electron 暂停时仍会保留音频流，
`pactl` 里的 `Corked` 也常常仍是 `no`。

因此插件以 PipeWire 节点状态为准：

```bash
pw-dump | python3 -c '
import sys, json
for o in json.load(sys.stdin):
    if o.get("type") != "PipeWire:Interface:Node":
        continue
    i = o.get("info", {}); p = i.get("props", {}) or {}
    if p.get("media.class") != "Stream/Output/Audio":
        continue
    print(o["id"], i.get("state"), p.get("application.process.binary"))
'
```

`state=running` 表示正在出声；`idle` / `suspended` 表示静默。

## 多播放器

规则：

1. 设置了「优先播放器」→ 固定使用它
2. 否则只在有 `running` 音频流的播放器中选择
3. 多个同时出声 → 取最近开始播放的（比较进入 Playing 的时间）
4. 都没有音频流 → 退化为 MPRIS 自报状态：Playing 优先，其次 Paused
5. 无任何播放器 → 隐藏

## 适配新播放器

如果播放器的 MPRIS 名与进程名对不上，在 `libaudio.js` 与 `libmpris.js` 的
`normalizeKey`（`_normKey`）中加一条映射即可，例如：

```js
if (s.indexOf('foobar2000') >= 0) return 'foobar';
```

两处保持一致。
