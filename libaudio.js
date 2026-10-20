/* libaudio2.js — 实时音频监测（事件驱动）
 *
 * 目的：判断"此刻到底哪个应用在真正出声"。
 *   - MPRIS 的 PlaybackStatus 只说明播放器自认为在播，不代表真的有声音
 *     （Chromium/Electron 暂停时仍保留 sink-input，Corked 常常仍是 no）
 *   - PipeWire 的节点 state 才是真相：running = 真有数据在流；idle/suspended = 静默
 *
 * 事件源：pactl subscribe（音频流增删/cork 变化）
 * 真值源：pw-dump（PipeWire 节点 JSON）
 * 两者结合 = 事件驱动，不做周期轮询。
 *
 * 若 pw-dump 不可用，退化为解析 pactl（Corked 判定），保证不会因缺工具而崩。
 */

var Gio = imports.gi.Gio;
var GLib = imports.gi.GLib;
var Mainloop = imports.mainloop;

var DEBOUNCE_MS = 250;

/* 统一用 C locale 启动外部命令：pactl 的输出会被本地化（如"信宿-输入"），
   过滤/解析都必须基于英文原文 */
function _spawn(argv, flags) {
    var launcher = new Gio.SubprocessLauncher({ flags: flags });
    try {
        launcher.setenv('LC_ALL', 'C', true);
        launcher.setenv('LANG', 'C', true);
        launcher.setenv('LANGUAGE', 'C', true);
    } catch (e) {}
    return launcher.spawnv(argv);
}


function _normKey(s) {
    s = String(s || '').toLowerCase();
    if (s.indexOf('yesplaymusic') >= 0) return 'yesplaymusic';
    if (s.indexOf('chromium') >= 0 || s.indexOf('chrome') >= 0) return 'chromium';
    if (s.indexOf('firefox') >= 0) return 'firefox';
    if (s.indexOf('rhythmbox') >= 0) return 'rhythmbox';
    if (s.indexOf('spotify') >= 0) return 'spotify';
    if (s.indexOf('vlc') >= 0) return 'vlc';
    if (s.indexOf('mpv') >= 0) return 'mpv';
    if (s.indexOf('deadbeef') >= 0) return 'deadbeef';
    if (s.indexOf('strawberry') >= 0 || s.indexOf('clementine') >= 0) return 'strawberry';
    if (s.indexOf('audacious') >= 0) return 'audacious';
    if (s.indexOf('elisa') >= 0) return 'elisa';
    if (s.indexOf('lollypop') >= 0) return 'lollypop';
    if (s.indexOf('amberol') >= 0) return 'amberol';
    return s;
}

var AudioMonitor = class AudioMonitor {
    constructor(onChange) {
        this._onChange = onChange;
        this._proc = null;
        this._stream = null;
        this._debounceId = null;
        this._busy = false;
        this._pending = false;
        this._stopped = false;
        this._restartId = null;
        this._havePwDump = null;   // null=未知
        this._sig = null;          // 状态签名（去重用）
        this.last = [];            // [{key, state, app, binary, id}]
    }

    start() {
        this._stopped = false;
        this._spawnSubscriber();
        this.refresh();
    }

    stop() {
        this._stopped = true;
        if (this._debounceId) {
            try { Mainloop.source_remove(this._debounceId); } catch (e) {}
            this._debounceId = null;
        }
        if (this._restartId) {
            try { Mainloop.source_remove(this._restartId); } catch (e) {}
            this._restartId = null;
        }
        if (this._proc) {
            try { this._proc.force_exit(); } catch (e) {}
            this._proc = null;
        }
        this._stream = null;
    }

    /* ------------------------- pactl subscribe 事件源 ------------------------- */

    _spawnSubscriber() {
        if (this._stopped) return;
        try {
            this._proc = _spawn(
                ['pactl', 'subscribe'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._stream = new Gio.DataInputStream({ base_stream: this._proc.get_stdout_pipe() });
            this._readLine();
        } catch (e) {
            this._proc = null;
            this._stream = null;
            this._scheduleRespawn();
        }
    }

    _readLine() {
        if (this._stopped || !this._stream) return;
        var self = this;
        try {
            this._stream.read_line_async(GLib.PRIORITY_DEFAULT, null, function (s, res) {
                var line = null;
                try {
                    var r = s.read_line_finish_utf8(res);
                    line = r ? r[0] : null;
                } catch (e) {
                    line = null;
                }
                if (line === null) {
                    self._proc = null;
                    self._stream = null;
                    self._scheduleRespawn();
                    return;
                }
                // 只关心音频流相关事件；忽略 client/core 等（避免 pw-dump 自身引发的回环）
                if (line.indexOf('sink-input') >= 0) {
                    self._queue();
                }
                self._readLine();
            });
        } catch (e) {
            this._proc = null;
            this._stream = null;
            this._scheduleRespawn();
        }
    }

    _scheduleRespawn() {
        if (this._stopped || this._restartId) return;
        // 订阅进程意外退出 → 3 秒后自愈重连（鲁棒性）
        this._restartId = Mainloop.timeout_add_seconds(3, function () {
            this._restartId = null;
            if (!this._stopped) this._spawnSubscriber();
            return false;
        }.bind(this));
    }

    _queue() {
        if (this._debounceId) return;
        var self = this;
        this._debounceId = Mainloop.timeout_add(DEBOUNCE_MS, function () {
            self._debounceId = null;
            self.refresh();
            return false;
        });
    }

    /* ----------------------------- 真值查询 ----------------------------- */

    refresh() {
        if (this._stopped) return;
        if (this._busy) { this._pending = true; return; }
        this._busy = true;

        if (this._havePwDump === false) {
            this._refreshFromPactl();
            return;
        }

        var self = this;
        var proc = null;
        try {
            proc = _spawn(['pw-dump'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._havePwDump = false;
            this._refreshFromPactl();
            return;
        }

        proc.communicate_utf8_async(null, null, function (p, res) {
            var out = null;
            try {
                var r = p.communicate_utf8_finish(res);
                out = r ? r[1] : null;
            } catch (e) { out = null; }

            var list = null;
            if (out) list = self._parsePwDump(out);

            if (list === null) {
                self._havePwDump = false;
                self._refreshFromPactl();
                return;
            }

            self._havePwDump = true;
            self._finish(list);
        });
    }

    _parsePwDump(text) {
        try {
            var arr = JSON.parse(text);
            var list = [];
            for (var i = 0; i < arr.length; i++) {
                var o = arr[i];
                if (!o || o.type !== 'PipeWire:Interface:Node') continue;
                var info = o.info || {};
                var props = info.props || {};
                if (props['media.class'] !== 'Stream/Output/Audio') continue;
                var bin = props['application.process.binary'] || '';
                var app = props['application.name'] || '';
                list.push({
                    id: Number(o.id) || 0,
                    state: String(info.state || ''),
                    key: _normKey(bin || app),
                    app: String(app),
                    binary: String(bin)
                });
            }
            return list;
        } catch (e) {
            return null;
        }
    }

    /* 降级：pactl 解析（只有 Corked，没有 running/idle 精度） */
    _refreshFromPactl() {
        var self = this;
        var proc = null;
        try {
            proc = _spawn(['pactl', 'list', 'sink-inputs'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._finish([]);
            return;
        }
        proc.communicate_utf8_async(null, null, function (p, res) {
            var out = '';
            try {
                var r = p.communicate_utf8_finish(res);
                out = (r && r[1]) ? r[1] : '';
            } catch (e) { out = ''; }

            var list = [];
            var blocks = String(out).split(/\n(?=\S)/);
            var idx = 0;
            for (var i = 0; i < blocks.length; i++) {
                var b = blocks[i];
                var bin = '';
                var app = '';
                var mb = b.match(/application\.process\.binary\s*=\s*"?([^"\n]+)"?/);
                if (mb) bin = mb[1].trim();
                var ma = b.match(/application\.name\s*=\s*"?([^"\n]+)"?/);
                if (ma) app = ma[1].trim();
                if (!bin && !app) continue;
                // 中英文 locale 都覆盖：Corked/Corked 抑制
                var corked = /Corked:\s*yes|抑制[:：]\s*是/i.test(b);
                idx++;
                list.push({
                    id: idx,
                    state: corked ? 'idle' : 'running',
                    key: _normKey(bin || app),
                    app: app,
                    binary: bin
                });
            }
            self._finish(list);
        });
    }

    _finish(list) {
        this._busy = false;
        list = list || [];

        // 状态签名去重：内容没变就不通知上层（避免无意义的重选/重排）
        var parts = [];
        for (var i = 0; i < list.length; i++) {
            parts.push(list[i].id + ':' + list[i].state + ':' + list[i].key);
        }
        parts.sort();
        var sig = parts.join('|');

        var changed = (sig !== this._sig);
        this._sig = sig;
        this.last = list;

        if (changed) {
            try { this._onChange(this.last); } catch (e) {
                global.logError('lyricbar/audio: ' + e);
            }
        }

        if (this._pending) {
            this._pending = false;
            // 合并期间的后续事件，再刷新一次
            this._queue();
        }
    }

    /* ---------------------------- 对外查询 ---------------------------- */

    /* 正在出声的应用 key -> 最新（最大 id）的节点 id */
    runningKeys() {
        var map = {};
        for (var i = 0; i < this.last.length; i++) {
            var s = this.last[i];
            if (s.state !== 'running') continue;
            if (map[s.key] === undefined || s.id > map[s.key]) map[s.key] = s.id;
        }
        return map;
    }
};

var normalizeKey = _normKey;
