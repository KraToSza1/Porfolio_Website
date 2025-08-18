// js/ship3d.js
// Globals: window.initShip3D, window.updateShip3D, window.destroyShip3D
// Style: "Icon Fighter" — matches the vector icon (teal tip/canopy, red wings,
// grey hull + side arms, little pods). WebGL1-safe, three r0.157+.

(function () {
  "use strict";

  // ---- tiny helpers ---------------------------------------------------------
  function glowSpriteMat(hex = 0x5ef2ff, w = 96, h = 16) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, "rgba(94,242,255,0)");
    grd.addColorStop(0.5, "rgba(94,242,255,1)");
    grd.addColorStop(1, "rgba(94,242,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.LinearFilter;
    return new THREE.SpriteMaterial({
      map: tex, color: hex, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
  }

  class Ship3D {
    constructor(canvasOrId) {
      const el = typeof canvasOrId === "string" ? document.getElementById(canvasOrId) : canvasOrId;
      if (!el) throw new Error("Ship3D: canvas not found");

      this.hostCanvas = el;
      this.canvas = el;
      this.enabled = false;

      // state
      this.w = 0; this.h = 0;
      this._raf = null;
      this._time = 0;
      this._lastTs = performance.now();
      this._prev = { x: null, y: null };
      this._lastHeading = null;
      this._turnVel = 0;
      this._bank = 0;
      this._spawnTimer = 0;
      this.engineOn = true;
      this._engineManual = undefined;

      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce || !window.THREE) return;

      // ---- renderer (robust if canvas already has a 2D ctx) -----------------
      const makeRendererOn = (canvas) => new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: true, premultipliedAlpha: false
      });
      let renderer = null;
      try { renderer = makeRendererOn(this.canvas); renderer.getContext(); } catch { renderer = null; }
      if (!renderer) {
        const alt = document.createElement("canvas");
        alt.className = this.hostCanvas.className || "ship3d-canvas";
        Object.assign(alt.style, {
          position: "absolute", inset: "0", width: "100%", height: "100%",
          display: "block", pointerEvents: "none", background: "transparent",
          zIndex: (this.hostCanvas.style.zIndex || "1")
        });
        this.hostCanvas.parentNode.insertBefore(alt, this.hostCanvas);
        this.canvas = alt;
        renderer = makeRendererOn(this.canvas);
      }
      this.renderer = renderer;
      this.renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
      this.renderer.setClearAlpha(0);

      // ---- scene / camera (pixel ortho with Y-down) -------------------------
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera();
      this.resize();
      addEventListener("resize", () => this.resize(), { passive: true });

      // ---- palette (pulls from icon) ----------------------------------------
      const PALETTE = {
        teal: 0x23c4cc,       // nose tip
        tealBright: 0x5ef2ff, // glows
        hull: 0xbfc4ca,       // light grey
        dark: 0x54585f,       // dark grey
        red:  0xff6e6e,       // wing panels
        black: 0x1d2027
      };

      // toon/flat-ish materials (WebGL1 safe)
      const mk = (color, opts={}) =>
        new THREE.MeshStandardMaterial(Object.assign({
          color, flatShading: true, metalness: 0.2, roughness: 0.9
        }, opts));
      const hullMat   = mk(PALETTE.hull);
      const darkMat   = mk(PALETTE.dark, { metalness: 0.35, roughness: 0.6 });
      const redMat    = mk(PALETTE.red);
      const tealMat   = mk(PALETTE.teal, { metalness: 0.1, roughness: 0.6 });
      const canopyMat = new THREE.MeshStandardMaterial({
        color: PALETTE.black, metalness: 0.1, roughness: 0.15,
        transparent: true, opacity: 0.9
      });
      const glowMat = new THREE.MeshStandardMaterial({
        color: PALETTE.tealBright, emissive: PALETTE.tealBright,
        emissiveIntensity: 1.0, metalness: 0, roughness: 1, flatShading: true
      });
      const engineMat = new THREE.MeshStandardMaterial({
        color: 0x8be9ff, emissive: 0x8be9ff, emissiveIntensity: 1.0,
        metalness: 0, roughness: 1, flatShading: true
      });

      // ---- build the ship (faces +X) ----------------------------------------
      this.ship = new THREE.Group();

      // Central fuselage (slim, long, like the icon)
      const body = new THREE.Mesh(new THREE.BoxGeometry(84, 20, 18), hullMat);
      body.position.set(-4, 0, 0);

      // Nose tip (teal)
      const tip = new THREE.Mesh(new THREE.ConeGeometry(12, 24, 6), tealMat);
      tip.rotation.z = -Math.PI * 0.5;
      tip.position.set(52, 0, 0);

      // Canopy “diamond”
      const canopy = new THREE.Mesh(new THREE.OctahedronGeometry(10), canopyMat);
      canopy.scale.set(1.0, 0.75, 1.2);
      canopy.position.set(14, 0, 10);

      // Side arms (dark grey “forks” from icon)
      const armL = new THREE.Mesh(new THREE.BoxGeometry(58, 10, 10), darkMat);
      armL.position.set(-6, -28, 0);
      const armR = armL.clone(); armR.position.y = 28;

      // Red wing panels (triangular look via thin boxes rotated)
      const wingL = new THREE.Mesh(new THREE.BoxGeometry(52, 8, 4), redMat);
      wingL.position.set(0, -22, 2); wingL.rotation.z = THREE.MathUtils.degToRad(-12);
      const wingR = wingL.clone(); wingR.position.y = 22; wingR.rotation.z = THREE.MathUtils.degToRad(12);

      // Wing inner grey blocks (like the icon’s inner sections)
      const wingCoreL = new THREE.Mesh(new THREE.BoxGeometry(26, 10, 6), hullMat);
      wingCoreL.position.set(-10, -22, 2);
      const wingCoreR = wingCoreL.clone(); wingCoreR.position.y = 22;

      // Little pods hanging under the arms
      const podL = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 12, 16), darkMat);
      podL.rotation.z = Math.PI * 0.5; podL.position.set(-20, -34, -6);
      const podR = podL.clone(); podR.position.y = 34;

      // Cyan slits on spine (sprites for soft glow)
      const slitGroup = new THREE.Group();
      const sMat = glowSpriteMat(PALETTE.tealBright);
      for (let i = 0; i < 6; i++) {
        const s = new THREE.Sprite(sMat);
        s.scale.set(18, 4, 1);
        s.position.set(-10 + i * 7.2, 0, 12);
        slitGroup.add(s);
      }

      // Back nozzle + cyan flame
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 10, 20), darkMat);
      nozzle.rotation.z = Math.PI * 0.5; nozzle.position.set(-58, 0, 0);

      const flame = new THREE.Mesh(new THREE.ConeGeometry(11, 28, 12), engineMat);
      flame.rotation.z = -Math.PI * 0.5; flame.position.set(-72, 0, 0);
      this.flame = flame;

      // Tiny teal dots (thruster “dashes” like the icon) – optional
      const dots = new THREE.Group();
      for (let i=0;i<4;i++){
        const p = new THREE.Mesh(new THREE.SphereGeometry(1.8, 10, 10), glowMat);
        p.position.set(-30 - i*6, (i%2?6:-6), -6);
        dots.add(p);
      }

      // Assemble
      this.ship.add(
        body, tip, canopy,
        armL, armR, wingL, wingR, wingCoreL, wingCoreR,
        podL, podR, slitGroup, nozzle, flame, dots
      );
      this.scene.add(this.ship);

      // ---- trail sprites (cyan) ---------------------------------------------
      this.trailGroup = new THREE.Group();
      this.scene.add(this.trailGroup);
      this.trails = [];
      this.trailMaterial = new THREE.SpriteMaterial({
        color: PALETTE.tealBright, transparent: true, opacity: 0.5,
        depthWrite: false, blending: THREE.AdditiveBlending
      });

      // ---- lights -----------------------------------------------------------
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      const key = new THREE.DirectionalLight(0xffffff, 0.9);
      key.position.set(220, 140, 240);
      this.scene.add(key);

      this.canvas.addEventListener("webglcontextlost", (e) => e.preventDefault(), false);

      this.enabled = true;
      this.loop();
    }

    resize() {
      if (!this.renderer) return;
      const w = Math.floor(window.innerWidth);
      const h = Math.floor(window.innerHeight);
      this.w = w; this.h = h;
      this.renderer.setSize(w, h, false);
      // Ortho pixel space, top-left origin, Y down
      this.camera.left = 0; this.camera.right = w;
      this.camera.top = 0;  this.camera.bottom = h;
      this.camera.near = -1000; this.camera.far = 1000;
      this.camera.position.set(0, 0, 10);
      this.camera.up.set(0, -1, 0);
      this.camera.updateProjectionMatrix();
    }

    // x, y can be normalized (0..1) or pixels. angleDeg optional. scale optional.
    set(x, y, angleDeg, scale) {
      if (!this.enabled) return;

      const px = (x <= 1 && y <= 1) ? (x * (this.w || window.innerWidth)) : x;
      const py = (x <= 1 && y <= 1) ? (y * (this.h || window.innerHeight)) : y;

      if (this._prev.x != null) {
        const moving = Math.hypot(px - this._prev.x, py - this._prev.y) > 0.6;
        if (this._engineManual === undefined) this.engineOn = moving;
      }
      this._prev.x = px; this._prev.y = py;

      this.ship.position.set(px, py, 0);

      if (typeof angleDeg === "number") {
        const rad = THREE.MathUtils.degToRad(angleDeg);
        if (this._lastHeading != null) {
          let d = rad - this._lastHeading;
          while (d >  Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          this._turnVel = THREE.MathUtils.lerp(this._turnVel, d, 0.5);
        }
        this._lastHeading = rad;
        this.ship.rotation.z = rad;
      }

      if (typeof scale === "number") this.ship.scale.setScalar(scale);
    }

    setEngine(on) { this.engineOn = !!on; this._engineManual = true; }

    _spawnPuff() {
      const s = new THREE.Sprite(this.trailMaterial.clone());
      const dir = new THREE.Vector2(Math.cos(this.ship.rotation.z), Math.sin(this.ship.rotation.z));
      const dist = 34;
      s.position.set(this.ship.position.x - dir.x * dist, this.ship.position.y - dir.y * dist, 0);
      const base = 10 + Math.random() * 7;
      s.scale.set(base, base, 1);
      this.trailGroup.add(s);
      this.trails.push({
        s, life: 0,
        max: 0.45 + Math.random() * 0.45,
        vx: -dir.x * (80 + Math.random() * 60),
        vy: -dir.y * (80 + Math.random() * 60)
      });
    }

    _updateTrail(dt) {
      for (let i = this.trails.length - 1; i >= 0; i--) {
        const p = this.trails[i];
        p.life += dt;
        const t = p.life / p.max;
        if (t >= 1) {
          this.trailGroup.remove(p.s);
          p.s.material.dispose(); p.s.geometry?.dispose?.();
          this.trails.splice(i, 1);
          continue;
        }
        p.s.position.x += p.vx * dt;
        p.s.position.y += p.vy * dt;
        const sc = THREE.MathUtils.lerp(p.s.scale.x, p.s.scale.x * 1.05, dt * 8);
        p.s.scale.set(sc, sc, 1);
        p.s.material.opacity = 0.46 * (1 - t);
      }
    }

    loop() {
      if (!this.enabled) return;
      this._raf = requestAnimationFrame(() => this.loop());

      const now = performance.now();
      const dt = Math.min(0.05, (now - this._lastTs) / 1000);
      this._lastTs = now; this._time += dt;

      // gentle wobble + bank (for “alive” feel)
      const wobX = Math.sin(this._time * 1.3) * 0.02;
      const wobY = Math.cos(this._time * 1.1) * 0.02;
      const bankTarget = THREE.MathUtils.clamp(-this._turnVel * 3.2, -0.5, 0.5);
      this._bank = THREE.MathUtils.lerp(this._bank, bankTarget, 0.15);
      this.ship.rotation.x = wobX + this._bank;
      this.ship.rotation.y = wobY;

      // engine flicker/visibility
      const base = this.engineOn ? 1.0 : 0.45;
      const flick = base + Math.sin(this._time * 34) * 0.08;
      if (this.flame && this.flame.material) {
        this.flame.material.emissiveIntensity = flick;
        const s = this.engineOn ? (1.0 + Math.sin(this._time * 18) * 0.08) : 0.7;
        this.flame.scale.setScalar(s);
        this.flame.visible = (this.engineOn || flick > 0.5);
      }

      if (this.engineOn) {
        this._spawnTimer += dt;
        if (this._spawnTimer >= 0.032) { this._spawnPuff(); this._spawnTimer = 0; }
      }
      this._updateTrail(dt);

      this.renderer.render(this.scene, this.camera);
    }

    destroy() {
      if (this._raf) cancelAnimationFrame(this._raf);
      try { this.renderer.dispose(); } catch {}
      this.scene.traverse(obj => {
        if (obj.isMesh) { obj.geometry?.dispose?.(); obj.material?.dispose?.(); }
        if (obj.isSprite){ obj.material?.dispose?.(); obj.geometry?.dispose?.(); }
      });
    }
  }

  // ---- singleton API --------------------------------------------------------
  let instance = null;

  window.initShip3D = function (canvasOrId) {
    try { instance = new Ship3D(canvasOrId); }
    catch (e) { console.warn("[Ship3D] init failed:", e); instance = null; }
  };

  // args: { x, y, angleDeg, engineOn, scale } — x/y may be normalized (0..1)
  window.updateShip3D = function (args) {
    if (!instance || !instance.enabled || !args) return;
    instance.set(args.x, args.y, args.angleDeg, args.scale);
    if (typeof args.engineOn === "boolean") instance.setEngine(args.engineOn);
  };

  window.destroyShip3D = function () {
    if (!instance) return;
    instance.destroy();
    instance = null;
  };
})();
