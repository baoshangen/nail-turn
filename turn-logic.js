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

  // Thêm khách chờ độc lập (walk-in vô ngồi đợi, chưa thợ nào rảnh).
  function addWaiting(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    var w = Number(opts.weight);
    if (!(w >= 0)) throw new Error('Invalid turn amount');
    return commit(state, function (s) {
      if (!s.waiting) s.waiting = [];
      var ticket = 'j' + now.toString(36) + Math.random().toString(36).slice(2, 6);
      s.waiting.push({ wid: newId(), ticket: ticket, service: opts.service || '', weight: w, note: opts.note || '', createdAt: now });
      addLog(s, { t: now, type: 'wait', techIds: [], weight: 0, note: opts.note || '', service: opts.service || '', jobId: ticket });
    });
  }

  /*
   * Thợ nhận khách chờ. ĐIỂM TÍNH LÚC NHẬN (không phải lúc tạo pending) →
   * không phá luật công bằng khi có hẹn/walk-in chen vào giữa.
   * start=true: ngồi làm ngay (bận). start=false: giữ khách, làm sau (vẫn ở hàng chờ).
   */
  function claimWaiting(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var list = s.waiting || [];
      var idx = list.findIndex(function (x) { return x.wid === opts.wid; });
      if (idx < 0) throw new Error('Waiting customer not found');
      var t = findTech(s, opts.techId);
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

  // Huỷ khách chờ (khách đổi ý/về) — chưa ai bị tính điểm nên không phải trả gì.
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

  // Tổng kết hôm nay: mỗi thợ bao nhiêu khách / bao nhiêu turn / bao nhiêu lần skip.
  function summary(state) {
    return state.techs
      .filter(function (t) { return t.status !== 'off'; })
      .map(function (t) {
        var customers = 0, skips = 0, minutes = 0;
        state.log.forEach(function (e) {
          if (e.techIds.indexOf(t.id) < 0) return;
          if (e.type === 'assign' || e.type === 'claim') customers += 1;
          if (e.type === 'skip') skips += 1;
          if (e.type === 'finish') minutes += e.minutes || 0;
        });
        return { id: t.id, name: t.name, points: t.points, customers: customers, skips: skips, minutes: minutes, busy: isBusy(t), status: t.status };
      })
      .sort(function (a, b) { return b.points - a.points; });
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
    addWaiting: addWaiting,
    claimWaiting: claimWaiting,
    cancelWaiting: cancelWaiting,
    skip: skip,
    pause: pause,
    resume: resume,
    leave: leave,
    adjust: adjust,
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
