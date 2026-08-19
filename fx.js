/*
 * fx.js — hiệu ứng thuần DOM/canvas, không phụ thuộc three.js.
 *   FX.snapshot(container) → trước khi vẽ lại: lưu vị trí từng thẻ [data-id]
 *   FX.play(container)     → sau khi vẽ lại: thẻ trượt từ chỗ cũ sang chỗ mới (FLIP), thẻ mới fade-in
 *   FX.burst(el)           → glitter rose-gold nổ ra từ tâm phần tử
 *   FX.tilt(container)     → thẻ nghiêng theo chuột (1 listener uỷ quyền)
 *   FX.theme               → init()/toggle()/get(): sáng/tối, lưu localStorage, theo hệ thống lần đầu
 * Tôn trọng prefers-reduced-motion: FLIP/tilt/burst tự tắt.
 */
(function (root) {
  'use strict';
  var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = root.matchMedia && root.matchMedia('(pointer: fine)').matches;

  // ── FLIP ──────────────────────────────────────────────
  var last = new Map();
  function snapshot(container) {
    last = new Map();
    if (reduced) return;
    Array.prototype.forEach.call(container.querySelectorAll('[data-id]'), function (el) {
      last.set(el.dataset.id, el.getBoundingClientRect());
    });
  }
  function play(container) {
    if (reduced) return;
    var els = Array.prototype.slice.call(container.querySelectorAll('[data-id]'));
    var moves = [];
    els.forEach(function (el, i) {
      var prev = last.get(el.dataset.id);
      var now = el.getBoundingClientRect();
      if (!prev) {
        // thẻ mới xuất hiện
        el.style.transition = 'none';
        el.style.opacity = '0';
        el.style.transform = 'translateY(14px) scale(.97)';
        moves.push({ el: el, delay: Math.min(i, 8) * 40, enter: true });
        return;
      }
      var dx = prev.left - now.left, dy = prev.top - now.top;
      var sw = prev.width / (now.width || 1), sh = prev.height / (now.height || 1);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sw - 1) < .01 && Math.abs(sh - 1) < .01) return;
      el.style.transition = 'none';
      el.style.transformOrigin = 'top left';
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sw + ',' + sh + ')';
      moves.push({ el: el, delay: 0, enter: false });
    });
    if (!moves.length) return;
    // ép reflow rồi thả về vị trí thật
    void container.offsetHeight;
    moves.forEach(function (m) {
      m.el.style.transition = 'transform 460ms cubic-bezier(.2,.8,.2,1) ' + m.delay + 'ms, opacity 360ms ease ' + m.delay + 'ms';
      m.el.style.transform = '';
      m.el.style.opacity = '';
      m.el.addEventListener('transitionend', function h() {
        m.el.style.transition = ''; m.el.style.transformOrigin = '';
        m.el.removeEventListener('transitionend', h);
      });
    });
  }

  // ── Glitter burst ─────────────────────────────────────
  var canvas, ctx, parts = [], rafBurst = 0;
  var PALETTE = ['#B8707C', '#D68C98', '#C9A46A', '#E0C08A', '#FFFFFF', '#F5D8DC'];
  function ensureCanvas() {
    if (canvas) return;
    canvas = document.getElementById('fx-canvas') || document.createElement('canvas');
    if (!canvas.parentNode) { canvas.id = 'fx-canvas'; document.body.appendChild(canvas); }
    ctx = canvas.getContext('2d');
    resize();
    root.addEventListener('resize', resize);
  }
  function resize() {
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    canvas.width = root.innerWidth * dpr; canvas.height = root.innerHeight * dpr;
    canvas.style.width = root.innerWidth + 'px'; canvas.style.height = root.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function burst(el, opts) {
    if (reduced || !el) return;
    ensureCanvas();
    opts = opts || {};
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height * 0.42;
    var n = opts.count || 80;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 6.5;
      parts.push({
        x: cx + (Math.random() - .5) * r.width * .4, y: cy + (Math.random() - .5) * 20,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4.5,
        life: 1, decay: 0.012 + Math.random() * 0.012,
        size: 2 + Math.random() * 3.5, rot: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
        color: PALETTE[(Math.random() * PALETTE.length) | 0], shape: Math.random() < .35 ? 'spark' : 'flake',
      });
    }
    if (!rafBurst) rafBurst = requestAnimationFrame(step);
  }
  var lastStep = 0;
  function step(t) {
    // Chuẩn theo thời gian (dt tính bằng "frame 60fps") để máy chậm/nhanh đều tắt sau ~1.2s
    var dt = lastStep ? Math.min(3, (t - lastStep) / 16.67) : 1;
    lastStep = t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.vy += 0.22 * dt; p.vx *= Math.pow(0.985, dt); p.vy *= Math.pow(0.985, dt);
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= p.decay * dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'spark') {
        ctx.beginPath();
        for (var k = 0; k < 4; k++) {
          var ang = k * Math.PI / 2, s1 = p.size * 1.6, s2 = p.size * .35;
          ctx.lineTo(Math.cos(ang) * s1, Math.sin(ang) * s1);
          ctx.lineTo(Math.cos(ang + Math.PI / 4) * s2, Math.sin(ang + Math.PI / 4) * s2);
        }
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    }
    if (parts.length) rafBurst = requestAnimationFrame(step);
    else { rafBurst = 0; lastStep = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }

  // ── Tilt theo chuột ───────────────────────────────────
  function tilt(container, selector) {
    if (reduced || !finePointer) return;
    selector = selector || '.card';
    var MAX = 5;
    container.addEventListener('pointermove', function (ev) {
      var card = ev.target.closest(selector);
      if (!card || !container.contains(card)) return;
      var r = card.getBoundingClientRect();
      var px = (ev.clientX - r.left) / r.width, py = (ev.clientY - r.top) / r.height;
      var rx = (0.5 - py) * MAX * 2, ry = (px - 0.5) * MAX * 2;
      card.style.setProperty('--tx', rx.toFixed(2) + 'deg');
      card.style.setProperty('--ty', ry.toFixed(2) + 'deg');
      card.style.setProperty('--gx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
      card.classList.add('tilting');
    });
    container.addEventListener('pointerout', function (ev) {
      var card = ev.target.closest(selector);
      if (!card) return;
      if (ev.relatedTarget && card.contains(ev.relatedTarget)) return;
      card.classList.remove('tilting');
      card.style.setProperty('--tx', '0deg'); card.style.setProperty('--ty', '0deg');
    });
  }

  // ── Theme ─────────────────────────────────────────────
  var THEME_KEY = 'nail-turn-theme';
  var theme = {
    get: function () { return document.documentElement.getAttribute('data-theme') || 'light'; },
    apply: function (t) {
      document.documentElement.setAttribute('data-theme', t);
      var meta = document.querySelector('meta[name=color-scheme]');
      if (meta) meta.setAttribute('content', t);
      document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
    },
    init: function () {
      var saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
      var t = saved || (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      theme.apply(t);
      return t;
    },
    toggle: function () {
      var t = theme.get() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
      theme.apply(t);
      return t;
    },
  };

  root.FX = { snapshot: snapshot, play: play, burst: burst, tilt: tilt, theme: theme, reduced: reduced };
})(window);
