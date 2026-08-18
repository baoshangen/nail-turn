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
  function nameOf(id) { var t = L.findTech(state, id); return t ? t.name : '?'; }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  // ── Lưu / nạp ─────────────────────────────────────────
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && Array.isArray(s.techs)) {
          s.settings = Object.assign({}, L.DEFAULT_SETTINGS, s.settings || {});
          s.history = s.history || [];
          return s;
        }
      }
    } catch (e) { console.warn('Không đọc được dữ liệu cũ', e); }
    return L.createState();
  }
  // Mọi thay đổi đi qua đây: áp hành động → lưu → vẽ lại.
  function apply(fn, okMsg) {
    try {
      state = fn(state);
      save();
      render();
      if (okMsg) toast(okMsg);
    } catch (e) {
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

    $('#queue-count').textContent = q.length;
    var qc = $('#queue'); qc.innerHTML = '';
    q.forEach(function (t, i) { qc.appendChild(card(t, i, i === 0)); });

    var bc = $('#bench'); bc.innerHTML = '';
    bench.forEach(function (t) { bc.appendChild(card(t, null, false)); });
    $('#bench-wrap').classList.toggle('hidden', bench.length === 0);
    $('#empty').classList.toggle('hidden', anyToday);
    $('#queue').classList.toggle('hidden', !anyToday);

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
      el('div', { class: 'card-name', text: t.name }),
      el('div', { class: 'card-points' }, [el('b', { text: fmtPts(t.points) }), el('span', { text: 'turn' })]),
      el('div', { class: 'card-meta', text: meta }),
      el('div', { class: 'card-actions' }, actions),
    ]);
  }

  function describe(e) {
    var names = e.techIds.map(nameOf).join(' + ');
    switch (e.type) {
      case 'assign': {
        var ws = e.techIds.map(function (id) { return fmtPts(e.weight[id]); }).join(' / ');
        return [el('span', { class: 'tag', text: names + ' nhận khách' }), el('span', { class: 'w', text: ws + ' turn' }), e.note ? el('span', { class: 'note', text: ' — ' + e.note }) : null];
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
    state.log.slice().reverse().forEach(function (e) {
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
  var assignCtx = { techId: null, weight: 1, custom: false, coworkers: [] };
  segmented($('#weight-seg'), function (v) {
    assignCtx.custom = v === 'custom';
    $('#weight-custom').classList.toggle('hidden', !assignCtx.custom);
    if (assignCtx.custom) $('#weight-custom').focus();
    else assignCtx.weight = Number(v);
    refreshSplit();
  });
  $('#weight-custom').addEventListener('input', refreshSplit);
  function currentWeight() {
    if (assignCtx.custom) return Number($('#weight-custom').value);
    return assignCtx.weight;
  }
  function openAssign(techId) {
    assignCtx = { techId: techId, weight: 1, custom: false, coworkers: [] };
    $('#assign-name').textContent = nameOf(techId);
    pickSeg($('#weight-seg'), 1);
    $('#weight-custom').classList.add('hidden'); $('#weight-custom').value = '';
    $('#assign-note').value = '';
    var cw = $('#coworkers'); cw.innerHTML = '';
    L.activeTechs(state).filter(function (t) { return t.id !== techId; }).forEach(function (t) {
      var chip = el('button', { type: 'button', class: 'chip', text: t.name });
      chip.addEventListener('click', function () {
        var i = assignCtx.coworkers.indexOf(t.id);
        if (i >= 0) assignCtx.coworkers.splice(i, 1); else assignCtx.coworkers.push(t.id);
        chip.classList.toggle('on', i < 0);
        refreshSplit();
      });
      cw.appendChild(chip);
    });
    refreshSplit();
    $('#dlg-assign').showModal();
  }
  function refreshSplit() {
    var ids = [assignCtx.techId].concat(assignCtx.coworkers);
    var wrap = $('#split-wrap');
    if (ids.length < 2) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    var w = currentWeight();
    var each = isFinite(w) ? Math.round((w / ids.length) * 100) / 100 : 0;
    var rows = $('#split-rows'); rows.innerHTML = '';
    ids.forEach(function (id) {
      rows.appendChild(el('div', { class: 'split-row' }, [
        el('span', { text: nameOf(id) }),
        el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: String(each), dataset: { id: id } }),
      ]));
    });
  }
  $('#form-assign').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var ids = [assignCtx.techId].concat(assignCtx.coworkers);
    var weight;
    if (ids.length > 1) {
      weight = {};
      $$('#split-rows input').forEach(function (inp) { weight[inp.dataset.id] = Number(inp.value); });
    } else {
      weight = currentWeight();
    }
    var note = $('#assign-note').value.trim();
    var bad = typeof weight === 'number' ? !(weight >= 0) : Object.keys(weight).some(function (k) { return !(weight[k] >= 0); });
    if (bad) { alert('Số turn không hợp lệ'); return; }
    apply(function (s) { return L.assign(s, { techIds: ids, weight: weight, note: note }); },
      ids.map(nameOf).join(' + ') + ' nhận khách');
    $('#dlg-assign').close();
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
    if (!rows.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'muted', text: 'Chưa có dữ liệu.' })]));
    var statusText = { active: 'Đang làm', paused: 'Tạm nghỉ', left: 'Đã về' };
    rows.forEach(function (r) {
      tb.appendChild(el('tr', {}, [
        el('td', { text: r.name }), el('td', { class: 'num', text: String(r.customers) }),
        el('td', { class: 'num', text: fmtPts(r.points) }), el('td', { class: 'num', text: String(r.skips) }),
        el('td', { text: statusText[r.status] || r.status }),
      ]));
    });
    $('#dlg-summary').showModal();
  });

  // ── Cài đặt ───────────────────────────────────────────
  $('#btn-settings').addEventListener('click', function () {
    $('#set-skipcosts').checked = !!state.settings.skipCosts;
    $('#set-latecatchup').checked = !!state.settings.lateCatchUp;
    renderSettingsRoster();
    $('#dlg-settings').showModal();
  });
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
            if (!confirm('Xoá hẳn ' + t.name + ' khỏi danh sách? (có thể Hoàn tác)')) return;
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
        var s = JSON.parse(r.result);
        if (!s || !Array.isArray(s.techs)) throw new Error('File không đúng định dạng');
        if (!confirm('Thay toàn bộ dữ liệu hiện tại bằng file này?')) return;
        state = s; state.history = state.history || []; save(); render(); toast('Đã nạp dữ liệu');
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

  // ── Khởi động ─────────────────────────────────────────
  state = load();
  // Mở với #demo khi chưa có thợ → nạp dữ liệu mẫu để xem thử (bấm "Ngày mới" là dọn sạch).
  if (state.techs.length === 0 && location.hash === '#demo') {
    var now = Date.now(), m = 60000;
    var s = state;
    s = L.addTech(s, { name: 'Chị Lan', id: 'lan', now: now - 180 * m });
    s = L.addTech(s, { name: 'Bé Vy', id: 'vy', now: now - 175 * m });
    s = L.addTech(s, { name: 'Anh Tuấn', id: 'tuan', now: now - 170 * m });
    s = L.addTech(s, { name: 'Chị Hoa', id: 'hoa', now: now - 160 * m });
    s = L.assign(s, { techId: 'lan', weight: 1, now: now - 150 * m, note: 'full set gel' });
    s = L.assign(s, { techId: 'vy', weight: 0.5, now: now - 140 * m, note: 'đổi nước sơn' });
    s = L.assign(s, { techId: 'tuan', weight: 1, now: now - 130 * m, note: 'pedicure' });
    s = L.assign(s, { techId: 'hoa', weight: 1, now: now - 120 * m, note: 'khách request' });
    s = L.skip(s, { techId: 'vy', now: now - 100 * m });
    s = L.assign(s, { techIds: ['vy', 'lan'], weight: { vy: 0.5, lan: 0.5 }, now: now - 90 * m, note: 'làm chung tay + chân' });
    s = L.pause(s, { techId: 'tuan', now: now - 30 * m });
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
