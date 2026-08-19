/*
 * hero3d.js — chai sơn móng 3D ở header (chữ ký hình ảnh của app).
 * Dùng three.js r147 (bản UMD cuối còn examples/js) — vendor/three.min.js + vendor/RoomEnvironment.js.
 * Sơn trong chai = màu của thợ đang NEXT; giao khách → chai lắc 1 nhịp.
 * API: Hero3D.mount(el) · setColor(hex) · wiggle() · setTheme('light'|'dark') · isReady()
 * Nếu WebGL lỗi → tự chèn SVG chai tĩnh (fallback) và các API vẫn gọi được.
 */
(function (root) {
  'use strict';

  var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var state = {
    ready: false, mode: 'none', el: null,
    renderer: null, scene: null, camera: null, bottle: null, polishMat: null, shadowMat: null,
    targetColor: null, fromColor: null, colorT: 1, colorStart: 0,
    wiggleStart: -1, pointer: { x: 0, y: 0 }, pointerTarget: { x: 0, y: 0 },
    raf: 0, theme: 'light', lastT: 0,
  };

  // ── Fallback SVG ──────────────────────────────────────
  function svgBottle(hex) {
    return '<svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden="true">' +
      '<defs><linearGradient id="hg" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".08"/></linearGradient></defs>' +
      '<ellipse cx="60" cy="108" rx="26" ry="5" fill="rgba(0,0,0,.12)"/>' +
      '<rect x="46" y="14" width="28" height="30" rx="5" fill="#241a1f"/>' +
      '<rect x="49" y="42" width="22" height="7" rx="2" fill="#c9a46a"/>' +
      '<path d="M40 60 q0-12 12-12 h16 q12 0 12 12 v34 q0 8-8 8 h-24 q-8 0-8-8z" fill="' + hex + '"/>' +
      '<path d="M40 60 q0-12 12-12 h16 q12 0 12 12 v34 q0 8-8 8 h-24 q-8 0-8-8z" fill="url(#hg)"/>' +
      '</svg>';
  }
  function fallback(el, hex) {
    state.mode = 'svg';
    el.innerHTML = svgBottle(hex || '#B8707C');
    el.classList.add('hero3d-fallback');
  }

  // ── Dựng chai ─────────────────────────────────────────
  function lathe(points, segments) {
    var pts = points.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    return new THREE.LatheGeometry(pts, segments || 64);
  }
  function buildBottle(polishHex) {
    var g = new THREE.Group();

    // Thân thuỷ tinh
    var glassGeo = lathe([[0, -1.0], [0.46, -1.0], [0.58, -0.92], [0.62, -0.6], [0.62, 0.15], [0.56, 0.4], [0.36, 0.55], [0.3, 0.6], [0.3, 0.72], [0, 0.72]]);
    // Kính mỏng (thickness nhỏ) để sơn bên trong không bị "trắng hoá"; envMap vừa phải cho ánh phản chiếu.
    var glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.03, transmission: 1, thickness: 0.18, ior: 1.45,
      clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.9, side: THREE.DoubleSide,
    });
    var glass = new THREE.Mesh(glassGeo, glassMat);
    glass.renderOrder = 2;
    g.add(glass);

    // Sơn bên trong (đầy ~78%)
    var polishGeo = lathe([[0, -0.94], [0.42, -0.94], [0.53, -0.87], [0.56, -0.6], [0.56, 0.05], [0.5, 0.2], [0, 0.2]]);
    var polishMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(polishHex), metalness: 0.0, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08,
      envMapIntensity: 0.55,
    });
    var polish = new THREE.Mesh(polishGeo, polishMat);
    polish.renderOrder = 1;
    g.add(polish);

    // Vòng cổ chai vàng
    var ring = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.14, 48),
      new THREE.MeshStandardMaterial({ color: 0xd4af7a, metalness: 1, roughness: 0.28, envMapIntensity: 1.4 })
    );
    ring.position.y = 0.78;
    g.add(ring);

    // Nắp đen bóng (hơi thon lên trên) + chóp bo
    var capMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1418, metalness: 0.15, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.34, 0.86, 48), capMat);
    cap.position.y = 0.85 + 0.43;
    g.add(cap);
    var dome = new THREE.Mesh(new THREE.SphereGeometry(0.31, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
    dome.scale.y = 0.35;
    dome.position.y = 0.85 + 0.86;
    g.add(dome);

    // Bóng đổ mềm dưới đáy (sprite radial)
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var ctx = c.getContext('2d');
    var grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,.42)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128);
    var shadowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.55 });
    var shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -1.02;
    g.add(shadow);

    state.polishMat = polishMat;
    state.shadowMat = shadowMat;
    // Dịch nhóm để chai nằm giữa khung
    g.position.y = -0.25;
    return g;
  }

  // ── Mount ─────────────────────────────────────────────
  function mount(el, opts) {
    opts = opts || {};
    state.el = el;
    var hex = opts.color || '#B8707C';
    if (!root.THREE || !root.THREE.WebGLRenderer) { fallback(el, hex); return; }
    try {
      var w = el.clientWidth || 132, h = el.clientHeight || 132;
      var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
      renderer.setSize(w, h);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.physicallyCorrectLights = true;
      el.appendChild(renderer.domElement);

      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 20);
      camera.position.set(0, 0.35, 5.6);
      camera.lookAt(0, -0.05, 0);

      if (THREE.RoomEnvironment) {
        var pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
      }
      var key = new THREE.DirectionalLight(0xfff1e6, 2.2); key.position.set(2.5, 4, 3); scene.add(key);
      var rim = new THREE.DirectionalLight(0xffd6de, 1.2); rim.position.set(-3, 2, -2); scene.add(rim);
      scene.add(new THREE.AmbientLight(0xffffff, 0.35));

      var bottle = buildBottle(hex);
      scene.add(bottle);

      state.renderer = renderer; state.scene = scene; state.camera = camera; state.bottle = bottle;
      state.targetColor = new THREE.Color(hex); state.fromColor = new THREE.Color(hex);
      state.ready = true; state.mode = 'webgl';
      el.classList.add('hero3d-ready');

      // Chuột lại gần → chai nghiêng theo (nghe trên vùng header cha cho rộng)
      var zone = opts.pointerZone || el.parentElement || el;
      var fine = root.matchMedia && root.matchMedia('(pointer: fine)').matches;
      if (fine && !reduced) {
        zone.addEventListener('pointermove', function (ev) {
          var r = el.getBoundingClientRect();
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var dx = (ev.clientX - cx) / 260, dy = (ev.clientY - cy) / 200;
          state.pointerTarget.x = Math.max(-1, Math.min(1, dx));
          state.pointerTarget.y = Math.max(-1, Math.min(1, dy));
        });
        zone.addEventListener('pointerleave', function () { state.pointerTarget.x = 0; state.pointerTarget.y = 0; });
      }

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') loop(); else stop();
      });
      root.addEventListener('resize', function () {
        var w2 = el.clientWidth || 132, h2 = el.clientHeight || 132;
        renderer.setSize(w2, h2); camera.aspect = w2 / h2; camera.updateProjectionMatrix();
      });

      if (reduced) { renderer.render(scene, camera); }
      else loop();
    } catch (e) {
      console.warn('Hero3D: WebGL không khả dụng, dùng SVG.', e);
      el.innerHTML = '';
      fallback(el, hex);
    }
  }

  function stop() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; }
  function loop() {
    stop();
    function frame(t) {
      state.raf = requestAnimationFrame(frame);
      tick(t);
      state.renderer.render(state.scene, state.camera);
    }
    state.raf = requestAnimationFrame(frame);
  }

  function tick(t) {
    var b = state.bottle;
    var s = t / 1000;
    // Xoay chậm + nhấp nhô rất nhẹ
    b.rotation.y = s * 0.45;
    b.position.y = -0.25 + Math.sin(s * 1.3) * 0.025;
    // Nghiêng theo chuột (lerp)
    state.pointer.x += (state.pointerTarget.x - state.pointer.x) * 0.08;
    state.pointer.y += (state.pointerTarget.y - state.pointer.y) * 0.08;
    var tiltX = state.pointer.y * 0.28, tiltZ = -state.pointer.x * 0.28;
    // Lắc khi giao khách: dao động tắt dần trong ~900ms
    if (state.wiggleStart >= 0) {
      var e = (t - state.wiggleStart) / 900;
      if (e >= 1) state.wiggleStart = -1;
      else tiltZ += Math.sin(e * Math.PI * 5) * (1 - e) * 0.35;
    }
    b.rotation.x = tiltX; b.rotation.z = tiltZ;
    // Đổi màu sơn mượt
    if (state.colorT < 1) {
      state.colorT = Math.min(1, (t - state.colorStart) / 450);
      var k = state.colorT * state.colorT * (3 - 2 * state.colorT);
      state.polishMat.color.copy(state.fromColor).lerp(state.targetColor, k);
    }
  }

  // ── API ───────────────────────────────────────────────
  function setColor(hex) {
    if (!hex) return;
    if (state.mode === 'svg') { state.el.innerHTML = svgBottle(hex); return; }
    if (!state.ready) return;
    var next = new THREE.Color(hex);
    if (next.equals(state.targetColor)) return;
    state.fromColor.copy(state.polishMat.color);
    state.targetColor.copy(next);
    state.colorT = 0; state.colorStart = performance.now();
    if (reduced) { state.polishMat.color.copy(next); state.colorT = 1; state.renderer.render(state.scene, state.camera); }
  }
  function wiggle() {
    if (!state.ready || reduced) return;
    state.wiggleStart = performance.now();
  }
  function setTheme(theme) {
    state.theme = theme;
    if (!state.ready) return;
    var dark = theme === 'dark';
    state.shadowMat.opacity = dark ? 0.75 : 0.55;
    state.renderer.toneMappingExposure = dark ? 1.15 : 1.05;
    if (reduced) state.renderer.render(state.scene, state.camera);
  }

  root.Hero3D = { mount: mount, setColor: setColor, wiggle: wiggle, setTheme: setTheme, isReady: function () { return state.ready; }, mode: function () { return state.mode; } };
})(window);
