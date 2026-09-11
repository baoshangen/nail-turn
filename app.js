/* app.js — nối TurnLogic ↔ DOM ↔ localStorage. Không chứa luật chia turn (luật ở turn-logic.js). */
(function () {
  'use strict';
  var L = window.TurnLogic;
  var KEY = 'nail-turn';
  var state;

  // ── Tiện ích ──────────────────────────────────────────
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null || attrs[k] === false) return; // bỏ qua attr rỗng (vd disabled: null)
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'dataset') Object.assign(e.dataset, attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function fmtPts(n) {
    if (n === 0.5) return '½';
    var whole = Math.floor(n), frac = n - whole;
    if (frac === 0.5) return whole + '½';
    return String(Math.round(n * 100) / 100);
  }
  // "1 day" chứ không phải "1 days" — chi tiết nhỏ nhưng sếp Ray đọc bảng này mỗi tuần
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function fmtTime(t) {
    var d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtDate(str) {
    var p = str.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[d.getDay()] + ', ' + Number(p[1]) + '/' + Number(p[2]) + '/' + p[0]; // US m/d/yyyy
  }
  // Tên thợ: tra danh sách hiện tại; thợ đã bị xoá thì tra sổ tên cũ (state.names) để nhật ký không thành "?"
  function nameOf(id) {
    var t = L.findTech(state, id);
    if (t) return t.name;
    return (state.names && state.names[id]) || '?';
  }
  // Mỗi thợ 1 màu sơn CỐ ĐỊNH, gán 1 lần rồi lưu trong state.colors (không đổi khi xoá thợ khác).
  var SHADES = ['#B8707C', '#C4384D', '#E27C6A', '#7B4B7A', '#B48EA6', '#4F9A93', '#EBD9CC', '#6E1E2C'];
  var DEFAULT_SHADE = '#B8707C';
  function colorOf(id) {
    if (!id) return DEFAULT_SHADE;
    if (!state.colors) state.colors = {};
    if (state.colors[id] == null) {
      // chọn shade ít người dùng nhất trong số thợ hiện có
      var used = {};
      Object.keys(state.colors).forEach(function (k) { used[state.colors[k]] = (used[state.colors[k]] || 0) + 1; });
      var best = 0;
      for (var i = 0; i < SHADES.length; i++) if ((used[i] || 0) < (used[best] || 0)) best = i;
      state.colors[id] = best;
    }
    return SHADES[state.colors[id] % SHADES.length];
  }
  // Ghi nhớ tên mọi thợ đang có (để nhật ký vẫn đọc được sau khi xoá thợ khỏi danh sách)
  function rememberNames() {
    if (!state.names) state.names = {};
    state.techs.forEach(function (t) { state.names[t.id] = t.name; });
  }
  function swatch(id, extraClass) {
    var s = el('span', { class: 'swatch' + (extraClass ? ' ' + extraClass : ''), 'aria-hidden': 'true' });
    s.style.setProperty('--sw', colorOf(id));
    return s;
  }
  var firstRender = true;
  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  // ── Lưu / nạp ─────────────────────────────────────────
  function save() {
    rememberNames();
    localStorage.setItem(KEY, JSON.stringify(state));
    maybePushRoster();
  }
  /*
   * Đẩy danh sách thợ lên đám mây, nhưng CHỈ khi nó thật sự đổi.
   * save() chạy sau mỗi lần giao khách; nếu đẩy vô điều kiện thì một ngày đông khách
   * sẽ bắn hàng trăm lần ghi mà nội dung y hệt nhau.
   */
  var lastRosterSig = '';
  function maybePushRoster() {
    if (!CLOUD || !CLOUD.isConfigured() || !cloudUser) return;
    var sig;
    try { sig = JSON.stringify(rosterPayload().techs) + '|' + JSON.stringify(state.settings); }
    catch (e) { return; }
    if (sig === lastRosterSig) return;
    lastRosterSig = sig;
    cloudPushRosterSoon();
  }
  // Chuẩn hoá state từ bất kỳ nguồn nào (localStorage cũ, file JSON nạp vào) → không thiếu trường nào.
  // Tên dịch vụ mặc định cũ (tiếng Việt) → tên mới (app chuyển hết sang tiếng Anh 09/2026).
  // Chỉ đổi đúng 2 tên mặc định — dịch vụ Ray tự thêm giữ nguyên.
  var SVC_RENAME = { 'Mani thường': 'Regular mani', 'Đổi nước sơn': 'Polish change' };
  function normalize(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.techs)) throw new Error('Invalid data (missing tech list)');
    var base = L.createState();
    var out = Object.assign({}, base, s);
    out.date = typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : base.date;
    out.log = Array.isArray(s.log) ? s.log.filter(function (e) { return e && Array.isArray(e.techIds); }) : [];
    out.settings = Object.assign({}, L.DEFAULT_SETTINGS, s.settings || {});
    if (!Array.isArray(out.settings.services)) out.settings.services = L.DEFAULT_SERVICES;
    out.settings.services = out.settings.services.map(function (x) {
      return SVC_RENAME[x.name] ? { name: SVC_RENAME[x.name], weight: x.weight } : x;
    });
    out.waiting = Array.isArray(s.waiting) ? s.waiting.filter(function (x) {
      return x && x.wid && Number(x.weight) >= 0 && x.createdAt;
    }).map(function (x) {
      // Thợ gán sẵn mà sau đó bị xoá khỏi danh sách → bỏ id mồ côi, nếu không
      // thẻ khách chờ sẽ hiện nút Start trỏ vào người không còn tồn tại.
      var live = x.techId && s.techs.some(function (t) { return t && t.id === x.techId; });
      return Object.assign({}, x, { techId: live ? x.techId : null });
    }) : [];
    out.history = Array.isArray(s.history) ? s.history : [];
    out.techs = s.techs.filter(function (t) { return t && t.id != null && t.name; }).map(function (t) {
      var out2 = Object.assign({ points: 0, status: 'active', joinedAt: Date.now(), lastServedAt: null, jobs: [] }, t, {
        points: Number(t.points) || 0,
        jobs: Array.isArray(t.jobs) ? t.jobs : [],
        pinHash: typeof t.pinHash === 'string' ? t.pinHash : null,
      });
      // Lịch làm cố định: chỉ giữ nếu là mảng thứ hợp lệ. Rác → xoá hẳn key,
      // vì "không có key" mang nghĩa chưa khai lịch = làm mọi ngày (xem worksOn).
      if (Array.isArray(t.workDays)) {
        var raw = t.workDays.map(Number);
        out2.workDays = raw.filter(function (d, i) {
          return d >= 0 && d <= 6 && Math.floor(d) === d && raw.indexOf(d) === i;
        }).sort(function (a, b) { return a - b; });
      } else {
        delete out2.workDays;
      }
      return out2;
    });
    out.colors = (s.colors && typeof s.colors === 'object') ? s.colors : {};
    out.names = (s.names && typeof s.names === 'object') ? s.names : {};
    return out;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { console.warn('Không đọc được dữ liệu cũ', e); }
    return L.createState();
  }
  // Mọi thay đổi đi qua đây: áp hành động → vẽ lại → lưu (vẽ lỗi thì KHÔNG lưu, giữ state cũ).
  function apply(fn, okMsg) {
    var prev = state;
    try {
      state = fn(state);
      render();
      save();
      if (okMsg) toast(okMsg);
    } catch (e) {
      state = prev;
      try { render(); } catch (e2) { /* giữ nguyên màn hình cũ */ }
      alert(e.message || String(e));
    }
  }

  // ── Vẽ ────────────────────────────────────────────────
  function render() {
    $('#today-label').textContent = fmtDate(state.date);
    $('#btn-undo').disabled = !L.canUndo(state);

    var q = L.queue(state);
    var bench = state.techs.filter(function (t) { return t.status === 'paused' || t.status === 'left'; });
    var anyToday = state.techs.some(function (t) { return t.status !== 'off'; });

    var board = $('.board');
    if (window.FX) FX.snapshot(board);            // FLIP: nhớ vị trí cũ

    $('#queue-count').textContent = q.length;
    var qc = $('#queue'); qc.innerHTML = '';
    q.forEach(function (t, i) { qc.appendChild(card(t, i, i === 0)); });

    renderClockIn();

    // Đếm theo KHÁCH, không theo phần việc: chân + tay của một người vẫn là một khách đang đợi
    var wg = L.waitingGroups(state);
    var wlc = $('#waiting'); wlc.innerHTML = '';
    wg.forEach(function (g) { wlc.appendChild(waitingCard(g)); });
    $('#waiting-count').textContent = wg.length;
    $('#waiting-wrap').classList.toggle('hidden', wg.length === 0);

    var w = L.working(state);
    var wc = $('#working'); wc.innerHTML = '';
    w.forEach(function (t) { wc.appendChild(workingCard(t)); });
    $('#working-count').textContent = w.length;
    $('#working-wrap').classList.toggle('hidden', w.length === 0);

    var bc = $('#bench'); bc.innerHTML = '';
    bench.forEach(function (t) { bc.appendChild(card(t, null, false)); });
    $('#bench-wrap').classList.toggle('hidden', bench.length === 0);
    $('#empty').classList.toggle('hidden', anyToday);
    // Đầu ngày, ô trống KHÔNG được xui "thêm thợ" — người cần làm là bấm tên mình ở khu Clock in.
    var waitingToClockIn = state.techs.some(function (t) { return t.status === 'off'; });
    $('#empty-msg').textContent = waitingToClockIn
      ? 'Nobody has clocked in yet — tap your name above.'
      : 'No techs clocked in today.';
    $('[data-action="open-add"]').classList.toggle('hidden', waitingToClockIn);
    $('#queue').classList.toggle('hidden', !anyToday);
    $('#queue-empty').classList.toggle('hidden', !(anyToday && q.length === 0));

    if (window.FX && !firstRender) FX.play(board); // FLIP: trượt sang chỗ mới
    if (firstRender) {
      $$('.card', board).forEach(function (c, i) { c.classList.add('enter'); c.style.animationDelay = Math.min(i, 10) * 45 + 'ms'; });
      firstRender = false;
    }
    renderLog();
  }

  /*
   * Thẻ khách chờ. MỘT khách = MỘT thẻ, dù họ làm chân với tay là hai phần việc khác nhau.
   * Mỗi phần có ô chọn thợ riêng (gán trước, KHÔNG tính turn) và nút Start riêng
   * (bấm mới tính turn). Nhờ vậy Ray xếp người từ trước, tới lượt chỉ việc bấm.
   */
  function waitingCard(g) {
    var timer = el('b', { class: 'timer mono', text: fmtDur(Date.now() - g.createdAt), dataset: { start: g.createdAt } });
    var head = el('div', { class: 'wait-head' }, [
      el('div', {}, [
        el('span', { class: 'badge waitb', text: '⏳ Waiting' }),
        el('span', { class: 'wait-age' }, [el('span', { text: ' ' }), timer]),
      ]),
      el('button', {
        class: 'btn subtle', text: '✕', title: 'Customer left / changed mind — remove the whole ticket',
        onclick: function () {
          if (!confirm('Remove this waiting customer and all ' + plural(g.parts.length, 'part') + '?\n\nNo turns have been charged, so nobody loses anything.')) return;
          apply(function (s) { return L.cancelWaitingTicket(s, { ticket: g.ticket }); }, 'Waiting customer removed');
        },
      }),
    ]);

    var rows = g.parts.map(function (p) { return waitingPartRow(g, p); });

    return el('div', { class: 'card wait-card', dataset: { id: 'w:' + g.ticket } }, [
      head,
      g.note ? el('div', { class: 'wait-note', text: g.note }) : null,
      el('div', { class: 'wait-parts' }, rows),
      el('div', { class: 'wait-foot' }, [
        // "turn when started" chứ không phải "turn total": phải nói rõ chưa ai bị tính gì,
        // vì ngay bên cạnh có dải HOLDING của thợ mà turn thì đã trừ rồi.
        el('span', { class: 'wait-total', text: fmtPts(g.weight) + ' turn when started · ' + g.assigned + '/' + g.parts.length + ' lined up' }),
        el('button', {
          class: 'btn ghost', text: '＋ Add part', title: 'Same customer, another service',
          onclick: function () { openWait(g.ticket); },
        }),
      ]),
    ]);
  }

  // Một phần việc của khách chờ: dịch vụ + turn + ô chọn thợ + nút Start.
  function waitingPartRow(g, p) {
    var assigned = p.techId ? L.findTech(state, p.techId) : null;
    var sel = el('select', { class: 'input select-tech', title: 'Line up a tech — no turn counts until Start' });
    sel.appendChild(el('option', { value: '', text: '— no tech yet —' }));
    // Người rảnh xếp theo đúng luật turn, người đang bận để riêng cuối cho khỏi bấm nhầm
    L.queue(state).forEach(function (t, i) {
      sel.appendChild(el('option', { value: t.id, text: t.name + (i === 0 ? ' · next in line' : '') }));
    });
    L.activeTechs(state).filter(L.isBusy).forEach(function (t) {
      sel.appendChild(el('option', { value: t.id, text: t.name + ' (busy)' }));
    });
    // Thợ đã gán nhưng giờ nghỉ/về mất: vẫn phải hiện tên, nếu không Ray tưởng app quên
    if (p.techId && !L.activeTechs(state).some(function (t) { return t.id === p.techId; })) {
      sel.appendChild(el('option', { value: p.techId, text: nameOf(p.techId) + ' (not in line)' }));
    }
    sel.value = p.techId || '';
    sel.addEventListener('change', function () {
      apply(function (s) { return L.setWaitingTech(s, { wid: p.wid, techId: sel.value || null }); },
        sel.value ? nameOf(sel.value) + ' lined up for ' + (p.service || 'this part') : 'Tech cleared');
    });

    var go = p.techId
      ? el('button', {
          class: 'btn primary', text: 'Start',
          title: 'Sit ' + nameOf(p.techId) + ' down — the turn counts now',
          onclick: function () {
            apply(function (s) { return L.claimWaiting(s, { wid: p.wid, start: true }); },
              nameOf(p.techId) + ' started ' + (p.service || 'the customer') + ' · +' + fmtPts(p.weight) + ' turn');
          },
        })
      : el('button', {
          class: 'btn ghost', text: 'Assign', title: 'Pick who takes this part',
          onclick: function () { openClaim(p); },
        });

    return el('div', { class: 'wait-part' + (assigned ? ' lined' : '') }, [
      el('div', { class: 'wait-part-top' }, [
        el('span', { class: 'wait-svc', text: p.service || 'Customer' }),
        el('span', { class: 'wait-w mono', text: fmtPts(p.weight) + ' turn' }),
        el('button', {
          class: 'btn subtle wait-x', text: '✕', title: 'Drop just this part',
          onclick: function () {
            if (g.parts.length === 1) {
              if (!confirm('This is the only part — remove the whole waiting customer?')) return;
            }
            apply(function (s) { return L.cancelWaiting(s, { wid: p.wid }); }, 'Part removed');
          },
        }),
      ]),
      el('div', { class: 'wait-part-ops' }, [
        p.techId ? swatch(p.techId, 'wait-dot') : null,
        sel,
        go,
      ]),
    ]);
  }

  function card(t, rank, isNext) {
    var cls = 'card' + (isNext ? ' next' : '') + (t.status !== 'active' ? ' ' + t.status : '');
    var badge = isNext ? el('span', { class: 'badge next', text: 'Next' })
      : t.status === 'paused' ? el('span', { class: 'badge paused', text: 'On break' })
      : t.status === 'left' ? el('span', { class: 'badge left', text: 'Left' }) : null;
    var served = L.customersOf(state, t.id); // dùng chung cách đếm với Summary (đã trừ huỷ/chuyển)
    var meta = served + ' customer' + (served === 1 ? '' : 's') + (t.lastServedAt ? ' · last ' + fmtTime(t.lastServedAt) : '') + ' · in at ' + fmtTime(t.joinedAt);

    var actions = [];
    if (t.status === 'active') {
      actions.push(el('button', { class: 'btn primary', text: 'Take customer', onclick: function () { openAssign(t.id); } }));
      actions.push(el('button', { class: 'btn ghost', text: 'Skip', title: 'Busy / passing on this one', onclick: function () {
        apply(function (s) { return L.skip(s, { techId: t.id }); }, t.name + ' skipped' + (state.settings.skipCosts ? ' (+1 turn)' : ''));
      } }));
      actions.push(el('button', { class: 'btn ghost', text: 'Break', onclick: function () {
        apply(function (s) { return L.pause(s, { techId: t.id }); });
      } }));
      actions.push(el('button', { class: 'btn ghost', text: 'Leave', onclick: function () {
        apply(function (s) { return L.leave(s, { techId: t.id }); });
      } }));
    } else {
      actions.push(el('button', { class: 'btn primary', text: 'Back in line', onclick: function () {
        apply(function (s) { return L.resume(s, { techId: t.id }); });
      } }));
    }
    actions.push(el('button', { class: 'btn subtle', text: '± points', onclick: function () { openAdjust(t.id); } }));

    return el('div', { class: cls, dataset: { id: t.id } }, [
      el('div', { class: 'card-top' }, [
        el('span', { class: 'rank', text: rank != null ? '#' + (rank + 1) : '' }),
        badge,
      ]),
      el('div', { class: 'card-name' }, [swatch(t.id), el('span', { text: t.name })]),
      el('div', { class: 'card-points' }, [el('b', { text: fmtPts(t.points) }), el('span', { text: 'turn' })]),
      el('div', { class: 'card-meta', text: meta }),
      pendingStrip(t),
      el('div', { class: 'card-actions' }, actions),
    ]);
  }

  // Thẻ thợ ĐANG LÀM KHÁCH: dịch vụ + đồng hồ đếm + nút Xong (mỗi khách 1 nút) + Nhận thêm
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    // v8: 'g'/'p' (giờ/phút) là chữ sót lại từ bản tiếng Việt — tiệm bên Mỹ nên dùng h/m
    if (m >= 60) return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
    return m + ':' + String(s).padStart(2, '0');
  }
  function workingCard(t) {
    var jobs = L.activeJobs(t);
    var jobRows = jobs.map(function (j) {
      var timer = el('b', { class: 'timer mono', text: fmtDur(Date.now() - j.startedAt), dataset: { start: j.startedAt } });
      return el('div', { class: 'job' }, [
        el('div', { class: 'job-info' }, [
          el('span', { class: 'job-service', text: j.service || 'Customer' }),
          el('span', { class: 'job-meta' }, [
            el('span', { text: 'since ' + fmtTime(j.startedAt) + ' · ' }),
            timer,
            el('span', { class: 'w', text: fmtPts(j.weight) + ' turn' }),
          ]),
          j.note ? el('span', { class: 'job-note', text: j.note }) : null,
        ]),
        el('button', { class: 'btn primary done', text: 'Done', title: 'Finished with this customer', onclick: function () {
          var before = state;
          apply(function (s) { return L.finish(s, { techId: t.id, jobId: j.id }); }, t.name + ' finished' + (j.service ? ' — ' + j.service : ''));
          if (state !== before) offerStart(j.id);
        } }),
      ]);
    });
    return el('div', { class: 'card busy', dataset: { id: t.id } }, [
      el('div', { class: 'card-top' }, [
        el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'badge busy', text: jobs.length > 1 ? 'With ' + jobs.length + ' customers' : 'With customer' }),
      ]),
      el('div', { class: 'card-name' }, [swatch(t.id), el('span', { text: t.name })]),
      el('div', { class: 'jobs' }, jobRows),
      pendingStrip(t),
      el('div', { class: 'card-points small' }, [el('b', { text: fmtPts(t.points) }), el('span', { text: 'turns today' })]),
      el('div', { class: 'card-actions' }, [
        el('button', { class: 'btn ghost', text: '＋ Take another', title: 'Take one more customer while busy', onclick: function () { openAssign(t.id); } }),
        el('button', { class: 'btn subtle', text: '± points', onclick: function () { openAdjust(t.id); } }),
      ]),
    ]);
  }
  // Đồng hồ: chỉ cập nhật chữ trong .timer mỗi giây, không vẽ lại cả bảng
  setInterval(function () {
    var now = Date.now();
    $$('.timer[data-start]').forEach(function (b) { b.textContent = fmtDur(now - Number(b.dataset.start)); });
  }, 1000);

  function describe(e) {
    var names = e.techIds.map(nameOf).join(' + ');
    switch (e.type) {
      case 'assign': {
        if (e.parts && e.parts.length > 1) {
          var nowP = e.parts.filter(function (p) { return p.techId && !p.later; });
          var laterP = e.parts.filter(function (p) { return p.techId && p.later; });
          var pendP = e.parts.filter(function (p) { return !p.techId; });
          var txt = nowP.map(function (p) { return nameOf(p.techId) + (p.service ? ' (' + p.service + ' ' + fmtPts(p.weight) + ')' : ''); }).join(' + ') + ' took a customer';
          var out = [swatch(e.techIds[0]), el('span', { class: 'tag', text: txt })];
          if (laterP.length) out.push(el('span', { class: 'w later', text: laterP.map(function (p) { return nameOf(p.techId) + ' holds: ' + (p.service || 'next part') + ' ' + fmtPts(p.weight); }).join(', ') }));
          if (pendP.length) out.push(el('span', { class: 'w later', text: pendP.map(function (p) { return '⏳ pending: ' + (p.service || 'part') + ' ' + fmtPts(p.weight); }).join(', ') }));
          if (e.note) out.push(el('span', { class: 'note', text: ' — ' + e.note }));
          return out;
        }
        var ws = e.techIds.map(function (id) { return fmtPts(e.weight[id]); }).join(' / ');
        var label = names + ' took a customer' + (e.service ? ' · ' + e.service : '');
        return [swatch(e.techIds[0]), el('span', { class: 'tag', text: label }), el('span', { class: 'w', text: ws + ' turn' }), e.note ? el('span', { class: 'note', text: ' — ' + e.note }) : null];
      }
      case 'wait': {
        var waitOut = [];
        if (e.techIds.length) waitOut.push(swatch(e.techIds[0]));
        waitOut.push(el('span', { class: 'tag', text: '⏳ Waiting' + (e.service ? ' · ' + e.service : '') }));
        if (e.techIds.length) waitOut.push(el('span', { class: 'w later', text: 'lined up: ' + names }));
        if (e.note) waitOut.push(el('span', { class: 'note', text: ' — ' + e.note }));
        return waitOut;
      }
      case 'preassign': return e.cleared
        ? [el('span', { class: 'tag', text: '⏳ Tech cleared' + (e.service ? ' · ' + e.service : '') })]
        : [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' lined up' + (e.service ? ' · ' + e.service : '') }), el('span', { class: 'w later', text: 'no turn yet' })];
      case 'claim': return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + (e.started ? ' started waiting customer' : ' holds waiting customer') + (e.service ? ' · ' + e.service : '') }), el('span', { class: 'w', text: fmtPts(e.weight) + ' turn' })];
      case 'unwait': return [el('span', { class: 'tag', text: '⏳ Waiting removed' + (e.service ? ' · ' + e.service : '') + (e.parts > 1 ? ' (' + plural(e.parts, 'part') + ')' : '') })];
      case 'start': return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' started' + (e.service ? ' · ' + e.service : '') })];
      case 'cancel': return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' canceled held part' + (e.service ? ' · ' + e.service : '') }), el('span', { class: 'w', text: fmtPts(Math.abs(e.weight)) + ' turn refunded' })];
      case 'switch': return [swatch(e.techIds[1]), el('span', { class: 'tag', text: nameOf(e.techIds[0]) + ' moved ' + (e.service || 'held part') + ' → ' + nameOf(e.techIds[1]) }), el('span', { class: 'w', text: fmtPts(e.weight) + ' turn follows the work' })];
      case 'finish': {
        var dur = e.minutes >= 60 ? Math.floor(e.minutes / 60) + 'h' + (e.minutes % 60 ? (e.minutes % 60) + 'm' : '') : e.minutes + ' min';
        return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' finished' + (e.service ? ' · ' + e.service : '') }), el('span', { class: 'w', text: dur })];
      }
      case 'skip': return [el('span', { class: 'tag', text: names + ' skipped' }), e.weight ? el('span', { class: 'w', text: '+1 turn' }) : null];
      case 'pause': return [el('span', { class: 'tag', text: names + ' on break' })];
      case 'resume': return [el('span', { class: 'tag', text: names + ' back in line' })];
      case 'leave': return [el('span', { class: 'tag', text: names + ' left' })];
      case 'join': {
      var joinOut = [el('span', { class: 'tag', text: names + ' clocked in' }), e.weight ? el('span', { class: 'w', text: 'starts at ' + fmtPts(e.weight) }) : null];
        var ph = photoFor(e);
        if (ph) {
          joinOut.push(el('img', { class: 'log-thumb', src: ph, alt: 'clock-in photo', title: 'View photo', onclick: function () {
            $('#photo-title').textContent = names + ' — ' + fmtTime(e.t);
            $('#photo-big').src = ph;
            $('#dlg-photo').showModal();
          } }));
        }
        return joinOut;
      }
      case 'adjust': return [el('span', { class: 'tag', text: names + ' points adjusted' }), el('span', { class: 'w', text: (e.weight > 0 ? '+' : '−') + fmtPts(Math.abs(e.weight)) }), e.note ? el('span', { class: 'note', text: ' — ' + e.note }) : null];
      default: return [el('span', { text: names + ' ' + e.type })];
    }
  }
  function renderLog() {
    var ol = $('#log'); ol.innerHTML = '';
    // .log li là lưới 2 cột (giờ | nội dung). Dòng trống chỉ có 1 ô nên bị nhồi vào
    // cột giờ rộng 46px và vỡ chữ — cho nó thoát khỏi lưới bằng class riêng.
    if (!state.log.length) { ol.appendChild(el('li', { class: 'log-empty-row' }, [el('span', { class: 'log-empty', text: 'Nothing yet today.' })])); return; }
    state.log.slice().sort(function (a, b) { return b.t - a.t; }).forEach(function (e) {
      ol.appendChild(el('li', { class: e.type }, [el('time', { text: fmtTime(e.t) }), el('span', {}, describe(e))]));
    });
  }

  // ── Modal helpers ─────────────────────────────────────
  $$('dialog').forEach(function (d) {
    $$('[data-close]', d).forEach(function (b) { b.addEventListener('click', function () { d.close(); }); });
    d.addEventListener('click', function (ev) { if (ev.target === d) d.close(); });
  });
  function segmented(container, onPick) {
    $$('button', container).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('button', container).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        onPick(b.dataset.w != null ? b.dataset.w : b.dataset.d);
      });
    });
  }
  function pickSeg(container, val) {
    $$('button', container).forEach(function (b) {
      var v = b.dataset.w != null ? b.dataset.w : b.dataset.d;
      b.classList.toggle('on', v === String(val));
    });
  }

  // ── Nhận khách ────────────────────────────────────────
  // assignCtx.parts = các phần THÊM cho cùng khách: [{techId, service, weight, later}]
  var assignCtx = { techId: null, weight: 1, custom: false, service: '', parts: [] };
  segmented($('#weight-seg'), function (v) {
    assignCtx.custom = v === 'custom';
    $('#weight-custom').classList.toggle('hidden', !assignCtx.custom);
    if (assignCtx.custom) $('#weight-custom').focus();
    else assignCtx.weight = Number(v);
  });
  function currentWeight() {
    if (assignCtx.custom) return Number($('#weight-custom').value);
    return assignCtx.weight;
  }
  // Chọn trọng số theo giá trị (khớp nút 1/½/0, còn lại → "Khác" + điền số)
  function setWeight(w) {
    var seg = $('#weight-seg');
    var preset = [1, 0.5, 0].indexOf(w) >= 0;
    assignCtx.custom = !preset;
    if (preset) { assignCtx.weight = w; pickSeg(seg, w); $('#weight-custom').classList.add('hidden'); }
    else { pickSeg(seg, 'custom'); $('#weight-custom').classList.remove('hidden'); $('#weight-custom').value = String(w); }
  }
  function servicesList() { return (state.settings.services || L.DEFAULT_SERVICES).slice(); }
  function serviceWeight(name) {
    var f = servicesList().find(function (x) { return x.name === name; });
    return f ? Number(f.weight) : 1;
  }
  function renderServiceChips() {
    var box = $('#services'); box.innerHTML = '';
    servicesList().forEach(function (svc) {
      var chip = el('button', { type: 'button', class: 'chip svc' + (assignCtx.service === svc.name ? ' on' : '') }, [
        el('span', { text: svc.name }), el('small', { text: fmtPts(svc.weight) }),
      ]);
      chip.addEventListener('click', function () {
        assignCtx.service = svc.name;
        setWeight(Number(svc.weight));
        renderServiceChips();
      });
      box.appendChild(chip);
    });
    var other = el('button', { type: 'button', class: 'chip svc' + (assignCtx.service === '' ? ' on' : ''), text: 'Other / none' });
    other.addEventListener('click', function () { assignCtx.service = ''; renderServiceChips(); $('#assign-note').focus(); });
    box.appendChild(other);
  }
  // Các phần thêm (thợ khác cho cùng khách)
  function renderParts() {
    var box = $('#parts'); box.innerHTML = '';
    var others = L.activeTechs(state).filter(function (t) { return t.id !== assignCtx.techId; });
    assignCtx.parts.forEach(function (p, i) {
      var techSel = el('select', { class: 'input' });
      // ⏳ Pending = chưa biết ai làm phần này → vào Waiting, điểm tính khi có thợ nhận
      var oPend = el('option', { value: '', text: '⏳ Pending — no tech yet' });
      if (!p.techId) oPend.selected = true;
      techSel.appendChild(oPend);
      others.forEach(function (t) {
        var o = el('option', { value: t.id, text: t.name + (L.isBusy(t) ? ' (busy)' : '') });
        if (t.id === p.techId) o.selected = true;
        techSel.appendChild(o);
      });
      techSel.addEventListener('change', function () { p.techId = techSel.value || null; renderParts(); });
      var svcSel = el('select', { class: 'input' });
      servicesList().forEach(function (svc) {
        var o = el('option', { value: svc.name, text: svc.name + ' · ' + fmtPts(svc.weight) });
        if (svc.name === p.service) o.selected = true;
        svcSel.appendChild(o);
      });
      var oOther = el('option', { value: '', text: 'Other' }); if (p.service === '') oOther.selected = true; svcSel.appendChild(oOther);
      var wIn = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: String(p.weight), title: 'Turns' });
      wIn.addEventListener('input', function () { p.weight = Number(wIn.value); });
      svcSel.addEventListener('change', function () { p.service = svcSel.value; if (svcSel.value) { p.weight = serviceWeight(svcSel.value); wIn.value = String(p.weight); } });
      // Phần pending không cần chọn Together/Later (bản chất là "chưa biết")
      var when = p.techId ? el('div', { class: 'seg2' }, [
        el('button', { type: 'button', class: 'seg2-btn' + (!p.later ? ' on' : ''), text: 'Together', onclick: function () { p.later = false; renderParts(); } }),
        el('button', { type: 'button', class: 'seg2-btn' + (p.later ? ' on' : ''), text: 'Later', onclick: function () { p.later = true; renderParts(); } }),
      ]) : el('span', { class: 'muted tiny', text: '→ goes to Waiting' });
      var rm = el('button', { type: 'button', class: 'btn subtle', text: '✕', title: 'Remove this part', onclick: function () { assignCtx.parts.splice(i, 1); renderParts(); } });
      box.appendChild(el('div', { class: 'part-row' + (p.later || !p.techId ? ' later' : '') }, [techSel, svcSel, wIn, when, rm]));
    });
    $('#btn-add-part').disabled = false; // luôn thêm được — ít nhất còn lựa chọn ⏳ Pending
  }
  $('#btn-add-part').addEventListener('click', function () {
    // Mặc định phần thêm = ⏳ Pending (đúng ca phổ biến: chưa biết ai làm phần 2)
    var svc = servicesList()[0] || { name: '', weight: 1 };
    assignCtx.parts.push({ techId: null, service: svc.name, weight: Number(svc.weight), later: true });
    renderParts();
  });
  function openAssign(techId) {
    assignCtx = { techId: techId, weight: 1, custom: false, service: '', parts: [] };
    var t = L.findTech(state, techId);
    $('#assign-name').textContent = nameOf(techId);
    $('#assign-busy-note').classList.toggle('hidden', !L.isBusy(t));
    pickSeg($('#weight-seg'), 1);
    $('#weight-custom').classList.add('hidden'); $('#weight-custom').value = '';
    $('#assign-note').value = '';
    renderServiceChips();
    renderParts();
    $('#dlg-assign').showModal();
  }
  $('#form-assign').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var w = currentWeight();
    if (!(w >= 0)) { alert('Invalid turn amount'); return; }
    var parts = [{ techId: assignCtx.techId, service: assignCtx.service || '', weight: w, later: false }];
    for (var i = 0; i < assignCtx.parts.length; i++) {
      var p = assignCtx.parts[i];
      if (!(p.weight >= 0)) { alert('Invalid turns on added part'); return; }
      // techId null = ⏳ Pending → logic tự đưa vào Waiting
      parts.push({ techId: p.techId || null, service: p.service || '', weight: p.weight, later: !!p.later });
    }
    var note = $('#assign-note').value.trim();
    var ids = parts.filter(function (p) { return p.techId; }).map(function (p) { return p.techId; });
    var nPend = parts.filter(function (p) { return !p.techId; }).length;
    var before = state;
    apply(function (s) { return L.assign(s, { parts: parts, note: note }); },
      parts.filter(function (p) { return p.techId && !p.later; }).map(function (p) { return nameOf(p.techId); }).join(' + ') + ' took a customer'
      + (parts.some(function (p) { return p.techId && p.later; }) ? ' · ' + parts.filter(function (p) { return p.techId && p.later; }).map(function (p) { return nameOf(p.techId); }).join(', ') + ' holds for later' : '')
      + (nPend ? ' · ' + nPend + ' part' + (nPend > 1 ? 's' : '') + ' → Waiting' : ''));
    $('#dlg-assign').close();
    if (state !== before && window.FX) {
      // Ăn mừng: glitter từ thẻ vừa nhận khách (đang trượt sang chỗ mới)
      ids.forEach(function (id, i) {
        var cardEl = $('.card[data-id="' + id + '"]');
        if (cardEl) setTimeout(function () { FX.burst(cardEl, { count: i === 0 ? 90 : 50 }); }, 40);
      });
    }
  });

  // ── Phần làm sau: hỏi bắt đầu khi phần trước xong ──────
  function offerStart(ticket) {
    var pend = L.pendingForTicket(state, ticket);
    if (!pend.length) return;
    var box = $('#start-list'); box.innerHTML = '';
    pend.forEach(function (x) {
      var busy = L.isBusy(x.tech);
      box.appendChild(el('div', { class: 'part-row start-row' }, [
        el('div', { class: 'start-info' }, [
          swatch(x.tech.id),
          el('b', { text: x.tech.name }),
          el('span', { text: ' — ' + (x.job.service || 'next part') + ' · ' + fmtPts(x.job.weight) + ' turn' }),
          busy ? el('span', { class: 'muted', text: ' (busy with another customer)' }) : null,
        ]),
        el('button', { type: 'button', class: 'btn primary', text: busy ? 'Start anyway' : 'Start now', onclick: function () {
          apply(function (s) { return L.startJob(s, { techId: x.tech.id, jobId: x.job.id }); }, x.tech.name + ' started ' + (x.job.service || 'next part'));
          $('#dlg-start').close();
        } }),
      ]));
    });
    $('#dlg-start').showModal();
  }
  function startPending(techId, jobId) {
    apply(function (s) { return L.startJob(s, { techId: techId, jobId: jobId }); }, nameOf(techId) + ' started');
  }
  function cancelPending(techId, jobId, service) {
    if (!confirm('Cancel "' + (service || 'held part') + '" for ' + nameOf(techId) + '? The turn will be refunded.')) return;
    apply(function (s) { return L.cancelPending(s, { techId: techId, jobId: jobId }); }, 'Held part canceled');
  }
  // Dải "đang giữ khách" trên thẻ (hàng chờ lẫn đang làm)
  function pendingStrip(t) {
    var pend = L.pendingJobs(t);
    if (!pend.length) return null;
    return el('div', { class: 'pending' }, pend.map(function (j) {
      var afterNames = (j.after || []).map(nameOf).join(', ');
      return el('div', { class: 'pending-row' }, [
        el('div', { class: 'pending-info' }, [
          el('span', { class: 'pending-tag', text: 'Holding' }),
          // Nói rõ "already counted" để không lẫn với khu Waiting, nơi turn CHƯA tính
          el('span', { class: 'pending-svc', text: (j.service || 'next part') + ' · ' + fmtPts(j.weight) + ' turn already counted' }),
          afterNames ? el('span', { class: 'pending-after', text: 'after ' + afterNames + ' is done' }) : null,
        ]),
        el('div', { class: 'pending-ops' }, [
          el('button', { class: 'btn ghost', text: 'Start', onclick: function () { startPending(t.id, j.id); } }),
          switchSelect(t, j),
          el('button', { class: 'btn subtle', text: 'Cancel', onclick: function () { cancelPending(t.id, j.id, j.service); } }),
        ]),
      ]);
    }));
  }
  // Dropdown "Chuyển →": giao phần đang giữ cho thợ khác (thợ này kẹt khách walk-in). Turn đi theo phần việc.
  function switchSelect(t, j) {
    var others = L.activeTechs(state).filter(function (x) { return x.id !== t.id; });
    if (!others.length) return null;
    var sel = el('select', { class: 'input select-switch', title: 'Move this part to another tech' });
    sel.appendChild(el('option', { value: '', text: 'Move →' }));
    others.forEach(function (x) {
      var busy = L.isBusy(x) ? ' (busy)' : '';
      sel.appendChild(el('option', { value: x.id, text: x.name + busy }));
    });
    sel.addEventListener('change', function () {
      var to = sel.value;
      if (!to) return;
      apply(function (s) { return L.switchPending(s, { techId: t.id, toTechId: to, jobId: j.id }); },
        'Moved ' + (j.service || 'next part') + ' from ' + t.name + ' to ' + nameOf(to));
    });
    return sel;
  }

  // ── Khách chờ: thêm mới + giao thợ ────────────────────
  var waitCtx = { service: '', weight: 1 };
  function renderWaitChips() {
    var box = $('#wait-services'); box.innerHTML = '';
    servicesList().forEach(function (svc) {
      var chip = el('button', { type: 'button', class: 'chip svc' + (waitCtx.service === svc.name ? ' on' : '') }, [
        el('span', { text: svc.name }), el('small', { text: fmtPts(svc.weight) }),
      ]);
      chip.addEventListener('click', function () {
        waitCtx.service = svc.name;
        $('#wait-weight').value = String(svc.weight);
        renderWaitChips();
      });
      box.appendChild(chip);
    });
    var other = el('button', { type: 'button', class: 'chip svc' + (waitCtx.service === '' ? ' on' : ''), text: 'Other / none' });
    other.addEventListener('click', function () { waitCtx.service = ''; renderWaitChips(); });
    box.appendChild(other);
  }
  // Ô chọn thợ trong popup: để trống = chỉ xếp hàng chờ, chưa gán ai.
  function fillTechSelect(sel, chosen) {
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: '— no tech yet —' }));
    L.queue(state).forEach(function (t, i) {
      sel.appendChild(el('option', { value: t.id, text: t.name + (i === 0 ? ' · next in line' : '') }));
    });
    L.activeTechs(state).filter(L.isBusy).forEach(function (t) {
      sel.appendChild(el('option', { value: t.id, text: t.name + ' (busy)' }));
    });
    sel.value = chosen || '';
  }
  // ticket != null → thêm PHẦN VIỆC cho khách chờ đang có, thay vì tạo khách mới
  function openWait(ticket) {
    waitCtx = { service: (servicesList()[0] || {}).name || '', weight: 1, ticket: ticket || null };
    var adding = !!ticket;
    $('#wait-title').textContent = adding ? '⏳ Add another part' : '⏳ Add waiting customer';
    $('#wait-sub').textContent = adding
      ? 'Same customer, one more service. The turn still only counts when someone taps Start.'
      : 'Line the work up now. The turn only counts when someone taps Start.';
    $('#wait-submit').textContent = adding ? 'Add part' : 'Add';
    $('#wait-note-field').classList.toggle('hidden', adding); // ghi chú thuộc về khách, không phải từng phần
    $('#wait-weight').value = String(serviceWeight(waitCtx.service));
    $('#wait-note').value = '';
    fillTechSelect($('#wait-tech'), '');
    renderWaitChips();
    $('#dlg-wait').showModal();
  }
  $('#btn-wait').addEventListener('click', function () { openWait(null); });
  $('#form-wait').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var w = Number($('#wait-weight').value);
    if (!(w >= 0)) { alert('Invalid turn amount'); return; }
    var techId = $('#wait-tech').value || null;
    var note = waitCtx.ticket ? '' : $('#wait-note').value.trim();
    apply(function (s) {
      return L.addWaiting(s, { ticket: waitCtx.ticket, service: waitCtx.service, weight: w, note: note, techId: techId });
    }, techId
      ? nameOf(techId) + ' lined up for ' + (waitCtx.service || 'this customer') + ' · no turn yet'
      : (waitCtx.ticket ? 'Part added' : 'Added to Waiting'));
    $('#dlg-wait').close();
  });

  var claimCtx = { wid: null, start: true };
  function openClaim(x) {
    claimCtx = { wid: x.wid, start: true };
    $('#claim-service').textContent = x.service || 'Customer';
    $('#claim-info').textContent = fmtPts(x.weight) + ' turn' + (x.note ? ' — ' + x.note : '')
      + ' · the turn counts only if you pick Start now';
    var sel = $('#claim-tech'); sel.innerHTML = '';
    // Gợi ý thợ tới lượt: hàng chờ đã sort theo luật điểm → người đầu là NEXT
    var q = L.queue(state);
    var busyOnes = L.activeTechs(state).filter(function (t) { return L.isBusy(t); });
    q.forEach(function (t, i) {
      sel.appendChild(el('option', { value: t.id, text: t.name + (i === 0 ? ' — next in line' : '') }));
    });
    busyOnes.forEach(function (t) {
      sel.appendChild(el('option', { value: t.id, text: t.name + ' (busy)' }));
    });
    if (!sel.options.length) { alert('No techs are clocked in.'); return; }
    if (x.techId) sel.value = x.techId;
    $$('button', $('#claim-when')).forEach(function (b) { b.classList.toggle('on', b.dataset.v === 'start'); });
    $('#dlg-claim').showModal();
  }
  $$('button', $('#claim-when')).forEach(function (b) {
    b.addEventListener('click', function () {
      claimCtx.start = b.dataset.v === 'start';
      $$('button', $('#claim-when')).forEach(function (x) { x.classList.toggle('on', x === b); });
    });
  });
  $('#form-claim').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var techId = $('#claim-tech').value;
    if (!techId) return;
    if (claimCtx.start) {
      apply(function (s) { return L.claimWaiting(s, { wid: claimCtx.wid, techId: techId, start: true }); },
        nameOf(techId) + ' started the waiting customer');
    } else {
      // "Assign only" = xếp người trước, CHƯA tính turn. Khác hẳn kiểu Hold cũ (tính ngay).
      apply(function (s) { return L.setWaitingTech(s, { wid: claimCtx.wid, techId: techId }); },
        nameOf(techId) + ' lined up · no turn until Start');
    }
    $('#dlg-claim').close();
  });

  // ── Sửa điểm ──────────────────────────────────────────
  var adjustCtx = { techId: null, delta: 0.5, custom: false };
  segmented($('#adjust-seg'), function (v) {
    adjustCtx.custom = v === 'custom';
    $('#adjust-custom').classList.toggle('hidden', !adjustCtx.custom);
    if (adjustCtx.custom) $('#adjust-custom').focus(); else adjustCtx.delta = Number(v);
  });
  function openAdjust(techId) {
    adjustCtx = { techId: techId, delta: 0.5, custom: false };
    var t = L.findTech(state, techId);
    $('#adjust-name').textContent = t.name;
    $('#adjust-current').textContent = fmtPts(t.points);
    pickSeg($('#adjust-seg'), 0.5);
    $('#adjust-custom').classList.add('hidden'); $('#adjust-custom').value = '';
    $('#adjust-note').value = '';
    $('#dlg-adjust').showModal();
  }
  $('#form-adjust').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var d = adjustCtx.custom ? Number($('#adjust-custom').value) : adjustCtx.delta;
    var note = $('#adjust-note').value.trim();
    apply(function (s) { return L.adjust(s, { techId: adjustCtx.techId, delta: d, note: note }); }, 'Adjusted points for ' + nameOf(adjustCtx.techId));
    $('#dlg-adjust').close();
  });

  // ── Thêm thợ ──────────────────────────────────────────
  function openAdd() {
    $('#add-name').value = '';
    var offs = state.techs.filter(function (t) { return t.status === 'off'; });
    var wrap = $('#add-roster-wrap'), box = $('#add-roster'); box.innerHTML = '';
    wrap.classList.toggle('hidden', offs.length === 0);
    offs.forEach(function (t) {
      box.appendChild(el('button', { type: 'button', class: 'chip', text: t.name, onclick: function () {
        apply(function (s) { return L.rejoin(s, { techId: t.id }); }, t.name + ' clocked in');
        $('#dlg-add').close();
      } }));
    });
    var late = state.settings.lateCatchUp && L.activeTechs(state).length > 0;
    $('#add-hint').textContent = late
      ? 'Mid-day: a new tech starts at today\'s lowest points (' + fmtPts(Math.min.apply(null, L.activeTechs(state).map(function (t) { return t.points; }))) + ') — change in Settings.'
      : '';
    $('#dlg-add').showModal();
    $('#add-name').focus();
  }
  $('#form-add').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('#add-name').value.trim();
    if (!name) return;
    apply(function (s) { return L.addTech(s, { name: name }); }, name + ' clocked in');
    $('#dlg-add').close();
  });
  $('#btn-add').addEventListener('click', openAdd);
  $('[data-action="open-add"]').addEventListener('click', openAdd);

  // ── Ngày mới (v7: tự động — không còn dialog sắp thứ tự) ──
  // Reset: điểm 0, log/waiting sạch, MỌI thợ về 'chưa vào ca' → thứ tự turn = thứ tự bấm Clock in thật.
  function startNewDay(silent) {
    archiveToday(); // cất ngày cũ vào Lịch sử TRƯỚC khi xoá điểm — sau reset là không lấy lại được
    apply(function (s) { return L.newDay(s, { workingIds: [] }); }, silent ? null : 'New day started — clock in below');
    purgePhotos();
    // Ngày mới thì ai cũng phải clock in → mở lại khu đó dù hôm qua Ray đã thu gọn
    showAllClockIn = false;
    setClockInCollapsed(false);
  }
  $('#btn-newday').addEventListener('click', function () {
    if (!confirm('Start a new day? Points reset to 0, the log clears, and everyone clocks in again.')) return;
    startNewDay();
  });

  // ── Clock in v7: PIN 4 số + ảnh webcam ────────────────
  // Kho ảnh nằm NGOÀI state (state có 20 snapshot undo — nhét base64 vào là phình localStorage).
  var PHOTO_KEY = 'nail-turn-photos';
  var photosCache = null;
  function loadPhotos() {
    if (photosCache) return photosCache;
    try {
      var p = JSON.parse(localStorage.getItem(PHOTO_KEY));
      if (p && p.date === state.date && p.shots) { photosCache = p; return p; }
    } catch (e) { /* hỏng thì coi như rỗng */ }
    photosCache = { date: state.date, shots: {} };
    return photosCache;
  }
  function savePhoto(key, dataUrl) {
    try {
      var p = loadPhotos();
      p.date = state.date;
      p.shots[key] = dataUrl;
      localStorage.setItem(PHOTO_KEY, JSON.stringify(p));
    } catch (e) { console.warn('Không lưu được ảnh clock-in', e); }
  }
  function purgePhotos() {
    photosCache = null;
    try { localStorage.removeItem(PHOTO_KEY); } catch (e) {}
  }
  function photoFor(e) {
    if (e.type !== 'join' || !e.techIds.length) return null;
    return loadPhotos().shots[e.techIds[0] + ':' + e.t] || null;
  }

  // Chụp 1 frame webcam làm bằng chứng. KHÔNG BAO GIỜ chặn clock-in: lỗi/không camera/treo 4s → trả null.
  function capturePhoto() {
    return new Promise(function (resolve) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return resolve(null);
      var done = false;
      function finish(v, stream) {
        if (done) return;
        done = true;
        if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); });
        resolve(v);
      }
      var to = setTimeout(function () { finish(null); }, 4000);
      navigator.mediaDevices.getUserMedia({ video: { width: 640 } }).then(function (stream) {
        var v = document.createElement('video');
        v.srcObject = stream; v.muted = true; v.playsInline = true;
        v.onloadedmetadata = function () {
          v.play().then(function () {
            setTimeout(function () { // đợi camera sáng lên rồi mới chụp
              try {
                var w = 320, h = Math.round(320 * v.videoHeight / v.videoWidth) || 240;
                var c = document.createElement('canvas'); c.width = w; c.height = h;
                c.getContext('2d').drawImage(v, 0, 0, w, h);
                clearTimeout(to); finish(c.toDataURL('image/jpeg', 0.7), stream);
              } catch (e) { clearTimeout(to); finish(null, stream); }
            }, 350);
          }).catch(function () { clearTimeout(to); finish(null, stream); });
        };
      }).catch(function () { clearTimeout(to); finish(null); });
    });
  }

  // Hash PIN: SHA-256(pin:techId). Môi trường thiếu crypto.subtle → djb2 (yếu nhưng nhất quán cùng máy;
  // nếu máy đổi sang có subtle thì hash lệch → sếp bấm Reset PIN là xong).
  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return 'djb2:' + h.toString(16);
  }
  function hashPin(pin, techId) {
    var msg = pin + ':' + techId;
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      }).catch(function () { return djb2(msg); });
    }
    return Promise.resolve(djb2(msg));
  }

  var pinCtx = { techId: null, mode: 'verify', first: '' };
  function openPin(techId) {
    var t = L.findTech(state, techId);
    if (!t) return;
    pinCtx = { techId: techId, mode: t.pinHash ? 'verify' : 'create', first: '' };
    $('#pin-name').textContent = t.name;
    setPinHint();
    $('#pin-input').value = '';
    renderDots();
    $('#pin-error').classList.add('hidden');
    $('#dlg-pin').showModal();
    $('#pin-input').focus();
  }
  function setPinHint() {
    var hints = {
      verify: 'Enter your 4-digit PIN.',
      create: 'First time — create your 4-digit PIN.',
      confirm: 'Type the same PIN again to confirm.',
    };
    $('#pin-hint').textContent = hints[pinCtx.mode];
  }
  function renderDots() {
    var n = $('#pin-input').value.length;
    $$('#pin-dots span').forEach(function (d, i) { d.classList.toggle('full', i < n); });
  }
  function pinFail(msg, backToCreate) {
    var err = $('#pin-error');
    err.textContent = msg;
    err.classList.remove('hidden');
    $('#pin-input').value = '';
    renderDots();
    if (backToCreate) { pinCtx.mode = 'create'; pinCtx.first = ''; setPinHint(); }
    var dlg = $('#dlg-pin');
    dlg.classList.remove('pin-shake'); void dlg.offsetWidth; dlg.classList.add('pin-shake');
  }
  var pinBusy = false; // chặn double-submit trong lúc chờ hash/camera
  function submitPin() {
    var pin = $('#pin-input').value;
    if (pin.length !== 4 || pinBusy) return;
    var t = L.findTech(state, pinCtx.techId);
    if (!t) { $('#dlg-pin').close(); return; }
    $('#pin-error').classList.add('hidden');
    if (pinCtx.mode === 'create') {
      pinCtx.first = pin;
      pinCtx.mode = 'confirm';
      setPinHint();
      $('#pin-input').value = '';
      renderDots();
      return;
    }
    pinBusy = true;
    if (pinCtx.mode === 'confirm') {
      if (pin !== pinCtx.first) { pinBusy = false; pinFail("PINs don't match — start over.", true); return; }
      hashPin(pin, t.id).then(function (h) {
        pinBusy = false;
        $('#dlg-pin').close();
        apply(function (s) { return L.setPin(s, { techId: t.id, pinHash: h }); });
        clockIn(t.id);
      });
      return;
    }
    hashPin(pin, t.id).then(function (h) { // verify
      pinBusy = false;
      if (h === t.pinHash) { $('#dlg-pin').close(); clockIn(t.id); }
      else pinFail('Wrong PIN — try again.');
    });
  }
  function clockIn(techId) {
    capturePhoto().then(function (shot) { // chụp TRƯỚC — đúng khoảnh khắc người bấm đứng trước máy
      var ts = Date.now();
      var before = state;
      apply(function (s) { return L.rejoin(s, { techId: techId, now: ts }); }, nameOf(techId) + ' clocked in');
      if (state !== before && shot) {
        savePhoto(techId + ':' + ts, shot);
        renderLog(); // vẽ lại để thumbnail hiện
      }
    });
  }
  $('#numpad').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-k]');
    if (!b) return;
    var k = b.dataset.k;
    var inp = $('#pin-input');
    if (k === 'del') inp.value = inp.value.slice(0, -1);
    else if (k === 'ok') { submitPin(); return; }
    else if (inp.value.length < 4) inp.value += k;
    renderDots();
    if (inp.value.length === 4) submitPin();
  });
  $('#pin-input').addEventListener('input', function () { // bàn phím thật cũng gõ được
    this.value = this.value.replace(/\D/g, '').slice(0, 4);
    renderDots();
    if (this.value.length === 4) submitPin();
  });
  $('#form-pin').addEventListener('submit', function (ev) { ev.preventDefault(); submitPin(); });

  // ── Tổng kết ──────────────────────────────────────────
  $('#btn-summary').addEventListener('click', function () {
    var tb = $('#summary-table tbody'); tb.innerHTML = '';
    var rows = L.summary(state);
    if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'muted', text: 'No data yet.' })]));
    var statusText = { active: 'Working', paused: 'On break', left: 'Left' };
    rows.forEach(function (r) {
      tb.appendChild(el('tr', {}, [
        el('td', { text: r.name }), el('td', { class: 'num', text: String(r.customers) }),
        el('td', { class: 'num', text: fmtPts(r.points) }), el('td', { class: 'num', text: String(r.skips) }), el('td', { class: 'num', text: r.minutes ? String(r.minutes) : '–' }),
        el('td', { text: r.busy ? 'With customer' : (statusText[r.status] || r.status) }),
      ]));
    });
    $('#dlg-summary').showModal();
  });

  // ── Cài đặt ───────────────────────────────────────────
  $('#btn-settings').addEventListener('click', function () {
    $('#set-skipcosts').checked = !!state.settings.skipCosts;
    $('#set-latecatchup').checked = !!state.settings.lateCatchUp;
    renderSettingsRoster();
    renderSettingsServices();
    $('#dlg-settings').showModal();
  });
  function saveServices(list) {
    apply(function (s) { return L.updateSettings(s, { services: list }); });
    renderSettingsServices();
  }
  function renderSettingsServices() {
    var box = $('#settings-services'); box.innerHTML = '';
    servicesList().forEach(function (svc, i, arr) {
      var wInput = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: String(svc.weight), title: 'Turns', style: 'max-width:80px;padding:5px 8px' });
      wInput.addEventListener('change', function () {
        var v = Number(wInput.value); if (!(v >= 0)) { wInput.value = svc.weight; return; }
        var list = servicesList(); list[i] = { name: svc.name, weight: v }; saveServices(list);
      });
      box.appendChild(el('div', { class: 'roster-row' }, [
        el('span', { class: 'muted', text: '•' }),
        el('span', { class: 'name', text: svc.name }),
        el('div', { class: 'ops' }, [
          wInput,
          el('span', { class: 'muted', text: 'turn', style: 'align-self:center;font-size:12px' }),
          el('button', { type: 'button', class: 'btn ghost', text: '▲', disabled: i === 0 ? 'true' : null, onclick: function () {
            var list = servicesList(); var t = list[i - 1]; list[i - 1] = list[i]; list[i] = t; saveServices(list);
          } }),
          el('button', { type: 'button', class: 'btn ghost', text: '▼', disabled: i === arr.length - 1 ? 'true' : null, onclick: function () {
            var list = servicesList(); var t = list[i + 1]; list[i + 1] = list[i]; list[i] = t; saveServices(list);
          } }),
          el('button', { type: 'button', class: 'btn ghost', text: 'Delete', onclick: function () {
            var list = servicesList(); list.splice(i, 1); saveServices(list);
          } }),
        ]),
      ]));
    });
  }
  function addService() {
    var name = $('#svc-name').value.trim(); var w = Number($('#svc-weight').value);
    if (!name) { $('#svc-name').focus(); return; }
    if (!(w >= 0)) { alert('Invalid turn amount'); return; }
    var list = servicesList();
    if (list.some(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })) { alert('A service with this name already exists'); return; }
    list.push({ name: name, weight: w });
    saveServices(list);
    $('#svc-name').value = ''; $('#svc-weight').value = '1'; $('#svc-name').focus();
  }
  $('#svc-add').addEventListener('click', addService);
  $('#svc-name').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addService(); } });
  $('#set-skipcosts').addEventListener('change', function (ev) {
    apply(function (s) { return L.updateSettings(s, { skipCosts: ev.target.checked }); });
  });
  $('#set-latecatchup').addEventListener('change', function (ev) {
    apply(function (s) { return L.updateSettings(s, { lateCatchUp: ev.target.checked }); });
  });
  function renderSettingsRoster() {
    var box = $('#settings-roster'); box.innerHTML = '';
    if (!state.techs.length) box.appendChild(el('p', { class: 'muted', text: 'No techs.' }));
    state.techs.forEach(function (t) {
      box.appendChild(el('div', { class: 'roster-row' }, [
        el('span', { class: 'muted', text: '•' }),
        el('span', { class: 'name', text: t.name }),
        el('div', { class: 'ops' }, [
          el('button', { type: 'button', class: 'btn ghost', text: 'Reset PIN', onclick: function () {
            if (!t.pinHash) { alert(t.name + " has no PIN yet — they'll create one at next clock-in."); return; }
            if (!confirm('Reset PIN for ' + t.name + '? They will create a new one at next clock-in.')) return;
            apply(function (s) { return L.setPin(s, { techId: t.id, pinHash: null }); }, 'PIN reset for ' + t.name);
            renderSettingsRoster();
          } }),
          el('button', { type: 'button', class: 'btn ghost', text: 'Rename', onclick: function () {
            var n = prompt('New name for ' + t.name + ':', t.name);
            if (n && n.trim()) apply(function (s) { return L.renameTech(s, { techId: t.id, name: n }); });
            renderSettingsRoster();
          } }),
          el('button', { type: 'button', class: 'btn ghost', text: 'Delete', onclick: function () {
            if (L.isBusy(t)) { alert(t.name + ' is with a customer — tap Done first, then delete.'); return; }
            var hasToday = state.log.some(function (e) { return e.techIds.indexOf(t.id) >= 0; });
            var msg = hasToday
              ? t.name + ' has activity in today\'s log. Remove from the tech list? (the log keeps the name; if they just left for today, use Leave instead)'
              : 'Delete ' + t.name + ' from the list? (you can Undo)';
            if (!confirm(msg)) return;
            apply(function (s) { return L.removeTech(s, { techId: t.id }); });
            renderSettingsRoster();
          } }),
        ]),
      ]));
    });
  }
  $('#btn-export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'nail-turn-' + state.date + '.json' });
    document.body.appendChild(a); a.click(); a.remove();
  });
  $('#btn-import').addEventListener('click', function () { $('#import-file').click(); });
  $('#import-file').addEventListener('change', function (ev) {
    var f = ev.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var imported = normalize(JSON.parse(r.result)); // ném lỗi nếu file hỏng → không đụng state
        if (!confirm('Replace ALL current data with this file? (' + imported.techs.length + ' techs, date ' + imported.date + ')')) return;
        apply(function () { return imported; }, 'Data restored');
        $('#dlg-settings').close();
      } catch (e) { alert(e.message); }
    };
    r.readAsText(f);
    ev.target.value = '';
  });

  /* ══ v8: Clock in — lọc theo lịch + thu gọn ═══════════
   * Mặc định chỉ hiện thợ CÓ LỊCH hôm nay, cho khu này gọn đúng như Ray muốn.
   * Nhưng luôn phải có đường thoát: người đi làm thế ca vẫn clock in được qua "Show everyone".
   */
  var COLLAPSE_KEY = 'nail-turn-clockin-collapsed';
  var showAllClockIn = false;
  function clockInCollapsed() {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
  }
  function setClockInCollapsed(v) {
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch (e) {}
    applyCollapse();
  }
  function applyCollapse() {
    var on = clockInCollapsed();
    $('#clockin-wrap').classList.toggle('collapsed', on);
    var b = $('#btn-clockin-toggle');
    b.textContent = on ? 'Show' : 'Hide';
    b.setAttribute('aria-expanded', on ? 'false' : 'true');
  }
  function renderClockIn() {
    var offs = state.techs.filter(function (t) { return t.status === 'off'; });
    var today = L.dayIndexOf(state.date);
    var onSchedule = offs.filter(function (t) { return L.worksOn(t, today); });
    var shown = showAllClockIn ? offs : onSchedule;
    var hiddenCount = offs.length - onSchedule.length;

    var cc = $('#clockin'); cc.innerHTML = '';
    shown.forEach(function (t) {
      var offToday = !L.worksOn(t, today);
      cc.appendChild(el('button', {
        type: 'button',
        class: 'clock-chip' + (offToday ? ' off-today' : ''),
        title: offToday ? 'Not on today’s schedule — clocking in anyway is fine' : '',
        onclick: function () { openPin(t.id); },
      }, [swatch(t.id), el('span', { text: t.name }), offToday ? el('small', { text: 'off today' }) : null]));
    });

    $('#clockin-count').textContent = shown.length ? String(shown.length) : '';
    // Khu này biến mất chỉ khi KHÔNG còn ai để clock in — không phải khi lịch lọc hết sạch,
    // nếu không người đi làm thế ca sẽ không có cách nào vào.
    $('#clockin-wrap').classList.toggle('hidden', offs.length === 0);
    var extra = $('#clockin-extra');
    if (hiddenCount === 0) extra.classList.add('hidden');
    else {
      extra.classList.remove('hidden');
      $('#clockin-extra-text').textContent = showAllClockIn
        ? 'Showing everyone, on schedule or not. '
        : 'Someone not on today’s schedule? ';
      $('#btn-clockin-all').textContent = showAllClockIn
        ? 'Only today’s schedule'
        : 'Show everyone (+' + hiddenCount + ')';
    }
  }
  $('#btn-clockin-toggle').addEventListener('click', function () { setClockInCollapsed(!clockInCollapsed()); });
  $('#btn-clockin-all').addEventListener('click', function () { showAllClockIn = !showAllClockIn; renderClockIn(); });

  /* ══ v8: kho lịch sử nhiều ngày ═══════════════════════
   * Nằm NGOÀI state, đúng lý do như kho ảnh: state ôm 20 snapshot hoàn tác,
   * nhét lịch sử vào đó là mỗi thao tác nhân bản cả kho.
   */
  var HIST_KEY = 'nail-turn-history';
  function loadHistory() {
    try {
      var h = JSON.parse(localStorage.getItem(HIST_KEY));
      if (h && h.days && typeof h.days === 'object') return h;
    } catch (e) { console.warn('Không đọc được lịch sử', e); }
    return { v: 1, days: {} };
  }
  function saveHistory(h) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); return true; }
    catch (e) { console.warn('Không lưu được lịch sử', e); return false; }
  }
  // Cất ngày đang chạy vào kho TRƯỚC khi reset. Ngày tiệm đóng cửa (không turn, không khách) thì bỏ qua.
  function archiveToday() {
    var rec = L.dayRecord(state);
    if (L.isEmptyRecord(rec)) return null;
    var h = loadHistory();
    h.days[rec.date] = rec;
    saveHistory(h);
    cloudPush([rec]);
    return rec;
  }

  /* ══ v8: màn Lịch sử — 7 cột Thứ 2 → Chủ nhật ════════ */
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var histMonday = null;
  function shortDate(dateStr) {
    var p = dateStr.split('-');
    return Number(p[1]) + '/' + Number(p[2]); // m/d kiểu Mỹ
  }
  function openHistory() {
    histMonday = L.weekStart(state.date);
    renderHistory();
    $('#dlg-history').showModal();
  }
  function renderHistory() {
    var h = loadHistory();
    var w = L.weekTable(h.days, histMonday);
    var isThisWeek = histMonday === L.weekStart(L.todayStr(Date.now()));
    $('#hist-label').textContent = shortDate(w.days[0]) + ' – ' + shortDate(w.days[6]) + ', ' + w.days[6].slice(0, 4)
      + (isThisWeek ? ' · this week' : '');
    $('#hist-today').classList.toggle('hidden', isThisWeek);

    var head = $('#hist-head'); head.innerHTML = '';
    head.appendChild(el('th', { text: 'Tech' }));
    w.days.forEach(function (d, i) {
      head.appendChild(el('th', { class: 'day-col' + (d === state.date ? ' today-col' : '') }, [
        el('span', { text: DOW[i] }),
        el('br'),
        el('span', { class: 'muted', style: 'font-weight:400', text: shortDate(d) }),
      ]));
    });
    head.appendChild(el('th', { class: 'day-col total-col', text: 'Total' }));

    var tb = $('#hist-table tbody'); tb.innerHTML = '';
    w.rows.forEach(function (r) {
      var tds = [el('td', { class: 'who', text: r.name })];
      r.cells.forEach(function (c, i) {
        var cls = 'day-col' + (w.days[i] === state.date ? ' today-col' : '');
        if (!c) { tds.push(el('td', { class: cls + ' cell-off', text: '–' })); return; }
        tds.push(el('td', { class: cls }, [
          el('span', { class: 'cell-pts', text: fmtPts(c.points) }),
          el('span', { class: 'cell-cus', text: plural(c.customers, 'cust') }),
        ]));
      });
      tds.push(el('td', { class: 'day-col total-col' }, [
        el('span', { class: 'cell-pts', text: fmtPts(r.points) }),
        el('span', { class: 'cell-cus', text: plural(r.customers, 'cust') + ' · ' + r.days + 'd' }),
      ]));
      tb.appendChild(el('tr', {}, tds));
    });

    var foot = $('#hist-foot'); foot.innerHTML = '';
    if (w.rows.length) {
      foot.appendChild(el('td', { text: 'All techs' }));
      w.dayTotals.forEach(function (n, i) {
        foot.appendChild(el('td', { class: 'day-col mono' + (w.days[i] === state.date ? ' today-col' : ''), text: n ? fmtPts(n) : '–' }));
      });
      foot.appendChild(el('td', { class: 'day-col mono total-col', text: fmtPts(w.total) }));
    }
    $('#hist-table').classList.toggle('hidden', !w.rows.length);
    $('#hist-empty').classList.toggle('hidden', !!w.rows.length);
    $('#hist-csv').disabled = !w.rows.length;

    var total = Object.keys(h.days).length;
    $('#hist-note').textContent = total
      ? plural(total, 'day') + ' saved on this machine · today is not in History until you start the next day'
      : '';
  }
  $('#btn-history').addEventListener('click', openHistory);
  $('#hist-prev').addEventListener('click', function () { histMonday = L.addDays(histMonday, -7); renderHistory(); });
  $('#hist-next').addEventListener('click', function () { histMonday = L.addDays(histMonday, 7); renderHistory(); });
  $('#hist-today').addEventListener('click', function () { histMonday = L.weekStart(L.todayStr(Date.now())); renderHistory(); });

  // CSV cho sếp mở bằng Excel. Bọc mọi ô trong ngoặc kép để tên có dấu phẩy không phá cột.
  function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  $('#hist-csv').addEventListener('click', function () {
    var w = L.weekTable(loadHistory().days, histMonday);
    var lines = [];
    lines.push(['Tech'].concat(w.days.map(function (d, i) { return DOW[i] + ' ' + d; })).concat(['Total turns', 'Total customers', 'Days worked', 'Minutes']).map(csvCell).join(','));
    w.rows.forEach(function (r) {
      lines.push([r.name].concat(r.cells.map(function (c) { return c ? c.points : ''; }))
        .concat([r.points, r.customers, r.days, r.minutes]).map(csvCell).join(','));
    });
    lines.push(['All techs'].concat(w.dayTotals).concat([w.total, w.customers, '', '']).map(csvCell).join(','));
    // BOM ở đầu để Excel trên Windows đọc đúng tên có dấu
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'turn-board-week-' + w.monday + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    toast('CSV exported');
  });

  /* ══ v8: lịch làm cố định trong tuần ══════════════════ */
  var SCHED_COLS = [1, 2, 3, 4, 5, 6, 0]; // hiển thị T2→CN, giá trị lưu theo Date.getDay()
  function openSchedule() { renderSchedule(); $('#dlg-schedule').showModal(); }
  function currentDays(t) { return Array.isArray(t.workDays) ? t.workDays.slice() : SCHED_COLS.slice(); }
  function saveDays(techId, days) {
    apply(function (s) { return L.setWorkDays(s, { techId: techId, days: days }); });
    renderSchedule();
  }
  function renderSchedule() {
    var tb = $('#sched-table tbody'); tb.innerHTML = '';
    if (!state.techs.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '9', class: 'muted', text: 'No techs yet — add someone first.' })]));
      return;
    }
    state.techs.forEach(function (t) {
      var days = currentDays(t);
      var cells = SCHED_COLS.map(function (d) {
        var cb = el('input', { type: 'checkbox', 'aria-label': t.name + ' ' + DOW[SCHED_COLS.indexOf(d)] });
        cb.checked = days.indexOf(d) >= 0;
        cb.addEventListener('change', function () {
          var next = currentDays(t);
          var at = next.indexOf(d);
          if (cb.checked) { if (at < 0) next.push(d); } else if (at >= 0) next.splice(at, 1);
          saveDays(t.id, next);
        });
        return el('td', {}, [cb]);
      });
      var n = days.length;
      var ops = el('td', {}, [
        el('span', { class: 'sched-sum', text: n === 7 ? 'every day' : n === 0 ? 'no days' : plural(n, 'day') }),
        el('button', { type: 'button', class: 'btn subtle', text: n === 7 ? 'None' : 'All', onclick: function () {
          saveDays(t.id, n === 7 ? [] : SCHED_COLS.slice());
        } }),
      ]);
      tb.appendChild(el('tr', { class: n === 0 ? 'nodays' : '' },
        [el('td', { class: 'who' }, [swatch(t.id), el('span', { text: ' ' + t.name })])].concat(cells, [ops])));
    });
  }
  $('#btn-schedule').addEventListener('click', openSchedule);

  /* ══ v8: tài khoản chủ tiệm + đồng bộ ═════════════════
   * Luật: đẩy lên TỰ ĐỘNG, kéo về phải BẤM NÚT. Kéo nhầm giữa ca là đè mất dữ liệu hôm nay.
   */
  var CLOUD = window.Cloud || null;
  var cloudUser = null;
  function acctMsg(text, kind) {
    var p = $('#acct-msg');
    if (!text) { p.classList.add('hidden'); return; }
    p.textContent = text;
    p.className = 'acct-msg ' + (kind || 'info');
  }
  function updateCloudBadge() {
    var b = $('#btn-cloud');
    b.className = 'btn ghost icon';
    if (!CLOUD || !CLOUD.isConfigured()) { b.classList.add('cloud-off'); b.title = 'Owner account — not connected'; return; }
    var pending = CLOUD.dirtyList().length;
    if (!cloudUser) { b.classList.add('cloud-err'); b.title = 'Connected, but not signed in'; return; }
    if (pending) { b.classList.add('cloud-err'); b.title = plural(pending, 'day') + ' waiting to upload'; return; }
    b.classList.add('cloud-on');
    b.title = 'Signed in as ' + (cloudUser.email || 'owner') + ' — history is backed up';
  }
  // Đẩy ngày lên đám mây. Im lặng khi chưa nối — app offline vẫn phải mượt.
  function cloudPush(records) {
    if (!CLOUD || !CLOUD.isConfigured()) return Promise.resolve({ ok: false });
    $('#btn-cloud').classList.add('cloud-busy');
    return CLOUD.pushDays(records).then(function (r) {
      $('#btn-cloud').classList.remove('cloud-busy');
      updateCloudBadge();
      return r;
    });
  }
  function rosterPayload() {
    return {
      v: 1, updatedAt: Date.now(),
      settings: state.settings,
      techs: state.techs.map(function (t) {
        return { id: t.id, name: t.name, workDays: Array.isArray(t.workDays) ? t.workDays : null, pinHash: t.pinHash || null };
      }),
    };
  }
  var rosterTimer;
  function cloudPushRosterSoon() {
    if (!CLOUD || !CLOUD.isConfigured() || !cloudUser) return;
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(function () { CLOUD.pushRoster(rosterPayload()).then(updateCloudBadge); }, 2500);
  }
  // Đẩy bù những ngày lần trước rớt mạng.
  function cloudFlush() {
    if (!CLOUD || !CLOUD.isConfigured() || !cloudUser) return Promise.resolve({ ok: false, pushed: 0 });
    var dirty = CLOUD.dirtyList();
    if (!dirty.length) return Promise.resolve({ ok: true, pushed: 0 });
    var h = loadHistory();
    var recs = dirty.map(function (d) { return h.days[d]; }).filter(Boolean);
    if (!recs.length) return Promise.resolve({ ok: true, pushed: 0 });
    return cloudPush(recs);
  }
  // Gộp lịch sử đám mây vào máy này. Ngày nào máy đã có thì GIỮ bản của máy,
  // vì máy tiệm mới là nơi ghi gốc; đám mây chỉ bù những ngày máy này chưa từng thấy.
  function mergeCloudDays(remote) {
    var h = loadHistory(), added = 0;
    Object.keys(remote || {}).forEach(function (date) {
      if (!h.days[date]) { h.days[date] = remote[date]; added += 1; }
    });
    if (added) saveHistory(h);
    return added;
  }
  function refreshAccountUI() {
    var configured = CLOUD && CLOUD.isConfigured();
    $('#acct-setup').classList.toggle('hidden', !!configured);
    $('#acct-login').classList.toggle('hidden', !configured || !!cloudUser);
    $('#acct-in').classList.toggle('hidden', !configured || !cloudUser);
    if (cloudUser) {
      $('#acct-who').textContent = cloudUser.email || 'owner';
      var pending = CLOUD.dirtyList().length;
      var saved = Object.keys(loadHistory().days).length;
      $('#acct-sync-state').textContent = plural(saved, 'day') + ' saved on this machine'
        + (pending ? ' · ' + pending + ' waiting to upload' : ' · all uploaded');
    }
    if (configured) {
      var c = CLOUD.getConfig();
      $('#acct-url').value = c.url; $('#acct-key').value = c.key;
    }
    updateCloudBadge();
  }
  function openAccount() {
    acctMsg('');
    if (!CLOUD) { acctMsg('cloud.js is missing — the app still works, but history stays on this machine.', 'err'); }
    refreshAccountUI();
    $('#dlg-account').showModal();
    if (CLOUD && CLOUD.isConfigured() && !cloudUser) {
      CLOUD.currentUser().then(function (u) { cloudUser = u; refreshAccountUI(); });
    }
  }
  $('#btn-cloud').addEventListener('click', openAccount);
  $('#btn-account').addEventListener('click', function () { $('#dlg-settings').close(); openAccount(); });

  $('#acct-save-keys').addEventListener('click', function () {
    var r = CLOUD.setConfig($('#acct-url').value, $('#acct-key').value);
    if (!r.ok) { acctMsg(r.error, 'err'); return; }
    acctMsg('Project saved. Now sign in, or create the owner account.', 'ok');
    refreshAccountUI();
  });
  $('#acct-forget-keys').addEventListener('click', function () {
    if (!confirm('Forget the Supabase project on this machine? History already saved here stays.')) return;
    CLOUD.clearConfig(); cloudUser = null;
    acctMsg('Project disconnected.', 'info');
    refreshAccountUI();
  });
  $('#acct-change-keys').addEventListener('click', function () {
    $('#acct-setup').classList.remove('hidden');
    acctMsg('Paste a different project URL and key, then Save keys.', 'info');
  });

  function afterSignIn(u) {
    cloudUser = u;
    acctMsg('Signed in. Uploading anything that was waiting…', 'ok');
    refreshAccountUI();
    cloudFlush().then(function () {
      return CLOUD.pullDays();
    }).then(function (r) {
      if (r && r.ok) {
        var added = mergeCloudDays(r.records);
        acctMsg('Signed in.' + (added ? ' Pulled ' + plural(added, 'day') + ' from the cloud.' : ' Everything is in sync.'), 'ok');
      }
      CLOUD.pushRoster(rosterPayload());
      refreshAccountUI();
    });
  }
  function doSignIn() {
    acctMsg('Signing in…', 'info');
    CLOUD.signIn($('#acct-email').value, $('#acct-pass').value).then(function (r) {
      if (!r.ok) { acctMsg(r.error, 'err'); return; }
      $('#acct-pass').value = '';
      afterSignIn(r.user);
    });
  }
  $('#form-account').addEventListener('submit', function (ev) { ev.preventDefault(); doSignIn(); });
  $('#acct-signup').addEventListener('click', function () {
    acctMsg('Creating account…', 'info');
    CLOUD.signUp($('#acct-email').value, $('#acct-pass').value).then(function (r) {
      if (!r.ok) { acctMsg(r.error, 'err'); return; }
      if (r.needsEmailConfirm) { acctMsg('Account created. Open the confirmation email, then sign in here.', 'info'); return; }
      $('#acct-pass').value = '';
      afterSignIn(r.user);
    });
  });
  $('#acct-signout').addEventListener('click', function () {
    CLOUD.signOut().then(function () {
      cloudUser = null;
      acctMsg('Signed out. History stays on this machine.', 'info');
      refreshAccountUI();
    });
  });
  $('#acct-sync').addEventListener('click', function () {
    acctMsg('Syncing…', 'info');
    // Đẩy TẤT CẢ ngày đang có, không chỉ ngày lỗi — nút này là để chữa mọi lệch lạc.
    var days = loadHistory().days;
    var all = Object.keys(days).map(function (d) { return days[d]; });
    cloudPush(all).then(function (r) {
      if (!r.ok) { acctMsg(r.error || 'Upload failed.', 'err'); return; }
      return CLOUD.pullDays().then(function (p) {
        var added = p && p.ok ? mergeCloudDays(p.records) : 0;
        acctMsg('Synced ' + plural(r.pushed || 0, 'day') + ' up' + (added ? ', ' + added + ' down' : '') + '.', 'ok');
        refreshAccountUI();
      });
    });
  });
  $('#acct-restore').addEventListener('click', function () {
    acctMsg('Fetching…', 'info');
    CLOUD.pullRoster().then(function (r) {
      if (!r.ok) { acctMsg(r.error || 'Could not fetch.', 'err'); return; }
      if (!r.data || !Array.isArray(r.data.techs) || !r.data.techs.length) { acctMsg('Nothing saved in the cloud yet.', 'info'); return; }
      if (!confirm('Bring back ' + plural(r.data.techs.length, 'tech') + ', their weekly schedule and the service list?\n\nToday’s points, customers and clock-ins are NOT touched.')) return;
      apply(function (s) { return L.importRoster(s, r.data); }, 'Techs and schedule restored');
      acctMsg('Restored.', 'ok');
      refreshAccountUI();
    });
  });

  // ── Hoàn tác ──────────────────────────────────────────
  $('#btn-undo').addEventListener('click', function () {
    apply(function (s) { return L.undo(s); }, 'Undone');
  });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !$$('dialog[open]').length) {
      ev.preventDefault();
      if (L.canUndo(state)) apply(function (s) { return L.undo(s); }, 'Undone');
    }
  });

  // ── Theme + hiệu ứng + 3D ─────────────────────────────
  function themeIcon(t) { $('#btn-theme').textContent = t === 'dark' ? '☀' : '🌙'; }
  if (window.FX) {
    var t0 = FX.theme.init();
    themeIcon(t0);
    $('#btn-theme').addEventListener('click', function () {
      themeIcon(FX.theme.toggle());
    });
    FX.tilt($('.board'));
  }

  // ── Khởi động ─────────────────────────────────────────
  state = load();
  // v7: qua ngày mới → TỰ reset (điểm 0, mọi thợ về "chưa vào ca"), thợ tới đâu Clock in tới đó
  if (state.techs.length > 0 && L.isNewDay(state)) {
    archiveToday(); // state vẫn đang giữ dữ liệu HÔM QUA ở đúng thời điểm này
    state = L.newDay(state, { workingIds: [] });
    save();
    purgePhotos();
    setClockInCollapsed(false);
    toast('New day started — clock in below');
  }
  applyCollapse();
  updateCloudBadge();
  // Đã nối đám mây thì lặng lẽ kiểm phiên cũ và đẩy bù ngày còn kẹt. Không chặn màn hình.
  if (CLOUD && CLOUD.isConfigured()) {
    CLOUD.currentUser().then(function (u) {
      cloudUser = u;
      updateCloudBadge();
      if (u) cloudFlush();
    });
  }
  // Mở với #demo khi chưa có thợ → nạp dữ liệu mẫu để xem thử (bấm "Ngày mới" là dọn sạch).
  if (state.techs.length === 0 && location.hash === '#demo') {
    var now = Date.now(), m = 60000;
    var s = state;
    s = L.addTech(s, { name: 'Chị Lan', id: 'lan', now: now - 180 * m });
    s = L.addTech(s, { name: 'Bé Vy', id: 'vy', now: now - 175 * m });
    s = L.addTech(s, { name: 'Anh Tuấn', id: 'tuan', now: now - 170 * m });
    s = L.addTech(s, { name: 'Chị Hoa', id: 'hoa', now: now - 160 * m });
    s = L.assign(s, { techId: 'lan', weight: 1, service: 'Full set', now: now - 150 * m, note: 'gel' });
    s = L.assign(s, { techId: 'vy', weight: 0.5, service: 'Polish change', now: now - 140 * m });
    s = L.finish(s, { techId: 'vy', now: now - 125 * m });
    s = L.assign(s, { techId: 'tuan', weight: 1, service: 'Pedicure', now: now - 130 * m });
    s = L.finish(s, { techId: 'lan', now: now - 95 * m });
    s = L.assign(s, { parts: [{ techId: 'hoa', service: 'Pedicure', weight: 1 }, { techId: 'tuan', service: 'Regular mani', weight: 0.5, later: true }], now: now - 120 * m, note: 'feet first, hands later' });
    s = L.finish(s, { techId: 'tuan', now: now - 80 * m });
    s = L.skip(s, { techId: 'vy', now: now - 100 * m });
    s = L.assign(s, { techIds: ['vy', 'lan'], weight: { vy: 0.5, lan: 0.5 }, service: 'Mani + Pedi', now: now - 90 * m, note: 'shared, hands + feet' });
    s = L.finish(s, { techId: 'vy', now: now - 50 * m });
    s = L.finish(s, { techId: 'lan', now: now - 45 * m });
    s = L.assign(s, { techId: 'vy', weight: 1, service: 'Fill', now: now - 23 * m });
    s.history = [];
    state = s;
    save();
  }
  render();
  if (state.techs.length === 0) {
    // lần đầu dùng: hướng dẫn thêm thợ
  }
})();
