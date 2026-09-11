/*
 * cloud.js — tài khoản chủ tiệm + đồng bộ lịch sử qua Supabase.
 *
 * BA LUẬT BẤT DI BẤT DỊCH (app chấm turn chạy giữa ca đông khách, không được phép đứng):
 *   1. App phải chạy đủ chức năng khi KHÔNG có file này, KHÔNG có mạng, hoặc CHƯA khai khoá.
 *   2. Không hàm nào ném lỗi ra ngoài. Thất bại trả { ok: false, error: 'câu tiếng Anh cho UI' }.
 *   3. Đẩy lên thì tự động; KÉO VỀ phải do người bấm, vì kéo nhầm là đè mất dữ liệu hôm nay.
 *
 * Thư viện Supabase tải từ CDN, ghim đúng phiên bản. Bản UMD đặt biến toàn cục `supabase`.
 * Mất mạng → script không tải được → loadSdk() trả false, app im lặng chạy tiếp offline.
 */
(function (root) {
  'use strict';

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
  var CFG_KEY = 'nail-turn-cloud';      // { url, key } — khoá anon, vốn là khoá công khai
  var DIRTY_KEY = 'nail-turn-cloud-dirty'; // [ 'YYYY-MM-DD', ... ] ngày chưa đẩy lên được
  var T_DAYS = 'nail_days';
  var T_ROSTER = 'nail_roster';

  var sdkPromise = null;
  var client = null;
  var clientFor = '';      // url+key đang dùng, đổi khoá thì dựng lại client
  var authWatchers = [];
  var lastUser = null;

  // ── Khoá kết nối ──────────────────────────────────────
  function getConfig() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY));
      if (c && typeof c.url === 'string' && typeof c.key === 'string' && c.url && c.key) return c;
    } catch (e) { /* hỏng thì coi như chưa khai */ }
    return null;
  }
  function setConfig(url, key) {
    url = String(url || '').trim().replace(/\/+$/, '');
    key = String(key || '').trim();
    if (!/^https:\/\/[^\s/]+/.test(url)) return { ok: false, error: 'Project URL must start with https://' };
    if (key.length < 20) return { ok: false, error: 'The anon key looks too short — copy the whole key.' };
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ url: url, key: key })); }
    catch (e) { return { ok: false, error: 'Could not save the keys on this machine.' }; }
    client = null; clientFor = '';
    return { ok: true };
  }
  function clearConfig() {
    try { localStorage.removeItem(CFG_KEY); } catch (e) {}
    client = null; clientFor = ''; lastUser = null;
  }
  function isConfigured() { return !!getConfig(); }

  // ── Nạp thư viện (chỉ khi đã khai khoá) ───────────────
  function sdkReady() { return !!(root.supabase && root.supabase.createClient); }
  function loadSdk() {
    if (sdkReady()) return Promise.resolve(true);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      var s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () { done(sdkReady()); };
      s.onerror = function () { done(false); };
      document.head.appendChild(s);
      // Mạng tiệm chập chờn: quá 15 giây coi như không có, đừng treo người dùng
      setTimeout(function () { done(sdkReady()); }, 15000);
    }).then(function (v) {
      /*
       * CHỈ nhớ kết quả THÀNH CÔNG. Nếu nhớ cả thất bại thì mạng chớp một cái lúc mở app
       * là đến hết phiên mọi lần bấm đăng nhập đều báo "không có mạng", dù mạng đã về —
       * người dùng phải tải lại trang mới thoát, mà họ không đoán ra điều đó.
       * Xoá thẻ <script> hỏng luôn, để lần thử sau tải lại từ đầu thay vì dùng bản lỗi trong cache.
       */
      if (!v) {
        sdkPromise = null;
        var bad = document.querySelector('script[src="' + SDK_URL + '"]');
        if (bad && bad.parentNode) bad.parentNode.removeChild(bad);
      }
      return v;
    });
    return sdkPromise;
  }

  // Trả client đã sẵn sàng, hoặc null kèm lý do đọc được cho UI.
  function getClient() {
    var cfg = getConfig();
    if (!cfg) return Promise.resolve({ ok: false, error: 'No Supabase project connected yet.' });
    var sig = cfg.url + '|' + cfg.key;
    if (client && clientFor === sig) return Promise.resolve({ ok: true, client: client });
    return loadSdk().then(function (ready) {
      if (!ready) return { ok: false, error: 'Could not load the Supabase library — check the internet connection.' };
      try {
        client = root.supabase.createClient(cfg.url, cfg.key, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'nail-turn-auth' },
        });
        clientFor = sig;
        client.auth.onAuthStateChange(function (_evt, session) {
          lastUser = session && session.user ? session.user : null;
          authWatchers.forEach(function (fn) { try { fn(lastUser); } catch (e) {} });
        });
        return { ok: true, client: client };
      } catch (e) {
        return { ok: false, error: 'Bad Supabase keys — check the URL and the anon key.' };
      }
    });
  }

  function onAuth(fn) { authWatchers.push(fn); }

  // ── Tài khoản ─────────────────────────────────────────
  function currentUser() {
    return getClient().then(function (r) {
      if (!r.ok) return null;
      return r.client.auth.getSession().then(function (res) {
        lastUser = res && res.data && res.data.session ? res.data.session.user : null;
        return lastUser;
      }).catch(function () { return null; });
    });
  }

  function signIn(email, password) {
    return getClient().then(function (r) {
      if (!r.ok) return r;
      return r.client.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') })
        .then(function (res) {
          if (res.error) return { ok: false, error: netMsg(res.error) };
          lastUser = res.data.user;
          return { ok: true, user: res.data.user };
        });
    }).catch(function (e) { return { ok: false, error: netMsg(e) }; });
  }

  function signUp(email, password) {
    return getClient().then(function (r) {
      if (!r.ok) return r;
      return r.client.auth.signUp({ email: String(email || '').trim(), password: String(password || '') })
        .then(function (res) {
          if (res.error) return { ok: false, error: netMsg(res.error) };
          // Dự án bật xác nhận email → chưa có session, phải mở mail bấm link trước
          if (!res.data.session) return { ok: true, user: res.data.user, needsEmailConfirm: true };
          lastUser = res.data.user;
          return { ok: true, user: res.data.user };
        });
    }).catch(function (e) { return { ok: false, error: netMsg(e) }; });
  }

  function signOut() {
    return getClient().then(function (r) {
      if (!r.ok) return r;
      return r.client.auth.signOut().then(function () { lastUser = null; return { ok: true }; });
    }).catch(function (e) { return { ok: false, error: netMsg(e) }; });
  }

  function netMsg(e) {
    var m = (e && e.message) || String(e || '');
    if (/fetch|network|Failed to fetch/i.test(m)) return 'Cannot reach Supabase — check the internet connection.';
    return m || 'Unknown error.';
  }

  // ── Hàng đợi ngày chưa đẩy được ───────────────────────
  function dirtyList() {
    try {
      var d = JSON.parse(localStorage.getItem(DIRTY_KEY));
      return Array.isArray(d) ? d.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function markDirty(date) {
    var d = dirtyList();
    if (d.indexOf(date) < 0) d.push(date);
    try { localStorage.setItem(DIRTY_KEY, JSON.stringify(d.slice(-400))); } catch (e) {}
  }
  function clearDirty(dates) {
    var keep = dirtyList().filter(function (x) { return dates.indexOf(x) < 0; });
    try { localStorage.setItem(DIRTY_KEY, JSON.stringify(keep)); } catch (e) {}
  }

  // ── Lịch sử ngày ──────────────────────────────────────
  // Đẩy 1 ngày. Thất bại → ghi vào hàng đợi để lần đăng nhập sau tự đẩy bù.
  function pushDays(records) {
    var list = (records || []).filter(function (r) { return r && r.date; });
    if (!list.length) return Promise.resolve({ ok: true, pushed: 0 });
    return getClient().then(function (r) {
      if (!r.ok) { list.forEach(function (x) { markDirty(x.date); }); return r; }
      return r.client.auth.getUser().then(function (u) {
        var uid = u && u.data && u.data.user ? u.data.user.id : null;
        if (!uid) { list.forEach(function (x) { markDirty(x.date); }); return { ok: false, error: 'Not signed in.' }; }
        var rows = list.map(function (rec) {
          return { user_id: uid, day: rec.date, data: rec, updated_at: new Date().toISOString() };
        });
        return r.client.from(T_DAYS).upsert(rows, { onConflict: 'user_id,day' }).then(function (res) {
          if (res.error) { list.forEach(function (x) { markDirty(x.date); }); return { ok: false, error: netMsg(res.error) }; }
          clearDirty(list.map(function (x) { return x.date; }));
          return { ok: true, pushed: rows.length };
        });
      });
    }).catch(function (e) {
      list.forEach(function (x) { markDirty(x.date); });
      return { ok: false, error: netMsg(e) };
    });
  }

  function pullDays() {
    return getClient().then(function (r) {
      if (!r.ok) return r;
      return r.client.from(T_DAYS).select('day,data').order('day', { ascending: false }).limit(1000)
        .then(function (res) {
          if (res.error) return { ok: false, error: netMsg(res.error) };
          var out = {};
          (res.data || []).forEach(function (row) {
            if (row && row.day && row.data) out[row.day] = row.data;
          });
          return { ok: true, records: out };
        });
    }).catch(function (e) { return { ok: false, error: netMsg(e) }; });
  }

  // ── Danh sách thợ + lịch tuần + cài đặt ───────────────
  function pushRoster(payload) {
    return getClient().then(function (r) {
      if (!r.ok) return r;
      return r.client.auth.getUser().then(function (u) {
        var uid = u && u.data && u.data.user ? u.data.user.id : null;
        if (!uid) return { ok: false, error: 'Not signed in.' };
        return r.client.from(T_ROSTER)
          .upsert([{ user_id: uid, data: payload, updated_at: new Date().toISOString() }], { onConflict: 'user_id' })
          .then(function (res) {
            return res.error ? { ok: false, error: netMsg(res.error) } : { ok: true };
          });
      });
    }).catch(function (e) { return { ok: false, error: netMsg(e) }; });
  }

  function pullRoster() {
    return getClient().then(function (r) {
      if (!r.ok) return r;
      return r.client.from(T_ROSTER).select('data,updated_at').limit(1).then(function (res) {
        if (res.error) return { ok: false, error: netMsg(res.error) };
        var row = (res.data || [])[0];
        if (!row) return { ok: true, data: null };
        return { ok: true, data: row.data, updatedAt: row.updated_at };
      });
    }).catch(function (e) { return { ok: false, error: netMsg(e) }; });
  }

  root.Cloud = {
    SDK_URL: SDK_URL,
    getConfig: getConfig, setConfig: setConfig, clearConfig: clearConfig, isConfigured: isConfigured,
    onAuth: onAuth, currentUser: currentUser, signIn: signIn, signUp: signUp, signOut: signOut,
    pushDays: pushDays, pullDays: pullDays, pushRoster: pushRoster, pullRoster: pullRoster,
    dirtyList: dirtyList, markDirty: markDirty,
    user: function () { return lastUser; },
  };
})(typeof window !== 'undefined' ? window : this);
