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
  // Môi trường studio tự dựng: nền gradient mềm + 2 softbox lớn → phản chiếu thành vệt sáng dài, mượt
  // (RoomEnvironment có nhiều đèn nhỏ nên kính bị lấm chấm).
  function studioEnv() {
    var scene = new THREE.Scene();
    var geo = new THREE.SphereGeometry(10, 32, 16);
    var col = new Float32Array(geo.attributes.position.count * 3);
    // Nền env tối vừa (không trắng) để vật bóng phản chiếu ra tối + vệt softbox sáng → nhìn "bóng" thật
    var top = new THREE.Color(0x2b2226), bottom = new THREE.Color(0x070405), tmp = new THREE.Color();
    for (var i = 0; i < geo.attributes.position.count; i++) {
      var y = geo.attributes.position.getY(i) / 10; // -1..1
      tmp.copy(bottom).lerp(top, (y + 1) / 2);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    function box(w, h, x, y, z, ry, intensity) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(intensity) }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); m.rotation.y += ry;
      scene.add(m);
    }
    box(3.5, 8, -5, 2, 4, 0, 3);    // softbox trái-trước: vệt sáng dọc lớn
    box(1.6, 8, 5.5, 3, 2, 0, 2); // softbox phải: vệt mảnh
    box(6, 1.5, 0, 7, -3, 0, 1.5);  // đèn trần: đỉnh nắp sáng
    box(0.7, 7, -3.5, 1.5, 6, 0, 14); // vệt sáng hẹp-rất sáng: highlight dọc sắc trên kính/sơn
    return scene;
  }

  function buildBottle(polishHex) {
    var g = new THREE.Group();

    // Thân chai kiểu OPI: đáy phẳng, thành hơi phình, vai tròn mềm, cổ ngắn
    var glassGeo = lathe([
      [0, -1.0], [0.5, -1.0], [0.6, -0.96], [0.66, -0.85], [0.68, -0.4], [0.68, 0.05],
      [0.64, 0.3], [0.52, 0.48], [0.36, 0.56], [0.3, 0.6], [0.3, 0.7], [0.27, 0.7], [0.27, 0.62], [0, 0.62]
    ], 96);
    var glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.04, transmission: 1, thickness: 0.22, ior: 1.5,
      clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 0.8, side: THREE.DoubleSide,
      specularIntensity: 1.2,
    });
    var glass = new THREE.Mesh(glassGeo, glassMat); glass.name = 'glass';
    glass.renderOrder = 2;
    g.add(glass);

    // Sơn bên trong (đầy ~80%), mặt trên hơi lõm nhẹ
    var polishGeo = lathe([
      [0, -0.95], [0.46, -0.95], [0.56, -0.9], [0.62, -0.8], [0.63, -0.4], [0.63, 0.02],
      [0.6, 0.18], [0.5, 0.26], [0.25, 0.28], [0, 0.27]
    ], 96);
    var polishMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(polishHex), metalness: 0.0, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06,
      envMapIntensity: 0.45, specularIntensity: 1.0,
    });
    var polish = new THREE.Mesh(polishGeo, polishMat);
    polish.renderOrder = 1;
    g.add(polish);

    // Cổ vàng mảnh (collar)
    var goldMat = new THREE.MeshStandardMaterial({ color: 0xd9b57c, metalness: 1, roughness: 0.22, envMapIntensity: 1.2 });
    var ring = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.31, 0.12, 64), goldMat);
    ring.position.y = 0.75;
    g.add(ring);

    // Nắp đen bóng: thon cao, hơi loe ở chân, đỉnh bo tròn
    var capMat = new THREE.MeshPhysicalMaterial({
      color: 0x120c0f, metalness: 0.0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.6,
    });
    var capGeo = lathe([
      [0, 0], [0.31, 0], [0.33, 0.06], [0.3, 0.5], [0.28, 1.05], [0.26, 1.18], [0.18, 1.26], [0.08, 1.29], [0, 1.3]
    ], 64);
    var cap = new THREE.Mesh(capGeo, capMat); cap.name = 'cap';
    cap.position.y = 0.8;
    g.add(cap);

    // Bóng đổ mềm dưới đáy
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var ctx = c.getContext('2d');
    var grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,.45)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128);
    var shadowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.5 });
    var shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -1.02;
    g.add(shadow);

    state.polishMat = polishMat;
    state.shadowMat = shadowMat;
    // Chai cao từ -1.0 tới 2.1 → dời xuống để tâm khung ≈ giữa chai
    g.position.y = -0.55;
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
      var camera = new THREE.PerspectiveCamera(26, w / h, 0.1, 30);
      camera.position.set(0, 0.55, 8.4);
      camera.lookAt(0, 0.02, 0);

      var pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(studioEnv(), 0.02).texture;
      pmrem.dispose();
      var key = new THREE.DirectionalLight(0xfff4ec, 2.6); key.position.set(-3, 5, 4); scene.add(key);
      var fill = new THREE.DirectionalLight(0xffe3e8, 0.6); fill.position.set(4, 1.5, 3); scene.add(fill);
      var rim = new THREE.DirectionalLight(0xffffff, 1.4); rim.position.set(1.5, 3, -4); scene.add(rim);
      scene.add(new THREE.AmbientLight(0xffffff, 0.12));

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
          var dx = (ev.clientX - cx) / 220, dy = (ev.clientY - cy) / 160;
          // Chỉ "để ý" khi chuột ở gần chai; xa quá 420px thì đứng thẳng lại
          var dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
          var wgt = Math.max(0, Math.min(1, 1 - (dist - 100) / 320));
          state.pointerTarget.x = Math.max(-1, Math.min(1, dx)) * wgt;
          state.pointerTarget.y = Math.max(-1, Math.min(1, dy)) * wgt;
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
    b.position.y = -0.55 + Math.sin(s * 1.3) * 0.025;
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

  root.Hero3D = { _state: state, mount: mount, setColor: setColor, wiggle: wiggle, setTheme: setTheme, isReady: function () { return state.ready; }, mode: function () { return state.mode; } };
})(window);
