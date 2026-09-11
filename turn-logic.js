/*
 * turn-logic.js — LOGIC THUẦN cho bảng chấm turn tiệm nail.
 * Không đụng DOM, không đụng localStorage. Mọi hàm nhận state → trả state MỚI
 * (không sửa state cũ), nên undo chỉ là "lấy lại state trước đó".
 *
 * Mô hình: mỗi thợ có `points` (số turn tích luỹ). Ai ít điểm nhất = NEXT.
 * Mọi tình huống ngoại lệ đều quy về: trọng số khi giao khách / tạm nghỉ / sửa tay / undo.
 *
 * Trạng thái thợ (status):
 *   'active' – đang trong hàng chờ
 *   'paused' – tạm nghỉ (ẩn khỏi NEXT, giữ điểm)
 *   'left'   – về sớm (ẩn khỏi NEXT, còn trong tổng kết)
 *   'off'    – hôm nay không đi làm (chỉ nằm trong danh sách thợ)
 */
(function (root) {
  'use strict';

  var HISTORY_LIMIT = 20;

  // Danh sách dịch vụ mặc định + số turn tương ứng (Ray sửa được trong Cài đặt).
  var DEFAULT_SERVICES = [
    { name: 'Full set', weight: 1 },
    { name: 'Fill', weight: 1 },
    { name: 'Gel', weight: 1 },
    { name: 'Pedicure', weight: 1 },
    { name: 'Mani + Pedi', weight: 1 },
    { name: 'Regular mani', weight: 0.5 },
    { name: 'Polish change', weight: 0.5 },
    { name: 'Design', weight: 1 },
  ];
  var DEFAULT_SETTINGS = {
    skipCosts: false,   // Skip = mất lượt (+1 turn)?
    lateCatchUp: true,  // Thợ vào trễ khởi đầu = điểm thấp nhất hiện tại?
    services: DEFAULT_SERVICES,
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function todayStr(now) {
    var d = new Date(now);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /* ── Ngày tháng ────────────────────────────────────────
   * Luôn dựng Date từ 3 số rời (năm, tháng, ngày) chứ KHÔNG new Date('2026-09-09'):
   * chuỗi ISO trần bị đọc theo giờ UTC, ở múi giờ Mỹ sẽ lùi thành hôm trước.
   */
  function parseDate(str) {
    var p = String(str).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  // Thứ trong tuần của 1 ngày: 0 = Chủ nhật ... 6 = Thứ bảy (đúng chuẩn Date.getDay).
  function dayIndexOf(dateStr) { return parseDate(dateStr).getDay(); }
  function addDays(dateStr, n) {
    var d = parseDate(dateStr);
    d.setDate(d.getDate() + n);
    return todayStr(d.getTime());
  }
  // Thứ 2 của tuần chứa ngày này (tuần tiệm chạy Thứ 2 → Chủ nhật, theo yêu cầu của Ray).
  function weekStart(dateStr) {
    var d = dayIndexOf(dateStr);
    return addDays(dateStr, d === 0 ? -6 : 1 - d);
  }
  function weekDays(monday) {
    var out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(monday, i));
    return out;
  }

  function newId() {
    return 't' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  }

  function createState(opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    return {
      date: opts.date || todayStr(now),
      techs: [],
      log: [],
      waiting: [],   // khách chờ CHƯA gán thợ: {wid, ticket, service, weight, note, createdAt}
      settings: Object.assign({}, DEFAULT_SETTINGS, opts.settings || {}),
      history: [],
    };
  }

  // Ghi snapshot state hiện tại vào history rồi áp thay đổi lên bản sao.
  function commit(state, mutate) {
    var snapshot = clone(state);
    delete snapshot.history;
    var next = clone(state);
    next.history = (state.history || []).concat([snapshot]).slice(-HISTORY_LIMIT);
    mutate(next);
    return next;
  }

  function undo(state) {
    if (!state.history || state.history.length === 0) return state;
    var prev = clone(state.history[state.history.length - 1]);
    prev.history = state.history.slice(0, -1);
    return prev;
  }

  function canUndo(state) {
    return !!(state.history && state.history.length);
  }

  function findTech(state, id) {
    for (var i = 0; i < state.techs.length; i++) {
      if (state.techs[i].id === id) return state.techs[i];
    }
    return null;
  }

  // Thợ trong ca (active) — gồm cả rảnh lẫn đang làm khách.
  function activeTechs(state) {
    return state.techs.filter(function (t) { return t.status === 'active'; });
  }
  /*
   * Job của thợ: { id: ticket, service, weight, note, startedAt, pending, after }
   *   - ticket: chung cho mọi phần của CÙNG 1 khách (khách 2 dịch vụ / 2 thợ)
   *   - pending=true: thợ đang GIỮ khách này, chưa làm (làm sau khi thợ `after` xong) → vẫn ở hàng chờ
   *   - pending=false: đang làm thật, đồng hồ chạy từ startedAt → bận, rời hàng chờ
   */
  function jobsOf(t) { return t.jobs || []; }
  function activeJobs(t) { return jobsOf(t).filter(function (j) { return !j.pending; }); }
  function pendingJobs(t) { return jobsOf(t).filter(function (j) { return j.pending; }); }
  function isBusy(t) { return activeJobs(t).length > 0; }
  // Thợ đang làm khách (có ít nhất 1 job đang chạy), theo thứ tự bắt đầu sớm nhất.
  function working(state) {
    return activeTechs(state).filter(isBusy).slice().sort(function (a, b) {
      return activeJobs(a)[0].startedAt - activeJobs(b)[0].startedAt;
    });
  }
  // Các phần "làm sau" của cùng 1 khách (ticket) đang chờ — dùng để hỏi "Bắt đầu phần kế?" khi phần trước xong.
  function pendingForTicket(state, ticket) {
    var out = [];
    state.techs.forEach(function (t) {
      pendingJobs(t).forEach(function (j) { if (j.id === ticket) out.push({ tech: t, job: j }); });
    });
    return out;
  }

  function minActivePoints(state) {
    var act = activeTechs(state);
    if (!act.length) return 0;
    return Math.min.apply(null, act.map(function (t) { return t.points; }));
  }

  /*
   * LUẬT XẾP HÀNG — ai đứng trước ai. Đây là trái tim của app; đổi luật tiệm thì sửa ở đây.
   * Mặc định:
   *   1. Ít turn hơn → đứng trước.
   *   2. Hoà điểm → ai làm khách gần nhất LÂU HƠN đứng trước.
   *      (chưa làm ai thì lấy giờ vào ca — nên thợ vào trễ, dù bắt kịp điểm, vẫn đứng sau)
   *   3. Vẫn hoà → giờ vào ca sớm hơn đứng trước.
   */
  function compareTechs(a, b) {
    if (a.points !== b.points) return a.points - b.points;
    var ta = a.lastServedAt != null ? a.lastServedAt : a.joinedAt;
    var tb = b.lastServedAt != null ? b.lastServedAt : b.joinedAt;
    if (ta !== tb) return ta - tb;
    return a.joinedAt - b.joinedAt;
  }

  // Hàng chờ = thợ trong ca VÀ đang rảnh (không có job). Thợ đang làm không thể là NEXT.
  function queue(state) {
    return activeTechs(state).filter(function (t) { return !isBusy(t); }).sort(compareTechs);
  }

  function nextTech(state) {
    var q = queue(state);
    return q.length ? q[0] : null;
  }

  function addLog(state, entry) {
    state.log.push(entry);
  }

  // Thêm thợ mới vào hàng (đầu ngày hoặc vào trễ giữa ngày).
  function addTech(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    var name = String(opts.name || '').trim();
    if (!name) throw new Error('Tech name is empty');
    return commit(state, function (s) {
      var pts = 0;
      if (s.settings.lateCatchUp && activeTechs(s).length > 0) pts = minActivePoints(s);
      if (opts.points != null) pts = opts.points;
      var tech = {
        id: opts.id || newId(),
        name: name,
        points: pts,
        status: 'active',
        joinedAt: now,
        lastServedAt: null,
      };
      s.techs.push(tech);
      addLog(s, { t: now, type: 'join', techIds: [tech.id], weight: pts, note: '' });
    });
  }

  // Thợ có sẵn trong danh sách (status 'off') vào ca giữa ngày — cùng luật vào trễ như addTech.
  function rejoin(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      var pts = 0;
      if (s.settings.lateCatchUp && activeTechs(s).length > 0) pts = minActivePoints(s);
      t.status = 'active';
      t.points = pts;
      t.joinedAt = now;
      t.lastServedAt = null;
      addLog(s, { t: now, type: 'join', techIds: [t.id], weight: pts, note: '' });
    });
  }

  /*
   * Giao khách. techIds: 1 hay nhiều thợ. weight: số (áp cho tất cả) hoặc {id: số}.
   * service: tên dịch vụ (tuỳ chọn). Mỗi thợ được cộng điểm NGAY và nhận 1 job (đang làm) →
   * rời hàng chờ cho tới khi bấm finish(). Thợ đang bận vẫn nhận thêm được (job thứ 2).
   */
  function assign(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    // Chuẩn hoá về dạng parts: [{techId, weight, service, later}]
    var parts;
    if (Array.isArray(opts.parts) && opts.parts.length) {
      parts = opts.parts.map(function (p) { return { techId: p.techId, weight: p.weight, service: p.service || opts.service || '', later: !!p.later }; });
    } else {
      var ids = opts.techIds || (opts.techId ? [opts.techId] : []);
      parts = ids.map(function (id) {
        var w;
        if (typeof opts.weight === 'number') w = opts.weight;
        else if (opts.weight && typeof opts.weight === 'object') w = Number(opts.weight[id]);
        else w = 1;
        return { techId: id, weight: w, service: opts.service || '', later: false };
      });
    }
    if (!parts.length) throw new Error('No tech selected');
    // Phần techId=null = khách chờ (pending, chưa biết ai làm) — không tính là "làm ngay"
    if (!parts.some(function (p) { return p.techId && !p.later; })) throw new Error('At least one part must start now');
    var nowIds = parts.filter(function (p) { return p.techId && !p.later; }).map(function (p) { return p.techId; });
    return commit(state, function (s) {
      var perTech = {};
      var ticket = 'j' + now.toString(36) + Math.random().toString(36).slice(2, 6);
      if (!s.waiting) s.waiting = [];
      parts.forEach(function (p) {
        var w = Number(p.weight);
        if (!(w >= 0)) throw new Error('Invalid turn amount');
        if (!p.techId) { // pending: vào hàng khách chờ, KHÔNG cộng điểm ai — điểm tính lúc thợ nhận
          s.waiting.push({ wid: newId(), ticket: ticket, service: p.service || '', weight: w, note: opts.note || '', createdAt: now });
          return;
        }
        var t = findTech(s, p.techId);
        if (!t) throw new Error('Tech not found: ' + p.techId);
        t.points = round2(t.points + w);          // turn tính NGAY lúc khách vào (kể cả phần làm sau)
        t.lastServedAt = now;
        perTech[p.techId] = round2((perTech[p.techId] || 0) + w);
        if (!t.jobs) t.jobs = [];
        t.jobs.push({
          id: ticket, service: p.service || '', weight: w, note: opts.note || '',
          startedAt: p.later ? null : now,
          pending: !!p.later,
          after: p.later ? nowIds.slice() : [],
        });
      });
      addLog(s, {
        t: now, type: 'assign',
        techIds: parts.filter(function (p) { return p.techId; }).map(function (p) { return p.techId; }),
        weight: perTech, note: opts.note || '',
        service: parts[0].service || '', jobId: ticket,
        parts: parts.map(function (p) { return { techId: p.techId || null, service: p.service || '', weight: p.weight, later: !!p.later }; }),
      });
    });
  }

  // ── Khách chờ (pending, CHƯA gán thợ) ─────────────────
  function waitingList(state) {
    return (state.waiting || []).slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  /*
   * Gom các phần việc của CÙNG một khách chờ thành 1 nhóm.
   * Khách làm chân + tay = 1 người ngồi đó, không phải 2 khách — nên trên màn hình
   * phải là 1 thẻ có nhiều dòng, chứ không phải nhiều thẻ rời.
   */
  function waitingGroups(state) {
    var order = [], by = {};
    waitingList(state).forEach(function (x) {
      if (!by[x.ticket]) {
        by[x.ticket] = { ticket: x.ticket, createdAt: x.createdAt, note: '', parts: [], weight: 0, assigned: 0 };
        order.push(x.ticket);
      }
      var g = by[x.ticket];
      if (x.createdAt < g.createdAt) g.createdAt = x.createdAt;
      if (!g.note && x.note) g.note = x.note;
      g.weight = round2(g.weight + (Number(x.weight) || 0));
      if (x.techId) g.assigned += 1;
      g.parts.push(x);
    });
    return order.map(function (k) { return by[k]; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  /*
   * Thêm khách chờ. Truyền `ticket` của một khách đang chờ = thêm PHẦN VIỆC cho chính người đó.
   * `techId` = gán sẵn thợ để sắp xếp trước; CỐ Ý KHÔNG tính turn ở đây —
   * turn chỉ tính lúc bấm Start (claimWaiting), nên khách bỏ về thì không ai thiệt.
   */
  function addWaiting(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    var w = Number(opts.weight);
    if (!(w >= 0)) throw new Error('Invalid turn amount');
    return commit(state, function (s) {
      if (!s.waiting) s.waiting = [];
      var ticket = opts.ticket || ('j' + now.toString(36) + Math.random().toString(36).slice(2, 6));
      if (opts.ticket && !s.waiting.some(function (x) { return x.ticket === opts.ticket; })) {
        throw new Error('Waiting customer not found');
      }
      var techId = opts.techId || null;
      if (techId && !findTech(s, techId)) throw new Error('Tech not found');
      s.waiting.push({
        wid: newId(), ticket: ticket, service: opts.service || '', weight: w,
        note: opts.note || '', createdAt: now, techId: techId,
      });
      addLog(s, {
        t: now, type: 'wait', techIds: techId ? [techId] : [], weight: 0,
        note: opts.note || '', service: opts.service || '', jobId: ticket, assigned: !!techId,
      });
    });
  }

  /*
   * Gán sẵn / đổi / bỏ thợ cho MỘT phần việc của khách đang chờ (techId = null để bỏ).
   * KHÔNG đụng điểm của ai: đây mới chỉ là sắp xếp trước. Thợ được gán vẫn đứng nguyên
   * trong hàng chờ và vẫn nhận walk-in bình thường, khỏi ngồi không đợi khách tới.
   */
  function setWaitingTech(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var item = (s.waiting || []).filter(function (x) { return x.wid === opts.wid; })[0];
      if (!item) throw new Error('Waiting customer not found');
      var techId = opts.techId || null;
      if (techId && !findTech(s, techId)) throw new Error('Tech not found');
      var from = item.techId || null;
      if (from === techId) return; // bấm lại đúng người đang gán → khỏi ghi nhật ký thừa
      item.techId = techId;
      addLog(s, {
        t: now, type: 'preassign', techIds: techId ? [techId] : (from ? [from] : []),
        weight: 0, note: '', service: item.service || '', jobId: item.ticket, cleared: !techId,
      });
    });
  }

  /*
   * Thợ NGỒI VÀO LÀM khách chờ — đây mới là lúc turn được tính.
   * Không truyền techId thì lấy người đã gán sẵn trên phần việc đó.
   * start=true: làm ngay (bận). start=false: giữ khách, làm sau (vẫn ở hàng chờ, turn đã tính).
   */
  function claimWaiting(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var list = s.waiting || [];
      var idx = list.findIndex(function (x) { return x.wid === opts.wid; });
      if (idx < 0) throw new Error('Waiting customer not found');
      var t = findTech(s, opts.techId || list[idx].techId);
      if (!t) throw new Error('Tech not found');
      var item = list.splice(idx, 1)[0];
      var w = Number(item.weight) || 0;
      t.points = round2(t.points + w);
      t.lastServedAt = now;
      if (!t.jobs) t.jobs = [];
      t.jobs.push({
        id: item.ticket, service: item.service || '', weight: w, note: item.note || '',
        startedAt: opts.start ? now : null,
        pending: !opts.start,
        after: [],
      });
      addLog(s, { t: now, type: 'claim', techIds: [t.id], weight: w, note: item.note || '', service: item.service || '', jobId: item.ticket, started: !!opts.start });
    });
  }

  /*
   * Huỷ CẢ khách chờ (mọi phần việc của cùng 1 ticket) trong MỘT bước.
   * Gọi cancelWaiting nhiều lần cũng ra kết quả y hệt, nhưng khi đó Ray phải bấm
   * Hoàn tác đúng bằng số phần việc mới lấy khách lại — xoá nhầm là bực.
   */
  function cancelWaitingTicket(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var list = s.waiting || [];
      var gone = list.filter(function (x) { return x.ticket === opts.ticket; });
      if (!gone.length) throw new Error('Waiting customer not found');
      s.waiting = list.filter(function (x) { return x.ticket !== opts.ticket; });
      addLog(s, {
        t: now, type: 'unwait', techIds: [], weight: 0, note: gone[0].note || '',
        service: gone.map(function (x) { return x.service; }).filter(Boolean).join(' + '),
        jobId: opts.ticket, parts: gone.length,
      });
    });
  }

  // Huỷ MỘT phần việc của khách chờ — chưa ai bị tính điểm nên không phải trả gì.
  function cancelWaiting(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var list = s.waiting || [];
      var idx = list.findIndex(function (x) { return x.wid === opts.wid; });
      if (idx < 0) throw new Error('Waiting customer not found');
      var item = list.splice(idx, 1)[0];
      addLog(s, { t: now, type: 'unwait', techIds: [], weight: 0, note: item.note || '', service: item.service || '', jobId: item.ticket });
    });
  }

  // Bắt đầu phần "làm sau" (thợ đang giữ khách ngồi vào làm) → job chạy, đồng hồ bắt đầu, thợ bận.
  function startJob(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      var job = jobsOf(t).find(function (j) { return j.pending && (!opts.jobId || j.id === opts.jobId); });
      if (!job) throw new Error(t.name + ' has no held customer');
      job.pending = false;
      job.startedAt = now;
      addLog(s, { t: now, type: 'start', techIds: [t.id], weight: 0, note: '', service: job.service, jobId: job.id });
    });
  }

  // Huỷ phần "làm sau" (khách đổi ý) → bỏ job, TRẢ LẠI turn đã tính.
  function cancelPending(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      var idx = jobsOf(t).findIndex(function (j) { return j.pending && (!opts.jobId || j.id === opts.jobId); });
      if (idx < 0) throw new Error(t.name + ' has no held customer');
      var job = t.jobs.splice(idx, 1)[0];
      t.points = Math.max(0, round2(t.points - (job.weight || 0)));
      addLog(s, { t: now, type: 'cancel', techIds: [t.id], weight: -(job.weight || 0), note: '', service: job.service, jobId: job.id });
    });
  }

  /*
   * Chuyển phần "làm sau" sang thợ khác (thợ giữ khách bị kẹt khách walk-in).
   * Turn đi theo phần việc: người cũ TRẢ turn của phần đó, người mới CỘNG (vì turn tính lúc nhận).
   */
  function switchPending(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var from = findTech(s, opts.techId);
      var to = findTech(s, opts.toTechId);
      if (!from || !to) throw new Error('Tech not found');
      if (from.id === to.id) throw new Error('Pick a different tech');
      var idx = jobsOf(from).findIndex(function (j) { return j.pending && (!opts.jobId || j.id === opts.jobId); });
      if (idx < 0) throw new Error(from.name + ' has no held customer');
      var job = from.jobs.splice(idx, 1)[0];
      from.points = Math.max(0, round2(from.points - (job.weight || 0)));
      to.points = round2(to.points + (job.weight || 0));
      to.lastServedAt = now;
      if (!to.jobs) to.jobs = [];
      to.jobs.push(job);
      addLog(s, { t: now, type: 'switch', techIds: [from.id, to.id], weight: job.weight || 0, note: opts.note || '', service: job.service, jobId: job.id });
    });
  }

  // Thợ làm xong khách → bỏ job (mặc định job cũ nhất; truyền jobId để chọn), quay lại hàng chờ.
  function finish(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      var jobs = t.jobs || [];
      var idx = jobs.findIndex(function (j) { return !j.pending && (!opts.jobId || j.id === opts.jobId); });
      if (idx < 0) throw new Error(t.name + ' has no customer in progress');
      var job = jobs.splice(idx, 1)[0];
      var minutes = Math.max(0, Math.round((now - job.startedAt) / 60000));
      addLog(s, { t: now, type: 'finish', techIds: [t.id], weight: 0, note: '', service: job.service, minutes: minutes, jobId: job.id });
    });
  }

  // Bỏ lượt / đang bận. Nếu settings.skipCosts → tính như 1 turn.
  function skip(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      var w = 0;
      if (s.settings.skipCosts) {
        w = 1;
        t.points = round2(t.points + 1);
        t.lastServedAt = now;
      }
      addLog(s, { t: now, type: 'skip', techIds: [t.id], weight: w, note: opts.note || '' });
    });
  }

  function setStatus(state, techId, status, now, type) {
    return commit(state, function (s) {
      var t = findTech(s, techId);
      if (!t) throw new Error('Tech not found');
      t.status = status;
      addLog(s, { t: now, type: type, techIds: [t.id], weight: 0, note: '' });
    });
  }

  function pause(state, opts) {
    return setStatus(state, opts.techId, 'paused', opts.now != null ? opts.now : Date.now(), 'pause');
  }
  function resume(state, opts) {
    return setStatus(state, opts.techId, 'active', opts.now != null ? opts.now : Date.now(), 'resume');
  }
  function leave(state, opts) {
    return setStatus(state, opts.techId, 'left', opts.now != null ? opts.now : Date.now(), 'leave');
  }

  // Sửa điểm tay (± bao nhiêu cũng được, không âm dưới 0).
  function adjust(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    var delta = Number(opts.delta);
    if (!isFinite(delta) || delta === 0) throw new Error('Invalid adjustment');
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      t.points = Math.max(0, round2(t.points + delta));
      addLog(s, { t: now, type: 'adjust', techIds: [t.id], weight: delta, note: opts.note || '' });
    });
  }

  /* ── Lịch làm cố định trong tuần ───────────────────────
   * tech.workDays = mảng thứ (0=CN … 6=T7) mà thợ này đi làm.
   * KHÔNG phải mảng = chưa khai lịch → làm mọi ngày (dữ liệu cũ chạy y như trước).
   * Mảng RỖNG = không làm ngày nào (Ray bỏ tick hết 7 ô).
   */
  function worksOn(tech, dayIndex) {
    if (!tech || !Array.isArray(tech.workDays)) return true;
    return tech.workDays.indexOf(dayIndex) >= 0;
  }
  // Thợ có lịch làm vào thứ này (không quan tâm hôm nay họ đã clock in chưa).
  function scheduledOn(state, dayIndex) {
    return state.techs.filter(function (t) { return worksOn(t, dayIndex); });
  }
  function setWorkDays(state, opts) {
    var raw = Array.isArray(opts.days) ? opts.days.map(Number) : [];
    var days = raw.filter(function (d, i) {
      return d >= 0 && d <= 6 && Math.floor(d) === d && raw.indexOf(d) === i;
    }).sort(function (a, b) { return a - b; });
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      t.workDays = days;
    });
  }

  // Đặt/xoá PIN clock-in của thợ. Hash tính ở tầng UI (app.js) — logic thuần chỉ giữ chuỗi.
  function setPin(state, opts) {
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      t.pinHash = opts.pinHash || null;
    });
  }

  /*
   * Nạp danh sách thợ + lịch tuần + cài đặt từ một bản sao lưu (đám mây hoặc file JSON).
   * CỐ Ý KHÔNG đụng điểm, trạng thái, hay khách đang làm của hôm nay — Ray có thể bấm
   * "Restore" giữa ca đông khách, và mất bảng turn đang chạy thì tai hại hơn nhiều
   * so với việc thiếu một cái tên. Thợ trùng id → cập nhật tên/lịch/PIN. Thợ lạ → thêm dạng 'off'.
   */
  function importRoster(state, payload, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var list = (payload && Array.isArray(payload.techs)) ? payload.techs : [];
    return commit(state, function (s) {
      list.forEach(function (r) {
        if (!r || !r.id || !r.name) return;
        var t = findTech(s, r.id);
        if (!t) {
          t = { id: r.id, name: String(r.name), points: 0, status: 'off', joinedAt: now, lastServedAt: null, jobs: [] };
          s.techs.push(t);
        }
        t.name = String(r.name);
        if (Array.isArray(r.workDays)) {
          var raw = r.workDays.map(Number);
          t.workDays = raw.filter(function (d, i) {
            return d >= 0 && d <= 6 && Math.floor(d) === d && raw.indexOf(d) === i;
          }).sort(function (a, b) { return a - b; });
        }
        if (typeof r.pinHash === 'string' && r.pinHash) t.pinHash = r.pinHash;
      });
      if (payload && payload.settings && typeof payload.settings === 'object') {
        var patch = {};
        if (typeof payload.settings.skipCosts === 'boolean') patch.skipCosts = payload.settings.skipCosts;
        if (typeof payload.settings.lateCatchUp === 'boolean') patch.lateCatchUp = payload.settings.lateCatchUp;
        if (Array.isArray(payload.settings.services) && payload.settings.services.length) {
          patch.services = payload.settings.services.filter(function (x) {
            return x && x.name && Number(x.weight) >= 0;
          }).map(function (x) { return { name: String(x.name), weight: Number(x.weight) }; });
        }
        s.settings = Object.assign({}, s.settings, patch);
      }
    });
  }

  function renameTech(state, opts) {
    var name = String(opts.name || '').trim();
    if (!name) throw new Error('Tech name is empty');
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Tech not found');
      t.name = name;
    });
  }

  // Xoá hẳn khỏi danh sách (khác 'left'/'off').
  function removeTech(state, opts) {
    return commit(state, function (s) {
      s.techs = s.techs.filter(function (t) { return t.id !== opts.techId; });
    });
  }

  function updateSettings(state, patch) {
    return commit(state, function (s) {
      s.settings = Object.assign({}, s.settings, patch);
    });
  }

  /*
   * Ngày mới: điểm về 0, log rỗng, GIỮ danh sách thợ.
   * workingIds: mảng id thợ đi làm hôm nay, THEO THỨ TỰ vào ca; còn lại status 'off'.
   */
  function newDay(state, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var working = opts.workingIds || state.techs.map(function (t) { return t.id; });
    var next = clone(state);
    next.date = opts.date || todayStr(now);
    next.log = [];
    next.history = [];
    next.waiting = [];
    next.techs.forEach(function (t) {
      t.points = 0;
      t.lastServedAt = null;
      t.jobs = [];
      var idx = working.indexOf(t.id);
      if (idx >= 0) {
        t.status = 'active';
        t.joinedAt = now + idx; // giữ thứ tự vào ca
      } else {
        t.status = 'off';
        t.joinedAt = now;
      }
    });
    working.forEach(function (id) {
      var t = findTech(next, id);
      if (t) addLog(next, { t: t.joinedAt, type: 'join', techIds: [id], weight: 0, note: '' });
    });
    return next;
  }

  function isNewDay(state, now) {
    return state.date !== todayStr(now != null ? now : Date.now());
  }

  /*
   * Số khách của 1 thợ trong ngày. Không đếm mộc theo log 'assign' được, vì:
   *   - huỷ phần đang giữ (cancel) → khách đó không còn của ai, phải trừ ra;
   *   - chuyển phần việc (switch) → đầu khách đi theo công việc sang người mới.
   * Turn đã đi theo đúng luật này trong cancelPending/switchPending; đây là cho khớp phần đếm.
   */
  function customersOf(state, techId) {
    var n = 0;
    (state.log || []).forEach(function (e) {
      if (!e || !Array.isArray(e.techIds)) return;
      if (e.type === 'switch') {
        if (e.techIds[0] === techId) n -= 1;
        if (e.techIds[1] === techId) n += 1;
        return;
      }
      if (e.techIds.indexOf(techId) < 0) return;
      if (e.type === 'assign' || e.type === 'claim') n += 1;
      else if (e.type === 'cancel') n -= 1;
    });
    return Math.max(0, n);
  }

  // Tổng kết hôm nay: mỗi thợ bao nhiêu khách / bao nhiêu turn / bao nhiêu lần skip.
  function summary(state) {
    return state.techs
      .filter(function (t) { return t.status !== 'off'; })
      .map(function (t) {
        var skips = 0, minutes = 0;
        state.log.forEach(function (e) {
          if (e.techIds.indexOf(t.id) < 0) return;
          if (e.type === 'skip') skips += 1;
          if (e.type === 'finish') minutes += e.minutes || 0;
        });
        return { id: t.id, name: t.name, points: t.points, customers: customersOf(state, t.id), skips: skips, minutes: minutes, busy: isBusy(t), status: t.status };
      })
      .sort(function (a, b) { return b.points - a.points; });
  }

  /* ── Lịch sử nhiều ngày ────────────────────────────────
   * Bản ghi 1 ngày, cất lại TRƯỚC khi reset sang ngày mới. Cố tình để rất gọn
   * (không giữ nhật ký thô) vì kho lịch sử phải sống lâu trong localStorage.
   */
  function dayRecord(state) {
    return {
      date: state.date,
      techs: summary(state).map(function (r) {
        return { id: r.id, name: r.name, points: r.points, customers: r.customers, skips: r.skips, minutes: r.minutes };
      }),
    };
  }
  // Ngày đó có gì đáng lưu không — ngày tiệm đóng cửa thì khỏi cất bản ghi rỗng.
  function isEmptyRecord(rec) {
    if (!rec || !Array.isArray(rec.techs) || !rec.techs.length) return true;
    return !rec.techs.some(function (r) { return r.points || r.customers || r.minutes || r.skips; });
  }

  /*
   * Bảng tuần: hàng = thợ, cột = Thứ 2 … Chủ nhật.
   * records = { 'YYYY-MM-DD': dayRecord }. Ô không có dữ liệu = null (khác với 0 turn:
   * null nghĩa là hôm đó thợ không đi làm, 0 nghĩa là có đi mà chưa có khách nào).
   */
  function weekTable(records, monday) {
    var days = weekDays(monday);
    var order = [], byId = {};
    days.forEach(function (date, col) {
      var rec = records && records[date];
      if (!rec || !Array.isArray(rec.techs)) return;
      rec.techs.forEach(function (r) {
        if (!byId[r.id]) {
          byId[r.id] = { id: r.id, name: r.name, cells: days.map(function () { return null; }), points: 0, customers: 0, minutes: 0, days: 0 };
          order.push(r.id);
        }
        var row = byId[r.id];
        row.name = r.name; // tên mới nhất trong tuần thắng, phòng khi Ray đổi tên giữa tuần
        row.cells[col] = { points: r.points, customers: r.customers, minutes: r.minutes || 0 };
        row.points = round2(row.points + r.points);
        row.customers += r.customers;
        row.minutes += r.minutes || 0;
        row.days += 1;
      });
    });
    var rows = order.map(function (id) { return byId[id]; }).sort(function (a, b) {
      return b.points - a.points || String(a.name).localeCompare(String(b.name));
    });
    var dayTotals = days.map(function (date, col) {
      return round2(rows.reduce(function (sum, r) { return sum + (r.cells[col] ? r.cells[col].points : 0); }, 0));
    });
    return {
      monday: monday, days: days, rows: rows, dayTotals: dayTotals,
      total: round2(rows.reduce(function (s, r) { return s + r.points; }, 0)),
      customers: rows.reduce(function (s, r) { return s + r.customers; }, 0),
    };
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  var TurnLogic = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_SERVICES: DEFAULT_SERVICES,
    createState: createState,
    todayStr: todayStr,
    isNewDay: isNewDay,
    dayIndexOf: dayIndexOf,
    addDays: addDays,
    weekStart: weekStart,
    weekDays: weekDays,
    worksOn: worksOn,
    scheduledOn: scheduledOn,
    setWorkDays: setWorkDays,
    customersOf: customersOf,
    dayRecord: dayRecord,
    isEmptyRecord: isEmptyRecord,
    weekTable: weekTable,
    compareTechs: compareTechs,
    queue: queue,
    nextTech: nextTech,
    activeTechs: activeTechs,
    working: working,
    isBusy: isBusy,
    jobsOf: jobsOf,
    activeJobs: activeJobs,
    pendingJobs: pendingJobs,
    pendingForTicket: pendingForTicket,
    findTech: findTech,
    addTech: addTech,
    rejoin: rejoin,
    finish: finish,
    startJob: startJob,
    switchPending: switchPending,
    cancelPending: cancelPending,
    assign: assign,
    waitingList: waitingList,
    waitingGroups: waitingGroups,
    addWaiting: addWaiting,
    setWaitingTech: setWaitingTech,
    claimWaiting: claimWaiting,
    cancelWaiting: cancelWaiting,
    cancelWaitingTicket: cancelWaitingTicket,
    skip: skip,
    pause: pause,
    resume: resume,
    leave: leave,
    adjust: adjust,
    setPin: setPin,
    importRoster: importRoster,
    renameTech: renameTech,
    removeTech: removeTech,
    updateSettings: updateSettings,
    newDay: newDay,
    undo: undo,
    canUndo: canUndo,
    summary: summary,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TurnLogic;
  else root.TurnLogic = TurnLogic;
})(typeof window !== 'undefined' ? window : this);
