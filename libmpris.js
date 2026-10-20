/* libmpris.js — MPRIS 事件驱动封装
 *
 * 设计要点：
 *   1. 完全事件驱动：订阅 DBus PropertiesChanged / Seeked / NameOwnerChanged，不做轮询；
 *   2. 不依赖 GDBusProxy 的属性缓存（无 interface-info 时不可靠），直接订阅原生 DBus 信号；
 *   3. 单个播放器对象自持有订阅，销毁时精确退订，互不影响（封装性/鲁棒性）。
 */

var Gio = imports.gi.Gio;
var GLib = imports.gi.GLib;

var MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
var MPRIS_PATH = '/org/mpris/MediaPlayer2';
var PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
var ROOT_IFACE = 'org.mpris.MediaPlayer2';
var PROPS_IFACE = 'org.freedesktop.DBus.Properties';

/* 把 MPRIS 名 / 进程名归一成同一个 key，用于与音频流对齐 */
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
    return s.replace('org.mpris.mediaplayer2.', '');
}

/* a{sv} 里的值常常仍是 GLib.Variant 包装，统一拆一层 */
function unv(v) {
    try {
        if (v === null || v === undefined) return v;
        if (typeof v.deep_unpack === 'function') return v.deep_unpack();
    } catch (e) {}
    return v;
}

/* 从形如 (v) 的返回值里取第 idx 个值（GJS 的 deep_unpack 对嵌套 v 不可靠） */
function readValue(top, idx) {
    try {
        var c = top.get_child_value(idx);
        if (c.get_type_string() === 'v') c = c.get_variant();
        return c.deep_unpack();
    } catch (e) {
        try { return unv(top.deep_unpack()[idx]); } catch (e2) { return null; }
    }
}

function parseMetadata(md) {
    md = unv(md);
    var o = { title: '', artist: '', album: '', artUrl: '', length: 0, url: '', trackid: '' };
    if (!md) return o;
    try {
        var title = unv(md['xesam:title']);
        if (title !== undefined && title !== null) o.title = String(title);

        var a = unv(md['xesam:artist']);
        if (a !== undefined && a !== null) {
            if (Array.isArray(a)) {
                o.artist = a.map(unv)
                           .filter(function (x) { return x !== null && x !== undefined && x !== ''; })
                           .join(', ');
            } else {
                o.artist = String(a);
            }
        }

        var album = unv(md['xesam:album']);
        if (album !== undefined && album !== null) o.album = String(album);

        var art = unv(md['mpris:artUrl']);
        if (art !== undefined && art !== null) o.artUrl = String(art);

        var len = unv(md['mpris:length']);
        if (len !== undefined && len !== null) {
            var n = Number(len);
            if (isFinite(n) && n > 0) o.length = n / 1000000;
        }

        var url = unv(md['xesam:url']);
        if (url !== undefined && url !== null) o.url = String(url);

        var tid = unv(md['mpris:trackid']);
        if (tid !== undefined && tid !== null) o.trackid = String(tid);
    } catch (e) {}
    return o;
}

/* ------------------------------- 单个播放器 ------------------------------- */

var Player = class Player {
    constructor(busName, onChanged) {
        this.busName = busName;
        this.identity = busName.replace(MPRIS_PREFIX, '');
        this.status = 'Stopped';
        this.meta = parseMetadata(null);
        this.canPlay = true;
        this.canPause = true;
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.canSeek = false;
        this.position = 0;          // 秒
        this._posStamp = 0;         // 位置被显式更新时自增（供外部判断是否重设基准）
        this.playStartedAt = 0;     // 最近一次进入 Playing 的时刻（多播放器仲裁用）
        this._onChanged = onChanged;
        this._subs = [];
        this._destroyed = false;
        this._refreshAll();
        this._subscribe();
    }

    _emit() {
        if (this._destroyed) return;
        try { this._onChanged(this); } catch (e) { global.logError('lyricbar/mpris: ' + e); }
    }

    _applyDict(rawDict) {
        if (!rawDict) return;
        var dict = {};
        try {
            for (var key in rawDict) dict[key] = unv(rawDict[key]);
        } catch (e) { dict = rawDict; }

        var dirty = false;
        try {
            if (dict['PlaybackStatus'] !== undefined) {
                var st = String(dict['PlaybackStatus']);
                if (st !== this.status) {
                    this.status = st;
                    if (st === 'Playing') this.playStartedAt = GLib.get_monotonic_time();
                }
                dirty = true;
            }
            if (dict['Metadata'] !== undefined) {
                this.meta = parseMetadata(dict['Metadata']); dirty = true;
            }
            if (dict['CanPlay'] !== undefined) this.canPlay = !!dict['CanPlay'];
            if (dict['CanPause'] !== undefined) this.canPause = !!dict['CanPause'];
            if (dict['CanGoNext'] !== undefined) this.canGoNext = !!dict['CanGoNext'];
            if (dict['CanGoPrevious'] !== undefined) this.canGoPrevious = !!dict['CanGoPrevious'];
            if (dict['CanSeek'] !== undefined) this.canSeek = !!dict['CanSeek'];
            if (dict['Position'] !== undefined) {
                var p = Number(dict['Position']);
                if (isFinite(p) && p >= 0) { this.position = p / 1000000; this._posStamp++; }
            }
        } catch (e) {}
        if (dirty) this._emit();
    }

    _refreshAll() {
        var self = this;
        try {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'GetAll',
                new GLib.Variant('(s)', [PLAYER_IFACE]), new GLib.VariantType('(a{sv})'),
                Gio.DBusCallFlags.NONE, 3000, null, function (conn, res) {
                    if (self._destroyed) return;
                    try {
                        var dict = conn.call_finish(res).deep_unpack()[0];
                        self._applyDict(dict);
                    } catch (e) {}
                });
        } catch (e) {}

        try {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [ROOT_IFACE, 'Identity']), new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 3000, null, function (conn, res) {
                    if (self._destroyed) return;
                    try {
                        var v = readValue(conn.call_finish(res), 0);
                        if (v) { self.identity = String(v); self._emit(); }
                    } catch (e) {}
                });
        } catch (e) {}
    }

    _subscribe() {
        var self = this;
        try {
            this._subs.push(Gio.DBus.session.signal_subscribe(
                this.busName, PROPS_IFACE, 'PropertiesChanged', MPRIS_PATH, PLAYER_IFACE,
                Gio.DBusSignalFlags.NONE,
                function (conn, sender, path, iface, sig, params) {
                    if (self._destroyed) return;
                    try { self._applyDict(params.deep_unpack()[1]); } catch (e) {}
                }));

            this._subs.push(Gio.DBus.session.signal_subscribe(
                this.busName, PLAYER_IFACE, 'Seeked', MPRIS_PATH, null,
                Gio.DBusSignalFlags.NONE,
                function (conn, sender, path, iface, sig, params) {
                    if (self._destroyed) return;
                    try {
                        var v = Number(params.deep_unpack()[0]);
                        if (isFinite(v) && v >= 0) {
                            self.position = v / 1000000;
                            self._posStamp++;
                            self._emit();
                        }
                    } catch (e) {}
                }));
        } catch (e) {}
    }

    call(method) {
        try {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, PLAYER_IFACE, method, null, null,
                Gio.DBusCallFlags.NONE, 3000, null, function () {});
        } catch (e) {}
    }

    seekRelative(seconds) {
        try {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, PLAYER_IFACE, 'Seek',
                new GLib.Variant('(x)', [Math.round(seconds * 1000000)]), null,
                Gio.DBusCallFlags.NONE, 3000, null, function () {});
        } catch (e) {}
    }

    getPosition(cb) {
        var self = this;
        try {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 2000, null, function (conn, res) {
                    if (self._destroyed) { if (cb) cb(null); return; }
                    try {
                        var v = Number(readValue(conn.call_finish(res), 0));
                        if (isFinite(v) && v >= 0) { self.position = v / 1000000; self._posStamp++; }
                    } catch (e) {}
                    // 位置被刷新 → 通知外部重设插值基准
                    self._emit();
                    if (cb) cb(self.position);
                });
        } catch (e) { if (cb) cb(this.position); }
    }

    destroy() {
        this._destroyed = true;
        for (var i = 0; i < this._subs.length; i++) {
            try { Gio.DBus.session.signal_unsubscribe(this._subs[i]); } catch (e) {}
        }
        this._subs = [];
    }
};

/* ------------------------------- 管理器 ------------------------------- */

var PlayerManager = class PlayerManager {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._players = {};          // busName -> Player
        this._active = null;
        this._lastActive = null;
        this._preferred = '';
        this._audioKeys = null;      // 实时音频：key -> 最新节点 id
        this._subs = [];
        this._started = false;
        this._destroyed = false;
    }

    start() {
        if (this._started) return;
        this._started = true;
        var self = this;

        try {
            this._subs.push(Gio.DBus.session.signal_subscribe(
                'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
                function (conn, sender, path, iface, sig, params) {
                    if (self._destroyed) return;
                    try {
                        var p = params.deep_unpack();
                        var name = p[0], newOwner = p[2];
                        if (String(name).indexOf(MPRIS_PREFIX) !== 0) return;
                        if (newOwner && String(newOwner).length > 0) self._add(name);
                        else self._remove(name);
                    } catch (e) {}
                }));
        } catch (e) {}

        try {
            Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, 3000, null, function (conn, res) {
                    if (self._destroyed) return;
                    try {
                        var names = conn.call_finish(res).deep_unpack()[0];
                        for (var i = 0; i < names.length; i++) {
                            if (String(names[i]).indexOf(MPRIS_PREFIX) === 0) self._add(names[i]);
                        }
                    } catch (e) {}
                    self._select(true);
                });
        } catch (e) {}
    }

    _add(busName) {
        if (this._destroyed || this._players[busName]) return;
        var self = this;
        this._players[busName] = new Player(busName, function (p) { self._onPlayerChanged(p); });
        this._select(false);
    }

    _remove(busName) {
        var p = this._players[busName];
        if (!p) return;
        try { p.destroy(); } catch (e) {}
        delete this._players[busName];
        if (this._lastActive === busName) this._lastActive = null;
        if (this._active && this._active.busName === busName) this._active = null;
        this._select(true);
    }

    _onPlayerChanged(player) {
        if (this._destroyed) return;
        // 有播放器开始播放 → 抢占为当前
        if (player.status === 'Playing' && (!this._active || this._active !== player)) {
            this._select(true);
            return;
        }
        if (this._active === player) this._emit();
    }

    _select(force) {
        var names = Object.keys(this._players);
        var chosen = null;

        // ① 指定播放器优先
        if (this._preferred && this._players[this._preferred]) chosen = this._preferred;

        // ② 实时音频优先：只在"确实在出声"的播放器里选；多个则取最近开始播放的
        if (!chosen && this._audioKeys) {
            var best = null, bestAt = -1;
            for (var k = 0; k < names.length; k++) {
                var p2 = this._players[names[k]];
                var key = _normKey(names[k]);
                if (this._audioKeys[key] === undefined) continue;
                var at = p2.playStartedAt || 0;
                if (at > bestAt) { bestAt = at; best = names[k]; }
            }
            if (best) chosen = best;
        }

        // ③ 退化为 MPRIS 自报状态：Playing → 保持可见；Paused 也保留（区分"暂停"与"退出"）
        if (!chosen) {
            for (var i = 0; i < names.length; i++) {
                if (this._players[names[i]].status === 'Playing') { chosen = names[i]; break; }
            }
        }
        if (!chosen) {
            for (var j = 0; j < names.length; j++) {
                if (this._players[names[j]].status === 'Paused') { chosen = names[j]; break; }
            }
        }

        if (!chosen && this._lastActive && this._players[this._lastActive]) chosen = this._lastActive;
        if (!chosen && this._active && this._players[this._active.busName]) chosen = this._active.busName;
        if (!chosen && names.length) chosen = names[0];

        this._active = chosen ? this._players[chosen] : null;
        if (chosen) this._lastActive = chosen;
        if (force || this._active) this._emit();
    }

    /* 外部（音频监测）注入：正在出声的 key → 最新节点 id */
    setAudioState(map) {
        this._audioKeys = map || null;
        this._select(true);
    }

    _emit() {
        if (this._destroyed) return;
        try { this._onChanged(); } catch (e) { global.logError('lyricbar/pm: ' + e); }
    }

    setPreferred(name) {
        this._preferred = name || '';
        this._select(true);
    }

    getActive() { return this._active; }

    getPlayerNames() { return Object.keys(this._players); }

    playPause() {
        var p = this._active;
        if (!p) return;
        p.call('PlayPause');
    }

    next() {
        var p = this._active;
        if (!p || !p.canGoNext) return;
        p.call('Next');
    }

    previous() {
        var p = this._active;
        if (!p || !p.canGoPrevious) return;
        p.call('Previous');
    }

    destroy() {
        this._destroyed = true;
        for (var k in this._players) {
            try { this._players[k].destroy(); } catch (e) {}
        }
        this._players = {};
        for (var i = 0; i < this._subs.length; i++) {
            try { Gio.DBus.session.signal_unsubscribe(this._subs[i]); } catch (e) {}
        }
        this._subs = [];
    }
};
