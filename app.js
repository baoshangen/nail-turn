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
  function fmtTime(t) {
    var d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtDate(str) {
    var p = str.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var days = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
    return days[d.getDay()] + ', ' + p[2] + '/' + p[1] + '/' + p[0];
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
  function save() { rememberNames(); localStorage.setItem(KEY, JSON.stringify(state)); }
  // Chuẩn hoá state từ bất kỳ nguồn nào (localStorage cũ, file JSON nạp vào) → không thiếu trường nào.
  function normalize(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.techs)) throw new Error('Dữ liệu không đúng định dạng (thiếu danh sách thợ)');
    var base = L.createState();
    var out = Object.assign({}, base, s);
    out.date = typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : base.date;
    out.log = Array.isArray(s.log) ? s.log.filter(function (e) { return e && Array.isArray(e.techIds); }) : [];
    out.settings = Object.assign({}, L.DEFAULT_SETTINGS, s.settings || {});
    if (!Array.isArray(out.settings.services)) out.settings.services = L.DEFAULT_SERVICES;
    out.history = Array.isArray(s.history) ? s.history : [];
    out.techs = s.techs.filter(function (t) { return t && t.id != null && t.name; }).map(function (t) {
      return Object.assign({ points: 0, status: 'active', joinedAt: Date.now(), lastServedAt: null, jobs: [] }, t, {
        points: Number(t.points) || 0,
        jobs: Array.isArray(t.jobs) ? t.jobs : [],
      });
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

    var w = L.working(state);
    var wc = $('#working'); wc.innerHTML = '';
    w.forEach(function (t) { wc.appendChild(workingCard(t)); });
    $('#working-count').textContent = w.length;
    $('#working-wrap').classList.toggle('hidden', w.length === 0);

    var bc = $('#bench'); bc.innerHTML = '';
    bench.forEach(function (t) { bc.appendChild(card(t, null, false)); });
    $('#bench-wrap').classList.toggle('hidden', bench.length === 0);
    $('#empty').classList.toggle('hidden', anyToday);
    $('#queue').classList.toggle('hidden', !anyToday);
    $('#queue-empty').classList.toggle('hidden', !(anyToday && q.length === 0));

    if (window.FX && !firstRender) FX.play(board); // FLIP: trượt sang chỗ mới
    if (firstRender) {
      $$('.card', board).forEach(function (c, i) { c.classList.add('enter'); c.style.animationDelay = Math.min(i, 10) * 45 + 'ms'; });
      firstRender = false;
    }
    if (window.Hero3D) Hero3D.setColor(q.length ? colorOf(q[0].id) : DEFAULT_SHADE);

    renderLog();
  }

  function card(t, rank, isNext) {
    var cls = 'card' + (isNext ? ' next' : '') + (t.status !== 'active' ? ' ' + t.status : '');
    var badge = isNext ? el('span', { class: 'badge next', text: 'Next' })
      : t.status === 'paused' ? el('span', { class: 'badge paused', text: 'Tạm nghỉ' })
      : t.status === 'left' ? el('span', { class: 'badge left', text: 'Đã về' }) : null;
    var served = state.log.filter(function (e) { return e.type === 'assign' && e.techIds.indexOf(t.id) >= 0; }).length;
    var meta = served + ' khách' + (t.lastServedAt ? ' · lần cuối ' + fmtTime(t.lastServedAt) : '') + ' · vào ca ' + fmtTime(t.joinedAt);

    var actions = [];
    if (t.status === 'active') {
      actions.push(el('button', { class: 'btn primary', text: 'Nhận khách', onclick: function () { openAssign(t.id); } }));
      actions.push(el('button', { class: 'btn ghost', text: 'Bỏ lượt', title: 'Đang bận / không nhận khách này', onclick: function () {
        apply(function (s) { return L.skip(s, { techId: t.id }); }, t.name + ' bỏ lượt' + (state.settings.skipCosts ? ' (+1 turn)' : ''));
      } }));
      actions.push(el('button', { class: 'btn ghost', text: 'Tạm nghỉ', onclick: function () {
        apply(function (s) { return L.pause(s, { techId: t.id }); });
      } }));
      actions.push(el('button', { class: 'btn ghost', text: 'Về', onclick: function () {
        apply(function (s) { return L.leave(s, { techId: t.id }); });
      } }));
    } else {
      actions.push(el('button', { class: 'btn primary', text: t.status === 'paused' ? 'Quay lại hàng' : 'Quay lại làm', onclick: function () {
        apply(function (s) { return L.resume(s, { techId: t.id }); });
      } }));
    }
    actions.push(el('button', { class: 'btn subtle', text: '± điểm', onclick: function () { openAdjust(t.id); } }));

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
    if (m >= 60) return Math.floor(m / 60) + 'g' + String(m % 60).padStart(2, '0') + 'p';
    return m + ':' + String(s).padStart(2, '0');
  }
  function workingCard(t) {
    var jobs = L.activeJobs(t);
    var jobRows = jobs.map(function (j) {
      var timer = el('b', { class: 'timer mono', text: fmtDur(Date.now() - j.startedAt), dataset: { start: j.startedAt } });
      return el('div', { class: 'job' }, [
        el('div', { class: 'job-info' }, [
          el('span', { class: 'job-service', text: j.service || 'Khách' }),
          el('span', { class: 'job-meta' }, [
            el('span', { text: 'từ ' + fmtTime(j.startedAt) + ' · ' }),
            timer,
            el('span', { class: 'w', text: fmtPts(j.weight) + ' turn' }),
          ]),
          j.note ? el('span', { class: 'job-note', text: j.note }) : null,
        ]),
        el('button', { class: 'btn primary done', text: 'Xong', title: 'Làm xong khách này', onclick: function () {
          var before = state;
          apply(function (s) { return L.finish(s, { techId: t.id, jobId: j.id }); }, t.name + ' xong khách' + (j.service ? ' — ' + j.service : ''));
          if (state !== before) offerStart(j.id);
        } }),
      ]);
    });
    return el('div', { class: 'card busy', dataset: { id: t.id } }, [
      el('div', { class: 'card-top' }, [
        el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'badge busy', text: jobs.length > 1 ? 'Đang làm ' + jobs.length + ' khách' : 'Đang làm' }),
      ]),
      el('div', { class: 'card-name' }, [swatch(t.id), el('span', { text: t.name })]),
      el('div', { class: 'jobs' }, jobRows),
      pendingStrip(t),
      el('div', { class: 'card-points small' }, [el('b', { text: fmtPts(t.points) }), el('span', { text: 'turn hôm nay' })]),
      el('div', { class: 'card-actions' }, [
        el('button', { class: 'btn ghost', text: '＋ Nhận thêm', title: 'Nhận thêm 1 khách nữa dù đang làm', onclick: function () { openAssign(t.id); } }),
        el('button', { class: 'btn subtle', text: '± điểm', onclick: function () { openAdjust(t.id); } }),
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
          var nowP = e.parts.filter(function (p) { return !p.later; }), laterP = e.parts.filter(function (p) { return p.later; });
          var txt = nowP.map(function (p) { return nameOf(p.techId) + (p.service ? ' (' + p.service + ' ' + fmtPts(p.weight) + ')' : ''); }).join(' + ') + ' nhận khách';
          var out = [swatch(e.techIds[0]), el('span', { class: 'tag', text: txt })];
          if (laterP.length) out.push(el('span', { class: 'w later', text: laterP.map(function (p) { return nameOf(p.techId) + ' giữ: ' + (p.service || 'phần kế') + ' ' + fmtPts(p.weight); }).join(', ') }));
          if (e.note) out.push(el('span', { class: 'note', text: ' — ' + e.note }));
          return out;
        }
        var ws = e.techIds.map(function (id) { return fmtPts(e.weight[id]); }).join(' / ');
        var label = names + ' nhận khách' + (e.service ? ' · ' + e.service : '');
        return [swatch(e.techIds[0]), el('span', { class: 'tag', text: label }), el('span', { class: 'w', text: ws + ' turn' }), e.note ? el('span', { class: 'note', text: ' — ' + e.note }) : null];
      }
      case 'start': return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' bắt đầu' + (e.service ? ' · ' + e.service : '') })];
      case 'cancel': return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' huỷ phần chờ' + (e.service ? ' · ' + e.service : '') }), el('span', { class: 'w', text: fmtPts(Math.abs(e.weight)) + ' turn trả lại' })];
      case 'finish': {
        var dur = e.minutes >= 60 ? Math.floor(e.minutes / 60) + 'g' + (e.minutes % 60 ? (e.minutes % 60) + 'p' : '') : e.minutes + ' phút';
        return [swatch(e.techIds[0]), el('span', { class: 'tag', text: names + ' xong khách' + (e.service ? ' · ' + e.service : '') }), el('span', { class: 'w', text: dur })];
      }
      case 'skip': return [el('span', { class: 'tag', text: names + ' bỏ lượt' }), e.weight ? el('span', { class: 'w', text: '+1 turn' }) : null];
      case 'pause': return [el('span', { class: 'tag', text: names + ' tạm nghỉ' })];
      case 'resume': return [el('span', { class: 'tag', text: names + ' quay lại' })];
      case 'leave': return [el('span', { class: 'tag', text: names + ' về' })];
      case 'join': return [el('span', { class: 'tag', text: names + ' vào ca' }), e.weight ? el('span', { class: 'w', text: 'bắt đầu ' + fmtPts(e.weight) }) : null];
      case 'adjust': return [el('span', { class: 'tag', text: names + ' sửa điểm' }), el('span', { class: 'w', text: (e.weight > 0 ? '+' : '−') + fmtPts(Math.abs(e.weight)) }), e.note ? el('span', { class: 'note', text: ' — ' + e.note }) : null];
      default: return [el('span', { text: names + ' ' + e.type })];
    }
  }
  function renderLog() {
    var ol = $('#log'); ol.innerHTML = '';
    if (!state.log.length) { ol.appendChild(el('li', {}, [el('span', { class: 'log-empty', text: 'Chưa có gì hôm nay.' })])); return; }
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
    var other = el('button', { type: 'button', class: 'chip svc' + (assignCtx.service === '' ? ' on' : ''), text: 'Khác / không ghi' });
    other.addEventListener('click', function () { assignCtx.service = ''; renderServiceChips(); $('#assign-note').focus(); });
    box.appendChild(other);
  }
  // Các phần thêm (thợ khác cho cùng khách)
  function renderParts() {
    var box = $('#parts'); box.innerHTML = '';
    var others = L.activeTechs(state).filter(function (t) { return t.id !== assignCtx.techId; });
    assignCtx.parts.forEach(function (p, i) {
      var techSel = el('select', { class: 'input' });
      others.forEach(function (t) {
        var o = el('option', { value: t.id, text: t.name + (L.isBusy(t) ? ' (đang bận)' : '') });
        if (t.id === p.techId) o.selected = true;
        techSel.appendChild(o);
      });
      techSel.addEventListener('change', function () { p.techId = techSel.value; });
      var svcSel = el('select', { class: 'input' });
      servicesList().forEach(function (svc) {
        var o = el('option', { value: svc.name, text: svc.name + ' · ' + fmtPts(svc.weight) });
        if (svc.name === p.service) o.selected = true;
        svcSel.appendChild(o);
      });
      var oOther = el('option', { value: '', text: 'Khác' }); if (p.service === '') oOther.selected = true; svcSel.appendChild(oOther);
      var wIn = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: String(p.weight), title: 'Số turn' });
      wIn.addEventListener('input', function () { p.weight = Number(wIn.value); });
      svcSel.addEventListener('change', function () { p.service = svcSel.value; if (svcSel.value) { p.weight = serviceWeight(svcSel.value); wIn.value = String(p.weight); } });
      var when = el('div', { class: 'seg2' }, [
        el('button', { type: 'button', class: 'seg2-btn' + (!p.later ? ' on' : ''), text: 'Cùng lúc', onclick: function () { p.later = false; renderParts(); } }),
        el('button', { type: 'button', class: 'seg2-btn' + (p.later ? ' on' : ''), text: 'Làm sau', onclick: function () { p.later = true; renderParts(); } }),
      ]);
      var rm = el('button', { type: 'button', class: 'btn subtle', text: '✕', title: 'Bỏ phần này', onclick: function () { assignCtx.parts.splice(i, 1); renderParts(); } });
      box.appendChild(el('div', { class: 'part-row' + (p.later ? ' later' : '') }, [techSel, svcSel, wIn, when, rm]));
    });
    $('#btn-add-part').disabled = others.length === 0;
  }
  $('#btn-add-part').addEventListener('click', function () {
    var others = L.activeTechs(state).filter(function (t) { return t.id !== assignCtx.techId; });
    if (!others.length) return;
    // gợi ý: thợ rảnh kế tiếp trong hàng; dịch vụ đầu danh sách
    var q = L.queue(state).filter(function (t) { return t.id !== assignCtx.techId; });
    var pick = (q[0] || others[0]).id;
    var svc = servicesList()[0] || { name: '', weight: 1 };
    assignCtx.parts.push({ techId: pick, service: svc.name, weight: Number(svc.weight), later: assignCtx.parts.length === 0 });
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
    if (!(w >= 0)) { alert('Số turn không hợp lệ'); return; }
    var parts = [{ techId: assignCtx.techId, service: assignCtx.service || '', weight: w, later: false }];
    for (var i = 0; i < assignCtx.parts.length; i++) {
      var p = assignCtx.parts[i];
      if (!p.techId) { alert('Chưa chọn thợ cho phần thêm'); return; }
      if (!(p.weight >= 0)) { alert('Số turn phần thêm không hợp lệ'); return; }
      parts.push({ techId: p.techId, service: p.service || '', weight: p.weight, later: !!p.later });
    }
    var note = $('#assign-note').value.trim();
    var ids = parts.map(function (p) { return p.techId; });
    var before = state;
    apply(function (s) { return L.assign(s, { parts: parts, note: note }); },
      parts.filter(function (p) { return !p.later; }).map(function (p) { return nameOf(p.techId); }).join(' + ') + ' nhận khách'
      + (parts.some(function (p) { return p.later; }) ? ' · ' + parts.filter(function (p) { return p.later; }).map(function (p) { return nameOf(p.techId); }).join(', ') + ' giữ khách làm sau' : ''));
    $('#dlg-assign').close();
    if (state !== before && window.FX) {
      // Ăn mừng: glitter từ thẻ vừa nhận khách (đang trượt sang chỗ mới) + chai 3D lắc
      ids.forEach(function (id, i) {
        var cardEl = $('.card[data-id="' + id + '"]');
        if (cardEl) setTimeout(function () { FX.burst(cardEl, { count: i === 0 ? 90 : 50 }); }, 40);
      });
      if (window.Hero3D) Hero3D.wiggle();
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
          el('span', { text: ' — ' + (x.job.service || 'phần kế') + ' · ' + fmtPts(x.job.weight) + ' turn' }),
          busy ? el('span', { class: 'muted', text: ' (đang bận khách khác)' }) : null,
        ]),
        el('button', { type: 'button', class: 'btn primary', text: busy ? 'Vẫn bắt đầu' : 'Bắt đầu ngay', onclick: function () {
          apply(function (s) { return L.startJob(s, { techId: x.tech.id, jobId: x.job.id }); }, x.tech.name + ' bắt đầu ' + (x.job.service || 'phần kế'));
          $('#dlg-start').close();
        } }),
      ]));
    });
    $('#dlg-start').showModal();
  }
  function startPending(techId, jobId) {
    apply(function (s) { return L.startJob(s, { techId: techId, jobId: jobId }); }, nameOf(techId) + ' bắt đầu làm');
  }
  function cancelPending(techId, jobId, service) {
    if (!confirm('Huỷ phần "' + (service || 'làm sau') + '" của ' + nameOf(techId) + '? Turn đã tính sẽ được trả lại.')) return;
    apply(function (s) { return L.cancelPending(s, { techId: techId, jobId: jobId }); }, 'Đã huỷ phần chờ');
  }
  // Dải "đang giữ khách" trên thẻ (hàng chờ lẫn đang làm)
  function pendingStrip(t) {
    var pend = L.pendingJobs(t);
    if (!pend.length) return null;
    return el('div', { class: 'pending' }, pend.map(function (j) {
      var afterNames = (j.after || []).map(nameOf).join(', ');
      return el('div', { class: 'pending-row' }, [
        el('div', { class: 'pending-info' }, [
          el('span', { class: 'pending-tag', text: 'Giữ khách' }),
          el('span', { class: 'pending-svc', text: (j.service || 'phần kế') + ' · ' + fmtPts(j.weight) + ' turn' }),
          afterNames ? el('span', { class: 'pending-after', text: 'sau khi ' + afterNames + ' xong' }) : null,
        ]),
        el('div', { class: 'pending-ops' }, [
          el('button', { class: 'btn ghost', text: 'Bắt đầu', onclick: function () { startPending(t.id, j.id); } }),
          el('button', { class: 'btn subtle', text: 'Huỷ', onclick: function () { cancelPending(t.id, j.id, j.service); } }),
        ]),
      ]);
    }));
  }

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
    apply(function (s) { return L.adjust(s, { techId: adjustCtx.techId, delta: d, note: note }); }, 'Đã sửa điểm ' + nameOf(adjustCtx.techId));
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
        apply(function (s) { return L.rejoin(s, { techId: t.id }); }, t.name + ' vào ca');
        $('#dlg-add').close();
      } }));
    });
    var late = state.settings.lateCatchUp && L.activeTechs(state).length > 0;
    $('#add-hint').textContent = late
      ? 'Đang giữa ngày: thợ mới sẽ bắt đầu bằng điểm thấp nhất hiện tại (' + fmtPts(Math.min.apply(null, L.activeTechs(state).map(function (t) { return t.points; }))) + ') — đổi trong Cài đặt.'
      : '';
    $('#dlg-add').showModal();
    $('#add-name').focus();
  }
  $('#form-add').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('#add-name').value.trim();
    if (!name) return;
    apply(function (s) { return L.addTech(s, { name: name }); }, name + ' vào ca');
    $('#dlg-add').close();
  });
  $('#btn-add').addEventListener('click', openAdd);
  $('[data-action="open-add"]').addEventListener('click', openAdd);

  // ── Ngày mới ──────────────────────────────────────────
  var newdayCtx = { rows: [] }; // [{id|null, name, working, isNew}]
  function openNewDay() {
    var lastActiveOrder = state.techs.slice().sort(function (a, b) { return a.joinedAt - b.joinedAt; });
    newdayCtx.rows = lastActiveOrder.map(function (t) {
      return { id: t.id, name: t.name, working: t.status !== 'off', isNew: false };
    });
    $('#newday-newname').value = '';
    renderNewDayList();
    $('#dlg-newday').showModal();
  }
  function renderNewDayList() {
    var box = $('#newday-list'); box.innerHTML = '';
    if (!newdayCtx.rows.length) box.appendChild(el('p', { class: 'muted', text: 'Chưa có thợ nào — thêm bên dưới.' }));
    newdayCtx.rows.forEach(function (r, i) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = r.working;
      cb.addEventListener('change', function () { r.working = cb.checked; renderNewDayList(); });
      box.appendChild(el('div', { class: 'roster-row' + (r.working ? '' : ' off') }, [
        cb,
        el('span', { class: 'name', text: r.name + (r.isNew ? ' (mới)' : '') }),
        el('div', { class: 'ops' }, [
          el('button', { type: 'button', class: 'btn ghost', text: '▲', disabled: i === 0 ? 'true' : null, onclick: function () { move(i, -1); } }),
          el('button', { type: 'button', class: 'btn ghost', text: '▼', disabled: i === newdayCtx.rows.length - 1 ? 'true' : null, onclick: function () { move(i, 1); } }),
        ]),
      ]));
    });
  }
  function move(i, dir) {
    var j = i + dir; if (j < 0 || j >= newdayCtx.rows.length) return;
    var tmp = newdayCtx.rows[i]; newdayCtx.rows[i] = newdayCtx.rows[j]; newdayCtx.rows[j] = tmp;
    renderNewDayList();
  }
  function addNewDayName() {
    var name = $('#newday-newname').value.trim();
    if (!name) return;
    newdayCtx.rows.push({ id: null, name: name, working: true, isNew: true });
    $('#newday-newname').value = '';
    renderNewDayList();
  }
  $('#newday-addname').addEventListener('click', addNewDayName);
  $('#newday-newname').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addNewDayName(); } });
  $('#form-newday').addEventListener('submit', function (ev) {
    ev.preventDefault();
    apply(function (s) {
      var now = Date.now();
      // 1) thêm thợ mới vào danh sách (điểm sẽ về 0 ở bước newDay)
      var ids = [];
      newdayCtx.rows.forEach(function (r) {
        if (r.id) { ids.push(r.id); return; }
        var id = 'n' + Math.random().toString(36).slice(2, 9);
        s = L.addTech(s, { name: r.name, id: id, points: 0, now: now });
        r.id = id; ids.push(id);
      });
      // 2) ngày mới với thứ tự vào ca như trong danh sách
      var working = newdayCtx.rows.filter(function (r) { return r.working; }).map(function (r) { return r.id; });
      return L.newDay(s, { now: now, workingIds: working });
    }, 'Bắt đầu ngày mới');
    $('#dlg-newday').close();
  });
  $('#btn-newday').addEventListener('click', openNewDay);

  // ── Tổng kết ──────────────────────────────────────────
  $('#btn-summary').addEventListener('click', function () {
    var tb = $('#summary-table tbody'); tb.innerHTML = '';
    var rows = L.summary(state);
    if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'muted', text: 'Chưa có dữ liệu.' })]));
    var statusText = { active: 'Trong ca', paused: 'Tạm nghỉ', left: 'Đã về' };
    rows.forEach(function (r) {
      tb.appendChild(el('tr', {}, [
        el('td', { text: r.name }), el('td', { class: 'num', text: String(r.customers) }),
        el('td', { class: 'num', text: fmtPts(r.points) }), el('td', { class: 'num', text: String(r.skips) }), el('td', { class: 'num', text: r.minutes ? String(r.minutes) : '–' }),
        el('td', { text: r.busy ? 'Đang làm khách' : (statusText[r.status] || r.status) }),
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
      var wInput = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: String(svc.weight), title: 'Số turn', style: 'max-width:80px;padding:5px 8px' });
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
          el('button', { type: 'button', class: 'btn ghost', text: 'Xoá', onclick: function () {
            var list = servicesList(); list.splice(i, 1); saveServices(list);
          } }),
        ]),
      ]));
    });
  }
  function addService() {
    var name = $('#svc-name').value.trim(); var w = Number($('#svc-weight').value);
    if (!name) { $('#svc-name').focus(); return; }
    if (!(w >= 0)) { alert('Số turn không hợp lệ'); return; }
    var list = servicesList();
    if (list.some(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })) { alert('Đã có dịch vụ tên này'); return; }
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
    if (!state.techs.length) box.appendChild(el('p', { class: 'muted', text: 'Chưa có thợ.' }));
    state.techs.forEach(function (t) {
      box.appendChild(el('div', { class: 'roster-row' }, [
        el('span', { class: 'muted', text: '•' }),
        el('span', { class: 'name', text: t.name }),
        el('div', { class: 'ops' }, [
          el('button', { type: 'button', class: 'btn ghost', text: 'Đổi tên', onclick: function () {
            var n = prompt('Tên mới cho ' + t.name + ':', t.name);
            if (n && n.trim()) apply(function (s) { return L.renameTech(s, { techId: t.id, name: n }); });
            renderSettingsRoster();
          } }),
          el('button', { type: 'button', class: 'btn ghost', text: 'Xoá', onclick: function () {
            if (L.isBusy(t)) { alert(t.name + ' đang làm khách — bấm Xong trước rồi mới xoá.'); return; }
            var hasToday = state.log.some(function (e) { return e.techIds.indexOf(t.id) >= 0; });
            var msg = hasToday
              ? t.name + ' có hoạt động trong nhật ký hôm nay. Xoá khỏi danh sách thợ? (nhật ký vẫn giữ tên; muốn thợ chỉ nghỉ hôm nay thì dùng nút Về thay vì xoá)'
              : 'Xoá hẳn ' + t.name + ' khỏi danh sách? (có thể Hoàn tác)';
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
        if (!confirm('Thay toàn bộ dữ liệu hiện tại bằng file này? (' + imported.techs.length + ' thợ, ngày ' + imported.date + ')')) return;
        apply(function () { return imported; }, 'Đã nạp dữ liệu');
        $('#dlg-settings').close();
      } catch (e) { alert(e.message); }
    };
    r.readAsText(f);
    ev.target.value = '';
  });

  // ── Hoàn tác ──────────────────────────────────────────
  $('#btn-undo').addEventListener('click', function () {
    apply(function (s) { return L.undo(s); }, 'Đã hoàn tác');
  });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !$$('dialog[open]').length) {
      ev.preventDefault();
      if (L.canUndo(state)) apply(function (s) { return L.undo(s); }, 'Đã hoàn tác');
    }
  });

  // ── Theme + hiệu ứng + 3D ─────────────────────────────
  function themeIcon(t) { $('#btn-theme').textContent = t === 'dark' ? '☀' : '🌙'; }
  if (window.FX) {
    var t0 = FX.theme.init();
    themeIcon(t0);
    $('#btn-theme').addEventListener('click', function () {
      var t = FX.theme.toggle();
      themeIcon(t);
      if (window.Hero3D) Hero3D.setTheme(t);
    });
    FX.tilt($('.board'));
  }

  // ── Khởi động ─────────────────────────────────────────
  state = load();
  if (window.Hero3D) {
    var q0 = L.queue(state);
    Hero3D.mount($('#hero3d'), { color: q0.length ? colorOf(q0[0].id) : DEFAULT_SHADE, pointerZone: $('#topbar') });
    Hero3D.setTheme(window.FX ? FX.theme.get() : 'light');
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
    s = L.assign(s, { techId: 'vy', weight: 0.5, service: 'Đổi nước sơn', now: now - 140 * m });
    s = L.finish(s, { techId: 'vy', now: now - 125 * m });
    s = L.assign(s, { techId: 'tuan', weight: 1, service: 'Pedicure', now: now - 130 * m });
    s = L.finish(s, { techId: 'lan', now: now - 95 * m });
    s = L.assign(s, { parts: [{ techId: 'hoa', service: 'Pedicure', weight: 1 }, { techId: 'tuan', service: 'Mani thường', weight: 0.5, later: true }], now: now - 120 * m, note: 'khách làm chân trước, tay sau' });
    s = L.finish(s, { techId: 'tuan', now: now - 80 * m });
    s = L.skip(s, { techId: 'vy', now: now - 100 * m });
    s = L.assign(s, { techIds: ['vy', 'lan'], weight: { vy: 0.5, lan: 0.5 }, service: 'Mani + Pedi', now: now - 90 * m, note: 'làm chung tay + chân' });
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
  } else if (L.isNewDay(state)) {
    openNewDay();
  }
})();
