/* 状态栏歌词插件 — 状态栏歌词 applet
 *
 * 布局：[音乐图标] [单行歌词 ...........] | [上一首][播放/暂停][下一首]
 *
 * 设计要点：
 *   1. 高度与面板一致；
 *   2. 字体族/字重不写死 → 继承 #panel 系统字体，与时钟一致；
 *   3. 完全事件驱动：MPRIS 信号 + 仅在播放时启动的 500ms 内插值 ticker；
 *   4. 空间不足自动折叠（full → compact → mini），并带滞回避免抖动；
 *   5. 每个播放器独立订阅、销毁精确退订；所有回调 try/catch，单点故障不影响面板。
 */

const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Pango = imports.gi.Pango;
const Tooltips = imports.ui.tooltips;

const UUID = 'lyricbar@local';

// 本地模块：把 applet 目录加入搜索路径后再 import（Cinnamon 标准做法）
try {
    const APPLET_PATH = imports.ui.appletManager.appletMeta[UUID].path;
    if (APPLET_PATH && imports.searchPath.indexOf(APPLET_PATH) < 0)
        imports.searchPath.unshift(APPLET_PATH);
} catch (e) {}

const Mpris = imports.libmpris;
const Lyrics = imports.liblyrics;
const Audio = imports.libaudio;

const A_CENTER = Clutter.ActorAlign.CENTER;
const A_START = Clutter.ActorAlign.START;

const TICK_MS = 500;          // 歌词定位（纯本地计算，不访问 DBus）
const RESYNC_SEC = 5;         // 每 5 秒与播放器对一次时间，纠正漂移
const PLAIN_ROTATE_SEC = 5;   // 无同步歌词时的轮播间隔

function LyricBarApplet(metadata, orientation, panelId, instanceId) {
    this._init(metadata, orientation, panelId, instanceId);
}

LyricBarApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function (metadata, orientation, panelId, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panelId, instanceId);
        try { this.setAllowedLayout(Applet.AllowedLayout.BOTH); } catch (e) {}

        this._panelId = panelId;
        this._orientation = orientation;

        // 状态
        this._player = null;
        this._trackKey = '';
        this._lines = [];
        this._synced = false;
        this._lineIndex = -1;
        this._plainIndex = -1;
        this._plainLast = 0;
        this._playing = false;
        this._basePos = 0;
        this._baseTime = 0;
        this._posStamp = -1;
        this._lastPStatus = null;
        this._loadSeq = 0;
        this._lyricText = '';
        this._lastAutoMode = null;
        this._tickTimer = null;
        this._resyncTimer = null;
        this._heightSig = null;
        this._widthSig = null;

        // 设置默认值（Settings 绑定后会覆盖）
        this.mode = 'auto';
        this.lyricWidth = 220;
        this.showArt = true;
        this.localFirst = true;
        this.onlineLyrics = true;
        this.showTranslation = false;
        this.preferredPlayer = '';
        this.scrollSeek = true;
        this.autoHide = true;

        try {
            this.actor.add_style_class_name('lyricbar-applet');
            this.actor.remove_style_class_name('applet-box');
            this.actor.set_style('padding: 0; margin: 0;');
        } catch (e) {}

        this._buildUI();
        this._initSettings(metadata, instanceId);

        this._svc = new Lyrics.LyricsService({
            localFirst: this.localFirst,
            online: this.onlineLyrics
        });

        // MPRIS 管理器（事件驱动）
        this._pm = new Mpris.PlayerManager(this._onManagerChanged.bind(this));
        this._pm.start();

        // 实时音频监测（事件驱动）：用于在多播放器共存时判定"此刻谁真的在出声"
        this._audio = new Audio.AudioMonitor(this._onAudioChanged.bind(this));
        this._audio.start();

        // YesPlayMusic 兜底：它的 MPRIS 不推送 Metadata，但窗口标题始终正确
        // 形如 "总会 · 刘惜君 - YesPlayMusic"，用 Meta.Window 的 notify::title 事件驱动读取
        this._ypmWindow = null;
        this._ypmMeta = null;
        this._titleSig = null;
        this._setupWindowWatch();

        // 面板尺寸变化 → 重排
        this._watchPanel();
        this._relayout();

        // 初始状态
        this._setLyricText('未在播放');
        try { this._lyric.add_style_class_name('lyricbar-lyric-idle'); } catch (e) {}
        this._refreshControls();

        this._tooltip = new Tooltips.Tooltip(this.actor, '歌词栏');
    },

    /* ------------------------------- UI ------------------------------- */

    _buildUI: function () {
        this._root = new St.BoxLayout({
            style_class: 'lyricbar-root',
            vertical: false,
            x_align: A_CENTER,
            y_align: A_CENTER,
            y_expand: false
        });
        this.actor.add_child(this._root);

        this._pill = new St.BoxLayout({
            style_class: 'lyricbar-pill',
            vertical: false,
            x_align: A_CENTER,
            y_align: A_CENTER
        });
        this._root.add_child(this._pill);

        this._art = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_type: St.IconType.SYMBOLIC,
            style_class: 'lyricbar-art',
            y_align: A_CENTER
        });
        this._pill.add_child(this._art);

        this._lyric = new St.Label({
            text: '',
            style_class: 'lyricbar-lyric',
            y_align: A_CENTER,
            x_align: A_START
        });
        try {
            this._lyric.clutter_text.set_single_line_mode(true);
            this._lyric.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        } catch (e) {}
        this._pill.add_child(this._lyric);

        this._sep = new St.Widget({ style_class: 'lyricbar-sep', y_align: A_CENTER });
        this._pill.add_child(this._sep);

        this._controls = new St.BoxLayout({
            style_class: 'lyricbar-controls',
            vertical: false,
            y_align: A_CENTER
        });
        this._pill.add_child(this._controls);

        this._btnPrev = this._makeButton('media-skip-backward-symbolic', '', function () {
            if (this._pm) this._pm.previous();
        }.bind(this));
        this._btnPlay = this._makeButton('media-playback-start-symbolic', 'lyricbar-btn-main', function () {
            if (this._pm) this._pm.playPause();
        }.bind(this));
        this._btnNext = this._makeButton('media-skip-forward-symbolic', '', function () {
            if (this._pm) this._pm.next();
        }.bind(this));

        this._controls.add_child(this._btnPrev.button);
        this._controls.add_child(this._btnPlay.button);
        this._controls.add_child(this._btnNext.button);

        // 点击胶囊主体（非按钮）→ 播放/暂停
        this.actor.connect('button-press-event', this._onButtonPress.bind(this));

        // 滚轮快进/快退
        this.actor.connect('scroll-event', this._onScroll.bind(this));

        // 悬停高亮由 CSS 处理；这里只做按钮可用性
    },

    _makeButton: function (iconName, extraClass, onClick) {
        var btn = new St.Button({
            style_class: 'lyricbar-btn ' + (extraClass || ''),
            y_align: A_CENTER,
            x_align: A_CENTER,
            can_focus: false,
            reactive: true
        });
        var icon = new St.Icon({
            icon_name: iconName,
            icon_type: St.IconType.SYMBOLIC,
            y_align: A_CENTER
        });
        btn.set_child(icon);
        btn.connect('clicked', function () {
            try { onClick(); } catch (e) { global.logError('lyricbar/btn: ' + e); }
        });
        return { button: btn, icon: icon };
    },

    /* ----------------------------- 设置 ----------------------------- */

    _initSettings: function (metadata, instanceId) {
        try {
            this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
            var self = this;
            var onChange = function () { self._onSettingsChanged(); };

            this.settings.bind('mode', 'mode', onChange);
            this.settings.bind('lyricWidth', 'lyricWidth', onChange);
            this.settings.bind('showArt', 'showArt', onChange);
            this.settings.bind('localFirst', 'localFirst', onChange);
            this.settings.bind('onlineLyrics', 'onlineLyrics', onChange);
            this.settings.bind('showTranslation', 'showTranslation', onChange);
            this.settings.bind('preferredPlayer', 'preferredPlayer', onChange);
            this.settings.bind('scrollSeek', 'scrollSeek', null);
            this.settings.bind('autoHide', 'autoHide', onChange);
        } catch (e) {
            global.logError('lyricbar/settings: ' + e);
        }
    },

    _onSettingsChanged: function () {
        try {
            this._svc.cfg = {
                localFirst: this.localFirst,
                online: this.onlineLyrics
            };
            this._lastAutoMode = null;
            this._relayout();
            if (this._pm) this._pm.setPreferred(this.preferredPlayer);

            // 歌词来源开关变化 → 重新拉一次
            if (this._player) this._loadLyrics(this._effectiveMeta());
            this._refreshControls();
            this._updateVisibility();
        } catch (e) {
            global.logError('lyricbar/settings-change: ' + e);
        }
    },

    /* --------------------------- 面板与布局 --------------------------- */

    _getPanel: function () {
        try {
            var arr = Main.panelManager.panels || [];
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] && arr[i].panelId === this._panelId) return arr[i];
            }
        } catch (e) {}
        return null;
    },

    _logicalPanelHeight: function () {
        try {
            var heights = Main.settings.get('panels-height');
            if (heights) {
                for (var i = 0; i < heights.length; i++) {
                    var parts = String(heights[i]).split(':');
                    if (parts.length === 2 && parseInt(parts[0], 10) === this._panelId) {
                        var v = parseInt(parts[1], 10);
                        if (v > 0) return v;
                    }
                }
            }
        } catch (e) {}
        return 40;
    },

    _watchPanel: function () {
        var panel = this._getPanel();
        if (!panel || !panel.actor) return;
        try {
            this._heightSig = panel.actor.connect('notify::height', this._relayout.bind(this));
            this._widthSig = panel.actor.connect('notify::width', this._relayout.bind(this));
        } catch (e) {}
    },

    _relayout: function () {
        try {
            if (!this.actor.visible) return;   // 隐藏时不参与宽度计算
            var panel = this._getPanel();
            var panelH = panel && panel.actor ? panel.actor.height : 80;
            var logicalH = this._logicalPanelHeight();
            var scale = logicalH > 0 ? (panelH / logicalH) : 2;

            var cssH = Math.max(18, Math.round(panelH / scale) - 4);
            var radius = Math.max(6, Math.round(cssH / 2.4));
            var fontSize = Math.max(11, Math.round(logicalH * 0.35));
            var iconSize = Math.max(10, Math.round(logicalH * 0.40));
            var btnIconSize = Math.max(11, Math.round(logicalH * 0.42));

            this._root.set_style('padding: 0; spacing: 0; font-size: ' + fontSize + 'px;');
            this._pill.set_style(
                'min-height: ' + cssH + 'px;' +
                'border-radius: ' + radius + 'px;' +
                'padding: 0 ' + Math.max(4, Math.round(logicalH * 0.18)) + 'px;'
            );

            this._art.set_icon_size(iconSize);
            this._btnPrev.icon.set_icon_size(btnIconSize);
            this._btnPlay.icon.set_icon_size(btnIconSize);
            this._btnNext.icon.set_icon_size(btnIconSize);

            this._sep.set_style('height: ' + Math.round(cssH * 0.5) + 'px;');

            this._applyResponsive(panel, scale);
            this._refreshControls();
        } catch (e) {
            global.logError('lyricbar/relayout: ' + e);
        }
    },

    _budgetCss: function (panel, scale) {
        try {
            if (!panel || !panel.actor) return this.lyricWidth + 120;
            var panelW = panel.actor.width;
            var leftW = panel._leftBox ? panel._leftBox.width : 0;
            var others = 0;
            var kids = panel._rightBox ? panel._rightBox.get_children() : [];
            for (var i = 0; i < kids.length; i++) {
                if (kids[i] !== this.actor) others += kids[i].width;
            }
            var safety = 24 * scale;
            var budgetDev = panelW - leftW - others - safety;
            return budgetDev / scale;
        } catch (e) {
            return this.lyricWidth + 120;
        }
    },

    _applyResponsive: function (panel, scale) {
        var mode = this.mode || 'auto';
        var want = this.lyricWidth || 220;
        var budgetCss = this._budgetCss(panel, scale);

        if (mode === 'auto') {
            var raw;
            if (budgetCss >= want + 108) raw = 'full';
            else if (budgetCss >= 136) raw = 'compact';
            else raw = 'mini';

            // 滞回：想升级档位需要额外余量，避免来回抖动
            var rank = { mini: 0, compact: 1, full: 2 };
            if (this._lastAutoMode && rank[raw] > rank[this._lastAutoMode]) {
                if (raw === 'full' && budgetCss < want + 132) raw = 'compact';
                else if (raw === 'compact' && budgetCss < 160) raw = 'mini';
            }
            this._lastAutoMode = raw;
            mode = raw;
        }

        var lyricW = 0;
        if (mode === 'full') {
            lyricW = Math.min(want, Math.max(90, Math.round(budgetCss - 112)));
        } else if (mode === 'compact') {
            lyricW = Math.max(68, Math.min(150, Math.round(budgetCss - 70)));
        }

        // 显示/隐藏
        if (mode === 'mini') {
            this._lyric.hide();
            this._sep.hide();
        } else {
            this._lyric.show();
            this._sep.show();
            this._lyric.set_style('width: ' + lyricW + 'px;');
        }

        this._art.visible = !!this.showArt;

        this._modeNow = mode;
        this._refreshControls();
    },

    /* --------------------------- 媒体控制状态 --------------------------- */

    _refreshControls: function () {
        try {
            var p = this._player;
            var playing = !!(p && p.status === 'Playing');
            var hasPlayer = !!p;

            this._btnPlay.icon.set_icon_name(
                playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');

            var mode = this._modeNow || 'full';
            var showSkip = (mode === 'full');

            this._btnPrev.button.visible = showSkip;
            this._btnNext.button.visible = showSkip;

            this._setBtnEnabled(this._btnPrev, hasPlayer && p.canGoPrevious);
            this._setBtnNextEnabled(this._btnNext, hasPlayer && p.canGoNext);
            this._setBtnEnabled(this._btnPlay, hasPlayer);
        } catch (e) {}
    },

    _setBtnEnabled: function (b, enabled) {
        try {
            if (enabled) b.button.remove_style_class_name('lyricbar-btn-disabled');
            else b.button.add_style_class_name('lyricbar-btn-disabled');
        } catch (e) {}
    },

    _setBtnNextEnabled: function (b, enabled) {
        try {
            if (enabled) b.button.remove_style_class_name('lyricbar-btn-disabled');
            else b.button.add_style_class_name('lyricbar-btn-disabled');
        } catch (e) {}
    },

    _onButtonPress: function (actor, event) {
        try {
            // 点在按钮上时交给按钮自己处理
            var src = event.get_source();
            var node = src;
            var guard = 0;
            while (node && guard < 8) {
                if (node instanceof St.Button) return false;
                node = node.get_parent ? node.get_parent() : null;
                guard++;
            }

            var button = event.get_button();
            if (button === 1) {
                if (this._pm) this._pm.playPause();
                return true;
            }
            if (button === 2) {
                if (this._pm) this._pm.next();
                return true;
            }
        } catch (e) {
            global.logError('lyricbar/click: ' + e);
        }
        return false;
    },

    _onScroll: function (actor, event) {
        try {
            if (!this.scrollSeek) return false;
            var p = this._player;
            if (!p || !p.canSeek) return false;
            var d = 0;
            var dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) d = 5;
            else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) d = -5;
            if (!d) return false;
            p.seekRelative(d);
            return true;
        } catch (e) {
            return false;
        }
    },

    /* ---------------------- YesPlayMusic 窗口标题兜底 ---------------------- */

    _setupWindowWatch: function () {
        var self = this;
        try {
            this._winCreatedSig = global.display.connect('window-created', function () {
                self._findYpmWindow();
            });
            this._winDestroyedSig = global.display.connect('window-destroyed', function () {
                self._findYpmWindow();
            });
        } catch (e) {}
        this._findYpmWindow();
    },

    _findYpmWindow: function () {
        var self = this;
        var found = null;
        try {
            // Cinnamon 6.x：窗口 actor 列表挂在 global 上（global.display 没有该方法）
            var actors = null;
            try { actors = global.get_window_actors(); } catch (e) {}
            if (!actors) { try { actors = global.display.get_window_actors(); } catch (e) {} }
            actors = actors || [];
            for (var i = 0; i < actors.length; i++) {
                var w = actors[i] && actors[i].meta_window;
                if (!w) continue;
                var cls = '';
                try { cls = String(w.get_wm_class ? w.get_wm_class() : (w.wm_class || '')).toLowerCase(); } catch (e) {}
                if (cls.indexOf('yesplaymusic') >= 0) { found = w; break; }
            }
        } catch (e) {}

        if (found === this._ypmWindow) {
            this._parseYpmTitle();
            return;
        }

        if (this._ypmWindow && this._titleSig) {
            try { this._ypmWindow.disconnect(this._titleSig); } catch (e) {}
        }
        this._titleSig = null;
        this._ypmWindow = found;

        if (found) {
            this._titleSig = found.connect('notify::title', function () {
                self._parseYpmTitle();
            });
            this._parseYpmTitle();
        } else {
            this._ypmMeta = null;
        }
    },

    _parseYpmTitle: function () {
        var title = '';
        try {
            var w = this._ypmWindow;
            title = String(w.get_title ? w.get_title() : (w.title || ''));
        } catch (e) { return; }

        var m = { title: '', artist: '' };
        var suffix = ' - YesPlayMusic';
        var t = title;
        if (t.length > suffix.length && t.slice(-suffix.length) === suffix)
            t = t.slice(0, t.length - suffix.length);

        if (t && t !== 'YesPlayMusic') {
            var idx = t.lastIndexOf(' · ');
            if (idx > 0) {
                m.title = t.slice(0, idx).trim();
                m.artist = t.slice(idx + 3).trim();
            } else {
                m.title = t.trim();
            }
        }

        var old = this._ypmMeta;
        var changed = (!!old !== !!m.title) ||
                      (old && m.title && (old.title !== m.title || old.artist !== m.artist));
        this._ypmMeta = m.title ? m : null;

        if (changed) {
            this._trackKey = '';        // 强制重新拉歌词
            this._onManagerChanged();
        }
    },

    /* 优先用 MPRIS 元数据；为空时退回窗口标题解析结果 */
    _effectiveMeta: function () {
        var p = this._player;
        if (!p) return null;
        if (p.meta && p.meta.title) return p.meta;
        if (this._ypmMeta && this._ypmMeta.title) {
            return {
                title: this._ypmMeta.title,
                artist: this._ypmMeta.artist,
                album: '',
                artUrl: '',
                length: p.meta ? p.meta.length : 0,
                url: '',
                trackid: p.meta ? p.meta.trackid : ''
            };
        }
        return p.meta;
    },

    /* ----------------------------- MPRIS 回调 ----------------------------- */

    _onAudioChanged: function (streams) {
        try {
            if (this._pm) this._pm.setAudioState(this._audio.runningKeys());
        } catch (e) {
            global.logError('lyricbar/audio-change: ' + e);
        }
    },

    /* 有内容才显示：Playing / Paused 且确有一首歌 → 显示；无播放器或已退出 → 隐藏。
       注意：暂停 ≠ 退出，暂停时保持显示。 */
    _updateVisibility: function () {
        try {
            var p = this._player;
            var meta = this._effectiveMeta() || {};
            var hasTrack = !!(meta.title || meta.artist);
            var show = !!(p && (p.status === 'Playing' || p.status === 'Paused') && hasTrack);

            if (!this.autoHide) show = true;   // 关闭自动隐藏 → 常驻

            if (show) {
                if (!this.actor.visible) {
                    this.actor.show();
                    // 显示后重新计算可用宽度（隐藏期间宽度为 0）
                    Mainloop.timeout_add(80, function () {
                        try { this._relayout(); } catch (e) {}
                        return false;
                    }.bind(this));
                }
            } else {
                if (this.actor.visible) this.actor.hide();
            }
        } catch (e) {
            global.logError('lyricbar/visibility: ' + e);
        }
    },

    _onManagerChanged: function () {
        try {
            var p = this._pm ? this._pm.getActive() : null;

            if (!p) {
                this._player = null;
                this._playing = false;
                this._stopTicker();
                this._lines = [];
                this._synced = false;
                this._trackKey = '';
                this._lyric.add_style_class_name('lyricbar-lyric-idle');
                this._setLyricText('未在播放');
                this._refreshControls();
                this._updateVisibility();
                return;
            }

            var eff = this._effectiveMeta() || { title: '', artist: '', length: 0, trackid: '' };
            var trackKey = p.busName + '|' + (eff.trackid || '') + '|' +
                           (eff.title || '') + '|' + (eff.artist || '') + '|' +
                           (eff.length || 0);
            var trackChanged = (trackKey !== this._trackKey);
            var playerChanged = (this._player !== p);

            this._player = p;

            if (trackChanged || playerChanged) {
                this._trackKey = trackKey;
                this._posStamp = -1;
                this._loadLyrics(eff);
                this._posStamp = p._posStamp;
                this._basePos = p.position;
                this._baseTime = GLib.get_monotonic_time() / 1e6;
            }

            this._playing = (p.status === 'Playing');

            // 播放状态变化 → 让音频监测重新确认"此刻谁在出声"
            if (this._lastPStatus !== p.status) {
                this._lastPStatus = p.status;
                if (this._audio) this._audio.refresh();
            }

            // 仅在播放器显式更新过位置时才重设基准，避免用旧位置覆盖插值
            if (p._posStamp !== this._posStamp) {
                this._posStamp = p._posStamp;
                this._basePos = p.position;
                this._baseTime = GLib.get_monotonic_time() / 1e6;
            }

            if (this._playing) {
                this._startTicker();
                this._startResync();
            } else {
                this._stopTicker();
            }

            this._refreshControls();
            this._updateTooltip(null);
            this._updateVisibility();
        } catch (e) {
            global.logError('lyricbar/manager: ' + e);
        }
    },

    /* ------------------------------ 歌词 ------------------------------ */

    _trackText: function (meta) {
        if (!meta) return '';
        if (meta.title && meta.artist) return meta.title + ' - ' + meta.artist;
        return meta.title || meta.artist || '';
    },

    _setLyricText: function (text) {
        if (this._lyricText === text) return;
        this._lyricText = text;
        try { this._lyric.set_text(text || '♪'); } catch (e) {}
    },

    _loadLyrics: function (meta) {
        var self = this;
        var seq = ++this._loadSeq;

        this._lines = [];
        this._synced = false;
        this._lineIndex = -1;
        this._plainIndex = -1;
        this._plainLast = 0;

        try { this._lyric.add_style_class_name('lyricbar-lyric-idle'); } catch (e) {}
        this._setLyricText(this._trackText(meta));

        if (!meta || (!meta.title && !meta.artist)) return;

        this._svc.request(meta, function (res) {
            if (seq !== self._loadSeq) return;       // 已切歌，丢弃过期结果
            if (!res || !res.lines || !res.lines.length) return;

            self._lines = res.lines;
            self._synced = !!res.synced;
            self._lineIndex = -1;
            self._plainIndex = 0;
            self._plainLast = 0;

            try { self._lyric.remove_style_class_name('lyricbar-lyric-idle'); } catch (e) {}

            if (self._synced) {
                self._showLineAt(self._currentPos());
            } else {
                self._setLyricText(self._lines[0].text || '♪');
            }

            self._updateTooltip(res);
        });
    },

    _currentPos: function () {
        if (!this._playing) return this._basePos;
        return this._basePos + (GLib.get_monotonic_time() / 1e6 - this._baseTime);
    },

    _showLineAt: function (pos) {
        var lines = this._lines;
        if (!lines.length) return;

        var lo = 0, hi = lines.length - 1, idx = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (lines[mid].t <= pos) { idx = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        if (idx < 0) idx = 0;
        if (idx === this._lineIndex) return;

        this._lineIndex = idx;
        var t = (lines[idx].text || '').trim();
        this._setLyricText(t || '♪');
    },

    _updateTooltip: function (res) {
        try {
            var p = this._player;
            if (!p) {
                if (this._tooltip) this._tooltip.set_text('歌词栏 · 未在播放');
                return;
            }
            var meta = this._effectiveMeta() || {};
            var lines = [];
            if (meta.title) lines.push(meta.title);
            if (meta.artist) lines.push(meta.artist);
            if (meta.album) lines.push(meta.album);
            if (res && res.source) lines.push('歌词来源：' + res.source);
            else if (this._lines.length) lines.push('歌词来源：缓存');
            if (this._tooltip) this._tooltip.set_text(lines.join('\n'));
        } catch (e) {}
    },

    /* ------------------------------ 定时器 ------------------------------ */

    _startTicker: function () {
        if (this._tickTimer) return;
        this._tickTimer = Mainloop.timeout_add(TICK_MS, function () {
            try {
                if (!this._playing) return true;
                if (this._synced && this._lines.length) {
                    this._showLineAt(this._currentPos());
                } else if (this._lines.length) {
                    var now = GLib.get_monotonic_time() / 1e6;
                    if (now - this._plainLast >= PLAIN_ROTATE_SEC) {
                        this._plainLast = now;
                        this._plainIndex = (this._plainIndex + 1) % this._lines.length;
                        this._setLyricText(this._lines[this._plainIndex].text || '♪');
                    }
                }
            } catch (e) {}
            return true;
        }.bind(this));
    },

    _stopTicker: function () {
        if (this._tickTimer) {
            try { Mainloop.source_remove(this._tickTimer); } catch (e) {}
            this._tickTimer = null;
        }
    },

    _startResync: function () {
        if (this._resyncTimer) return;
        this._resyncTimer = Mainloop.timeout_add_seconds(RESYNC_SEC, function () {
            try {
                if (this._playing && this._player) this._player.getPosition(null);
            } catch (e) {}
            return true;
        }.bind(this));
    },

    _stopResync: function () {
        if (this._resyncTimer) {
            try { Mainloop.source_remove(this._resyncTimer); } catch (e) {}
            this._resyncTimer = null;
        }
    },

    /* ------------------------------ 生命周期 ------------------------------ */

    on_panel_height_changed: function () {
        this._relayout();
    },

    on_applet_clicked: function () {
        try { if (this._pm) this._pm.playPause(); } catch (e) {}
    },

    on_applet_removed_from_panel: function () {
        this._stopTicker();
        this._stopResync();

        try { if (this._audio) this._audio.stop(); } catch (e) {}
        this._audio = null;

        try { if (this._pm) this._pm.destroy(); } catch (e) {}
        this._pm = null;

        var panel = this._getPanel();
        try {
            if (panel && this._heightSig) panel.actor.disconnect(this._heightSig);
            if (panel && this._widthSig) panel.actor.disconnect(this._widthSig);
        } catch (e) {}
        this._heightSig = null;
        this._widthSig = null;

        try { if (this._tooltip) this._tooltip.destroy(); } catch (e) {}
        this._tooltip = null;

        try { if (this.settings) this.settings.finalize(); } catch (e) {}
        this.settings = null;
    }
};

function main(metadata, orientation, panelId, instanceId) {
    return new LyricBarApplet(metadata, orientation, panelId, instanceId);
}
