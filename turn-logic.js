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

  var DEFAULT_SETTINGS = {
    skipCosts: false,   // Skip = mất lượt (+1 turn)?
    lateCatchUp: true,  // Thợ vào trễ khởi đầu = điểm thấp nhất hiện tại?
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

  function activeTechs(state) {
    return state.techs.filter(function (t) { return t.status === 'active'; });
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

  function queue(state) {
    return activeTechs(state).slice().sort(compareTechs);
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
    if (!name) throw new Error('Tên thợ trống');
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
      if (!t) throw new Error('Không thấy thợ');
      var pts = 0;
      if (s.settings.lateCatchUp && activeTechs(s).length > 0) pts = minActivePoints(s);
      t.status = 'active';
      t.points = pts;
      t.joinedAt = now;
      t.lastServedAt = null;
      addLog(s, { t: now, type: 'join', techIds: [t.id], weight: pts, note: '' });
    });
  }

  // Giao khách. techIds: 1 hay nhiều thợ. weight: số (áp cho tất cả) hoặc {id: số}.
  function assign(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    var ids = opts.techIds || (opts.techId ? [opts.techId] : []);
    if (!ids.length) throw new Error('Chưa chọn thợ');
    return commit(state, function (s) {
      var perTech = {};
      ids.forEach(function (id) {
        var t = findTech(s, id);
        if (!t) throw new Error('Không thấy thợ ' + id);
        var w;
        if (typeof opts.weight === 'number') w = opts.weight;
        else if (opts.weight && typeof opts.weight === 'object') w = Number(opts.weight[id]);
        else w = 1;
        if (!(w >= 0)) throw new Error('Trọng số không hợp lệ');
        t.points = round2(t.points + w);
        t.lastServedAt = now;
        perTech[id] = w;
      });
      addLog(s, { t: now, type: 'assign', techIds: ids.slice(), weight: perTech, note: opts.note || '' });
    });
  }

  // Bỏ lượt / đang bận. Nếu settings.skipCosts → tính như 1 turn.
  function skip(state, opts) {
    var now = opts.now != null ? opts.now : Date.now();
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Không thấy thợ');
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
      if (!t) throw new Error('Không thấy thợ');
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
    if (!isFinite(delta) || delta === 0) throw new Error('Số điều chỉnh không hợp lệ');
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Không thấy thợ');
      t.points = Math.max(0, round2(t.points + delta));
      addLog(s, { t: now, type: 'adjust', techIds: [t.id], weight: delta, note: opts.note || '' });
    });
  }

  function renameTech(state, opts) {
    var name = String(opts.name || '').trim();
    if (!name) throw new Error('Tên thợ trống');
    return commit(state, function (s) {
      var t = findTech(s, opts.techId);
      if (!t) throw new Error('Không thấy thợ');
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
    next.techs.forEach(function (t) {
      t.points = 0;
      t.lastServedAt = null;
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
        var customers = 0, skips = 0;
        state.log.forEach(function (e) {
          if (e.techIds.indexOf(t.id) < 0) return;
          if (e.type === 'assign') customers += 1;
          if (e.type === 'skip') skips += 1;
        });
        return { id: t.id, name: t.name, points: t.points, customers: customers, skips: skips, status: t.status };
      })
      .sort(function (a, b) { return b.points - a.points; });
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  var TurnLogic = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    createState: createState,
    todayStr: todayStr,
    isNewDay: isNewDay,
    compareTechs: compareTechs,
    queue: queue,
    nextTech: nextTech,
    activeTechs: activeTechs,
    findTech: findTech,
    addTech: addTech,
    rejoin: rejoin,
    assign: assign,
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
