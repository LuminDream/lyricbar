/* liblyrics.js — 歌词获取与同步
 *
 * 顺序：本地 .lrc  →  磁盘缓存  →  LRCLIB（开放 API，含同步歌词）  →  网易云（中文曲库兜底）
 * 全部异步（libsoup 3），不阻塞界面；失败一律静默回退到"标题-歌手"。
 */

var GLib = imports.gi.GLib;
var Gio = imports.gi.Gio;

// 系统同时装了 libsoup2 与 libsoup3，必须显式选 3.0（与 Cinnamon 自带一致）
try { imports.gi.versions.Soup = '3.0'; } catch (e) {}
var Soup = imports.gi.Soup;

var USER_AGENT = 'lyricbar-cinnamon/1.0';
var _session = null;

/* ------------------------------ 基础工具 ------------------------------ */

function _http() {
    if (!_session) {
        _session = new Soup.Session();
        try { _session.timeout = 10; } catch (e) {}
    }
    return _session;
}

function _bytesToString(data) {
    try {
        if (data === null || data === undefined) return '';
        if (typeof data === 'string') return data;
        if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(data);
        return imports.byteArray.toString(data);
    } catch (e) { return ''; }
}

function enc(s) {
    try { return encodeURIComponent(String(s)); } catch (e) {}
    try { return GLib.uri_escape_string(String(s), null, false); } catch (e) {}
    return String(s);
}

function safeJson(txt) {
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
}

function httpGet(url, headers, cb) {
    try {
        var msg = Soup.Message.new('GET', url);
        if (!msg) { cb(null); return; }
        var h = msg.get_request_headers();
        try { h.append('User-Agent', USER_AGENT); } catch (e) {}
        try { h.append('Accept', 'application/json, text/plain, */*'); } catch (e) {}
        if (headers) {
            for (var k in headers) {
                try { h.append(k, headers[k]); } catch (e) {}
            }
        }
        _http().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, function (sess, res) {
            var text = null;
            try {
                var bytes = sess.send_and_read_finish(res);
                var st = msg.get_status();
                if (st === Soup.Status.OK) text = _bytesToString(bytes.get_data());
            } catch (e) {}
            try { cb(text); } catch (e) { global.logError('lyricbar/http: ' + e); }
        });
    } catch (e) { cb(null); }
}

function _readFile(path) {
    try {
        var ok, data;
        [ok, data] = GLib.file_get_contents(path);
        if (!ok || data === null) return null;
        return _bytesToString(data);
    } catch (e) { return null; }
}

function _writeFile(path, text) {
    try { return GLib.file_set_contents(path, text); } catch (e) { return false; }
}

/* --------------------------------- LRC -------------------------------- */

var TIME_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

function parseLrc(text) {
    var res = { synced: false, lines: [], offset: 0 };
    if (!text) return res;

    var raw = String(text).split(/\r?\n/);
    var out = [];
    var offset = 0;

    for (var i = 0; i < raw.length; i++) {
        var line = raw[i];
        if (!line) continue;

        var offM = line.match(/^\[offset:\s*([+-]?\d+)\]/i);
        if (offM) { offset = parseInt(offM[1], 10) || 0; continue; }

        var stamps = [];
        var m;
        TIME_RE.lastIndex = 0;
        while ((m = TIME_RE.exec(line)) !== null) {
            var min = parseInt(m[1], 10);
            var sec = parseInt(m[2], 10);
            var frac = 0;
            if (m[3]) {
                frac = parseInt(m[3], 10);
                if (m[3].length === 1) frac *= 100;
                else if (m[3].length === 2) frac *= 10;
            }
            stamps.push(min * 60 + sec + frac / 1000);
        }
        if (!stamps.length) continue;

        TIME_RE.lastIndex = 0;
        var txt = line.replace(TIME_RE, '').trim();
        for (var j = 0; j < stamps.length; j++) out.push({ t: stamps[j], text: txt });
    }

    if (!out.length) return res;
    out.sort(function (a, b) { return a.t - b.t; });
    res.lines = out;
    res.synced = true;
    res.offset = offset / 1000;
    return res;
}

function plainToLines(text) {
    var raw = String(text || '').split(/\r?\n/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var t = raw[i].trim();
        if (t) out.push({ t: out.length * 5, text: t });
    }
    return out;
}

/* ----------------------------- 本地 .lrc 查找 ----------------------------- */

function findLocalLrc(meta) {
    if (!meta) return null;
    var candidates = [];

    // 1) 音频文件同目录同名（来自 xesam:url）
    if (meta.url && String(meta.url).indexOf('file://') === 0) {
        try {
            var path = GLib.filename_from_uri(String(meta.url))[0];
            if (path) {
                var base = path.replace(/\.[^.\/\\]+$/, '');
                candidates.push(base + '.lrc');
                candidates.push(base + '.LRC');
                candidates.push(base + '.Lrc');
            }
        } catch (e) {}
    }

    // 2) 常用歌词目录
    var home = GLib.get_home_dir();
    var dirs = [
        home + '/Music', home + '/音乐',
        home + '/Music/lyrics', home + '/Music/Lyrics',
        home + '/音乐/歌词'
    ];
    var title = meta.title || '';
    var artist = meta.artist || '';
    for (var i = 0; i < dirs.length; i++) {
        if (artist && title) candidates.push(dirs[i] + '/' + artist + ' - ' + title + '.lrc');
        if (title) candidates.push(dirs[i] + '/' + title + '.lrc');
    }

    for (var j = 0; j < candidates.length; j++) {
        try {
            if (GLib.file_test(candidates[j], GLib.FileTest.EXISTS)) return candidates[j];
        } catch (e) {}
    }
    return null;
}

/* --------------------------------- 缓存 -------------------------------- */

function _cacheDir() {
    var d = GLib.get_user_cache_dir() + '/lyricbar';
    try { GLib.mkdir_with_parents(d, 448); } catch (e) {}   // 0700
    return d;
}

function _hashKey(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'k' + (h >>> 0).toString(16);
}

function readCache(key) {
    try {
        var p = _cacheDir() + '/' + _hashKey(key) + '.json';
        var txt = _readFile(p);
        if (!txt) return null;
        var obj = safeJson(txt);
        if (!obj || !obj.lines || !obj.lines.length) return null;
        return obj;
    } catch (e) { return null; }
}

function writeCache(key, value) {
    try {
        return _writeFile(_cacheDir() + '/' + _hashKey(key) + '.json',
                          JSON.stringify({ source: value.source, synced: !!value.synced, lines: value.lines }));
    } catch (e) { return false; }
}

/* ------------------------------- 歌词服务 ------------------------------- */

var LyricsService = class LyricsService {
    constructor(cfg) {
        this.cfg = cfg || {};
        this._mem = {};
        this._memKeys = [];
    }

    _key(meta) {
        return String(meta.artist || '') + '|' + String(meta.title || '') + '|' +
               (meta.length ? Math.round(meta.length / 5) : 0);
    }

    _remember(key, val) {
        this._mem[key] = val;
        this._memKeys.push(key);
        while (this._memKeys.length > 24) {
            var k = this._memKeys.shift();
            delete this._mem[k];
        }
    }

    request(meta, cb) {
        var self = this;
        if (!meta || (!meta.title && !meta.artist)) { cb(null); return; }

        var key = this._key(meta);

        if (this._mem[key]) { cb(this._mem[key]); return; }

        // 1) 本地 .lrc
        if (this.cfg.localFirst !== false) {
            var lp = findLocalLrc(meta);
            if (lp) {
                var parsed = parseLrc(_readFile(lp));
                if (parsed.lines.length) {
                    var r = { source: 'local', path: lp, synced: parsed.synced, lines: parsed.lines };
                    this._remember(key, r);
                    cb(r);
                    return;
                }
            }
        }

        // 2) 磁盘缓存
        var cached = readCache(key);
        if (cached) {
            this._remember(key, cached);
            cb(cached);
            return;
        }

        // 3) 联网
        if (this.cfg.online === false) { cb(null); return; }

        this._lrclib(meta, function (res) {
            if (res) { self._remember(key, res); writeCache(key, res); cb(res); return; }
            self._netease(meta, function (res2) {
                if (res2) { self._remember(key, res2); writeCache(key, res2); cb(res2); return; }
                cb(null);
            });
        });
    }

    _fromLrclib(obj, source) {
        if (!obj) return null;
        var plain = obj.plainLyrics || '';
        var parsed = parseLrc(obj.syncedLyrics || '');
        if (parsed.lines.length) {
            return { source: source, synced: true, lines: parsed.lines };
        }
        var lines = plainToLines(plain);
        if (lines.length) return { source: source, synced: false, lines: lines };
        return null;
    }

    _lrclib(meta, cb) {
        var self = this;

        // ① 宽松精确匹配：只传 曲名+歌手，避免 album/duration 差异导致 404
        var base = [];
        if (meta.title) base.push('track_name=' + enc(meta.title));
        if (meta.artist) base.push('artist_name=' + enc(meta.artist));
        if (!base.length) { cb(null); return; }

        var tryGet = function (url, next) {
            httpGet(url, null, function (txt) {
                var obj = safeJson(txt);
                if (obj && (obj.syncedLyrics || obj.plainLyrics)) {
                    var r = self._fromLrclib(obj, 'lrclib');
                    if (r) { cb(r); return; }
                }
                next();
            });
        };

        tryGet('https://lrclib.net/api/get?' + base.join('&'), function () {
            // ② 再带 album / duration
            var full = base.slice();
            if (meta.album) full.push('album_name=' + enc(meta.album));
            if (meta.length) full.push('duration=' + Math.round(meta.length));

            tryGet('https://lrclib.net/api/get?' + full.join('&'), function () {
                // ③ 搜索兜底
                httpGet('https://lrclib.net/api/search?' + base.join('&'), null, function (t2) {
                    var arr = safeJson(t2);
                    if (Array.isArray(arr) && arr.length) {
                        var best = null;
                        for (var i = 0; i < arr.length; i++) {
                            if (arr[i] && arr[i].syncedLyrics) { best = arr[i]; break; }
                        }
                        if (!best) {
                            for (var j = 0; j < arr.length; j++) {
                                if (arr[j] && arr[j].plainLyrics) { best = arr[j]; break; }
                            }
                        }
                        if (best) {
                            var r2 = self._fromLrclib(best, 'lrclib-search');
                            if (r2) { cb(r2); return; }
                        }
                    }
                    cb(null);
                });
            });
        });
    }

    _netease(meta, cb) {
        var wantTitle = String(meta.title || '').trim();
        var wantArtist = String(meta.artist || '').trim();
        var q = (wantTitle + ' ' + wantArtist).trim();
        if (!q) { cb(null); return; }

        var headers = {
            'Referer': 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
        };
        var url = 'https://music.163.com/api/search/get/web?s=' + enc(q) + '&type=1&limit=10';

        httpGet(url, headers, function (txt) {
            var obj = safeJson(txt);
            var songs = obj && obj.result && obj.result.songs;
            if (!songs || !songs.length) { cb(null); return; }

            var norm = function (s) {
                return String(s || '').toLowerCase()
                    .replace(/\s+/g, '')
                    .replace(/[（(].*?[)）]/g, '')
                    .replace(/[【\[].*?[\]】]/g, '')
                    .trim();
            };
            var wt = norm(wantTitle);
            var wa = norm(wantArtist);

            // 打分：曲名精确 +5；歌手命中 +4，不符 -6 → 宁可没有，也不给错歌词
            var best = null, bestScore = -1;
            for (var i = 0; i < songs.length; i++) {
                var s = songs[i];
                if (!s || !s.id) continue;
                var st = norm(s.name);
                var artists = [];
                if (s.artists) {
                    for (var k = 0; k < s.artists.length; k++) artists.push(norm(s.artists[k].name));
                }
                var score = 0;
                if (st && st === wt) score += 5;
                else if (st && wt && (st.indexOf(wt) >= 0 || wt.indexOf(st) >= 0)) score += 2;
                if (wa) {
                    var hit = false;
                    for (var m = 0; m < artists.length; m++) {
                        var a = artists[m];
                        if (!a) continue;
                        if (a === wa || a.indexOf(wa) >= 0 || wa.indexOf(a) >= 0) { hit = true; break; }
                    }
                    score += hit ? 4 : -6;
                }
                if (score > bestScore) { bestScore = score; best = s; }
            }
            if (!best || bestScore < 3) { cb(null); return; }

            var lurl = 'https://music.163.com/api/song/lyric?id=' + best.id + '&lv=-1&kv=-1&tv=-1';
            httpGet(lurl, headers, function (t2) {
                var lobj = safeJson(t2);
                if (!lobj || !lobj.lrc || !lobj.lrc.lyric) { cb(null); return; }
                var parsed = parseLrc(lobj.lrc.lyric);
                if (!parsed.lines.length) { cb(null); return; }
                cb({ source: 'netease', synced: parsed.synced, lines: parsed.lines });
            });
        });
    }
};
