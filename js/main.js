// ========================== ELEMENTS ==========================
const bg = document.getElementById("bg-canvas");
const bctx = bg.getContext("2d", { alpha: false });

const stage = document.getElementById("stage");
const ui = document.getElementById("fps-canvas");
const uictx = ui.getContext("2d", { alpha: true });

const intro = document.getElementById("intro");
const warpOverlay = document.getElementById("warp");
const startBtn = document.getElementById("start-button");
const shootSfx = document.getElementById("sfx-shoot");
const bgMusic = document.getElementById("bg-music");

// set default SFX volume
if (shootSfx) shootSfx.volume = 0.12;

// Site data (skills, links, etc.)
const SITE = (() => { try { return JSON.parse(document.getElementById("site-data")?.textContent || "{}"); } catch { return {}; } })();
const APP_OPTS = window.APP_OPTS || {};

// soft fade helper
function fadeTo(audio, target = 0.12, ms = 1200) {
  if (!audio) return;
  const steps = 24;
  const step = (target - (audio.volume || 0)) / steps;
  let i = 0;
  const id = setInterval(() => {
    i++;
    audio.volume = Math.max(0, Math.min(1, (audio.volume || 0) + step));
    if (i >= steps) clearInterval(id);
  }, Math.max(16, Math.floor(ms / steps)));
}

function startBgMusic() {
  if (!bgMusic) return;
  bgMusic.volume = 0.15;
  bgMusic.currentTime = 0;
  bgMusic.play().then(() => {
    fadeTo(bgMusic, 0.12, 1200);
  }).catch(() => {
    // fallback if blocked
    const tryResume = () => {
      bgMusic.play().then(() => {
        fadeTo(bgMusic, 0.12, 1200);
        removeEventListener("pointerdown", tryResume, true);
        removeEventListener("keydown", tryResume, true);
      }).catch(()=>{});
    };
    addEventListener("pointerdown", tryResume, true);
    addEventListener("keydown", tryResume, true);
  });
}

// example helper for playing shoot sound safely
function playShootSfx() {
  try {
    if (shootSfx) {
      shootSfx.volume = 0.22; // ensure volume each play
      shootSfx.currentTime = 0;
      shootSfx.play();
    }
  } catch {}
}


// ========================== CONFIG / STATE ==========================
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CONFIG = {
  STARS: {
    COUNT: 420,
    IDLE_SPEED: 0.0,
    CRUISE_SPEED: reduceMotion ? 0.002 : 0.006,
    WARP_SPEED: reduceMotion ? 0.10 : 0.24, // warp factor
    METEOR_PROB: 0.001,
    METEOR_MAX: 1
  },
  CAMERA: { ZOOM: reduceMotion ? 1.35 : 1.85, RETURN_DELAY: 180 },
  UI: { SHOW_CROSSHAIR: false },
  SHIP: { FLIGHT_MS: reduceMotion ? 500 : 900, ARC_HEIGHT: 0.18, LAND_SCALE: 0.55, ANGLE_OFFSET: 0 },
  AUTOPILOT_IDLE_MS: Infinity,

  WARP: {
    ENTER_FADE_MS: reduceMotion ? 0 : 450,
    HOLD_MS:       reduceMotion ? 200 : 1300,
    EXIT_FADE_MS:  reduceMotion ? 0 : 350,
    USE_PULSE:     !reduceMotion
  }
};

// === Lazy warmers for big planet PNGs (sequential, low priority) ===
const supportsCreateImageBitmap = 'createImageBitmap' in window;

async function warmImage(url, priority = 'low') {
  try {
    const resp = await fetch(url, { priority }).catch(() => fetch(url));
    if (!resp || !resp.ok) return;
    const blob = await resp.blob();
    if (supportsCreateImageBitmap) {
      await createImageBitmap(blob);        // off-main-thread decode in Chromium/Firefox
    } else {
      const img = new Image();
      try { img.decoding = 'async'; } catch {}
      img.src = URL.createObjectURL(blob);
      await img.decode().catch(() => {});
      URL.revokeObjectURL(img.src);
    }
  } catch (_) { /* ignore */ }
}

function warmImagesSequential(urls) {
  let i = 0;
  const next = () => {
    if (i >= urls.length) return;
    warmImage(urls[i++]).finally(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(next, { timeout: 1500 });
      else setTimeout(next, 0);
    });
  };
  next();
}

// Cool palette preference (safer/less white)
const COOL_THEMES = ["theme-cyan","theme-violet"];
const ALL_THEMES  = ["theme-cyan","theme-violet","theme-magma","theme-emerald"];

// === NEW: star tint that follows the theme =========================
let starTint = [160,210,255]; // default cyan-ish
const THEME_TINTS = {
  "theme-cyan":   [160,210,255],
  "theme-violet": [200,170,255],
  "theme-magma":  [255,170,140],
  "theme-emerald":[140,255,200]
};
function setStarTintFromTheme(theme){ starTint = THEME_TINTS[theme] || [160,210,255]; }

// 3D ship state (Three.js only)
let ship = { x: 0, y: 0, angle: -90, moving: false, onArrive: null, path: null, t0: 0, dur: CONFIG.SHIP.FLIGHT_MS };

// DPI + input
let dpr = Math.max(1, window.devicePixelRatio || 1);
let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
let lastInputAt = performance.now(), autopilotLock = false;

// ========================== VIEWPORT / SIZING ==========================
// cache canvas CSS pixel sizes to avoid layout reads per frame
let width = 0, height = 0, bgW = 0, bgH = 0;
let bgGradient = null;

// Dynamic --vh for mobile address-bar changes
function updateViewportVars(){
  const vv = window.visualViewport;
  const vh = (vv?.height || window.innerHeight) * 0.01;
  document.documentElement.style.setProperty("--vh", `${vh}px`);
}
updateViewportVars();

// Throttle util
function throttleRAF(fn){
  let ticking = false;
  return (...args) => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; fn(...args); });
  };
}

function sizeCanvas(c) {
  // Use visualViewport if available for more accurate iOS sizing
  const vw = Math.floor(window.visualViewport?.width || window.innerWidth);
  const vh = Math.floor(window.visualViewport?.height || window.innerHeight);

  c.width = Math.floor(vw * dpr);
  c.height = Math.floor(vh * dpr);
  c.style.width = vw + "px";
  c.style.height = vh + "px";

  const ctx = c.getContext("2d");
  // Reset transform each time we change backing size
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { w: vw, h: vh };
}

function rebuildBgGradient() {
  const grd = bctx.createRadialGradient(bgW*0.2,bgH*0.15,0,bgW*0.5,bgH*0.5,Math.max(bgW,bgH));
  grd.addColorStop(0,"#0a0b12"); grd.addColorStop(0.6,"#06070d"); grd.addColorStop(1,"#000");
  bgGradient = grd;
}

function resizeAll() {
  dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1)); // clamp DPR a bit for memory
  const a = sizeCanvas(bg);
  const b = sizeCanvas(ui);

  bgW = a.w; bgH = a.h;
  width = b.w; height = b.h;
  rebuildBgGradient();

  placeShipAt(ship.x || (width/2),
              ship.y || (height*0.86),
              ship.angle);
}
const onResize = throttleRAF(() => { updateViewportVars(); resizeAll(); });
addEventListener("resize", onResize, { passive:true });
addEventListener("orientationchange", () => setTimeout(onResize, 50), { passive:true });
if (window.visualViewport){
  window.visualViewport.addEventListener("resize", onResize, { passive:true });
}

resizeAll();

// React to display scale changes (DPR)
try {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", onResize, { passive:true });
} catch { /* some browsers don't support this exact query */ }

// ========================== STARFIELD ==========================
let starSpeed = CONFIG.STARS.IDLE_SPEED;
let warpTarget = CONFIG.STARS.IDLE_SPEED;
const stars = Array.from({ length: CONFIG.STARS.COUNT }, () => spawnStar());
const meteors = [];

// ADD: simple adaptive quality flag (auto toggled below)
let LOW_END = false;                   // heuristic jank detector flips this
let STAR_STEP = 1;                     // draw every STAR_STEP-th star

function spawnStar() {
  // use cached bg sizes for consistency and to avoid layout reads
  return { x: (Math.random()-0.5)*bgW*2, y:(Math.random()-0.5)*bgH*2, base:0.15+Math.random()*0.35, a:0, ta:0, next:performance.now()+500+Math.random()*1500, twEnd:0 };
}
function spawnMeteor() {
  const edges = ["top","right","bottom","left"][Math.floor(Math.random()*4)];
  let x, y, vx, vy; const speed = 3.5 + Math.random()*2.2;
  if (edges==="top"){ x=Math.random()*width; y=-20; vx=(Math.random()*2-1)*0.6; vy=speed; }
  if (edges==="bottom"){ x=Math.random()*width; y=height+20; vx=(Math.random()*2-1)*0.6; vy=-speed; }
  if (edges==="left"){ x=-20; y=Math.random()*height; vx=speed; vy=(Math.random()*2-1)*0.6; }
  if (edges==="right"){ x=width+20; y=Math.random()*height; vx=-speed; vy=(Math.random()*2-1)*0.6; }
  meteors.push({ x, y, vx, vy, life: 0, maxLife: 120 + Math.random()*100, len: 40 + Math.random()*60 });
}
function updateMeteors(ctx){
  if (!reduceMotion && Math.random() < CONFIG.STARS.METEOR_PROB && meteors.length < CONFIG.STARS.METEOR_MAX) spawnMeteor();
  ctx.lineCap = "round";
  for (let i = meteors.length - 1; i >= 0; i--){
    const m = meteors[i];
    m.x += m.vx; m.y += m.vy; m.life++;
    const tailX = m.x - m.vx * (m.len / 10);
    const tailY = m.y - m.vy * (m.len / 10);
    const alpha = Math.max(0, 1 - m.life / m.maxLife);
    ctx.strokeStyle = `rgba(255,255,255,${0.50*alpha})`;
    ctx.lineWidth = Math.max(1, 1.6*alpha);
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tailX, tailY); ctx.stroke();
    if (m.life>m.maxLife || m.x<-120 || m.y<-120 || m.x>width+120 || m.y>height+120) meteors.splice(i,1);
  }
}

// cache: label metrics so we don’t call measureText every frame
function ensureTextMetrics(t){
  if (t._mw && t._nw) return;
  uictx.save();
  uictx.font = "600 18px Segoe UI, sans-serif";
  t._mw = uictx.measureText(t.label || "").width;
  uictx.font = "14px Segoe UI, sans-serif";
  t._nw = uictx.measureText(`· ${t.name}`).width;
  uictx.restore();
}

function renderStars() {
  // paint bg once per frame without DOM reads
  bctx.fillStyle = "#000"; bctx.fillRect(0, 0, bgW, bgH);
  bctx.fillStyle = bgGradient; bctx.fillRect(0,0,bgW,bgH);

  // adaptive quality while page/tab hidden (skip work)
  const hidden = document.visibilityState === "hidden";
  const step = hidden ? 3 : STAR_STEP;

  starSpeed += (warpTarget - starSpeed) * 0.06;
  const cx = bgW/2, cy = bgH/2;
  const parallaxFactor = starSpeed > 0.02 ? 0.0006 : 0.00008;
  const parallaxX = (mouseX - cx) * parallaxFactor;
  const parallaxY = (mouseY - cy) * parallaxFactor;
  const now = performance.now();

  if (starSpeed < 0.01) {
    bctx.fillStyle = "#fff";
    for (let k = 0; k < stars.length; k += step) {
      const s = stars[k];
      if (s.twEnd === 0 && Math.random() < 0.002) { s.twEnd = now + 800; s.ta = 1.0; }
      if (s.twEnd && now >= s.twEnd) { s.twEnd = 0; s.ta = s.base; }
      if (!s.twEnd && now >= s.next) {
        s.next = now + 500 + Math.random() * 1500;
        s.ta = s.base + (Math.random() * 0.15 - 0.07);
        s.ta = Math.min(0.7, Math.max(0.05, s.ta));
      }
      s.a += (s.ta - s.a) * 0.05;
      const rx = cx + s.x + parallaxX*40;
      const ry = cy + s.y + parallaxY*40;
      const r = s.twEnd ? 1.6 : 1.1;
      bctx.globalAlpha = Math.max(0, Math.min(1, s.a));
      bctx.beginPath(); bctx.arc(rx, ry, r, 0, Math.PI*2); bctx.fill();
    }
    bctx.globalAlpha = 1;
  } else {
    // --- WARP STREAKS (tinted + soft center) ---
    bctx.lineCap = "round";
    const minSide = Math.min(bgW, bgH);

    for (let k = 0; k < stars.length; k += step) {
      const s = stars[k];
      s.x += s.x * starSpeed + parallaxX * 40;
      s.y += s.y * starSpeed + parallaxY * 40;
      if (s.x*s.x + s.y*s.y > (bgW*bgW + bgH*bgH)) Object.assign(s, spawnStar());

      // Distance from center: fade lengths/alpha near the center to avoid white-out
      const dist = Math.hypot(s.x, s.y);
      const centerFade = Math.min(1, dist / (minSide * 0.36)); // 0 in core → 1 outward

      const len   = Math.min(12, 1 + starSpeed * 520) * (0.25 + 0.75 * centerFade);
      const alpha = Math.min(0.28, 0.08 + starSpeed * 0.50) * centerFade;
      const width = Math.max(0.6, starSpeed * 18 * (0.2 + 0.8 * centerFade));

      bctx.strokeStyle = `rgba(${starTint[0]},${starTint[1]},${starTint[2]},${alpha})`;
      bctx.lineWidth   = width;

      bctx.beginPath();
      bctx.moveTo(cx + s.x, cy + s.y);
      bctx.lineTo(
        cx + s.x - (s.x * starSpeed * len),
        cy + s.y - (s.y * starSpeed * len)
      );
      bctx.stroke();
    }
  }
  updateMeteors(bctx);
}

// Helper: choose a warp theme (bias to cool)
function pickWarpTheme(preferred = true){
  const pool = preferred ? COOL_THEMES : ALL_THEMES;
  return pool[Math.floor(Math.random()*pool.length)];
}

function startWarp(theme = pickWarpTheme(true)){
  // Safety: remove previous theme classes
  warpOverlay.classList.remove("theme-cyan","theme-violet","theme-magma","theme-emerald","pulse");
  if (theme) warpOverlay.classList.add(theme);
  setStarTintFromTheme(theme);                       // <-- NEW: tint stars to match theme
  if (CONFIG.WARP.USE_PULSE) warpOverlay.classList.add("pulse");

  warpOverlay.hidden = false;
  warpOverlay.classList.add("active");
  warpTarget = CONFIG.STARS.WARP_SPEED;

  setTimeout(() => {
    intro.style.display = "none";
    stage.hidden = false;
    resizeAll();
    ensureShip();
    ensureShip3D();

    // Begin warming planet PNGs only after first transition
    try {
      const allTargets = [...ROOMS[0].targets, ...ROOMS[1].targets];
      const seen = new Set();
      const urls = [];
      allTargets.forEach(t => {
        const key = (t.name || "").toLowerCase().replace(/[^a-z0-9]/g,'');
        if (!key) return;
        const file = FILE_OVERRIDE[key] || key;
        const url = `assets/planets/${file}.png`;
        if (!seen.has(url)) { seen.add(url); urls.push(url); }
      });
      if (urls.length) {
        if ('requestIdleCallback' in window) requestIdleCallback(() => warmImagesSequential(urls), { timeout: 2_000 });
        else setTimeout(() => warmImagesSequential(urls), 200);
      }
    } catch {}

  }, CONFIG.WARP.ENTER_FADE_MS);

  setTimeout(() => {
    warpTarget = CONFIG.STARS.CRUISE_SPEED;
    warpOverlay.classList.remove("active","pulse");
    setTimeout(() => { warpOverlay.hidden = true; }, CONFIG.WARP.EXIT_FADE_MS);
  }, CONFIG.WARP.ENTER_FADE_MS + CONFIG.WARP.HOLD_MS);
}

// ========================== PLANETS & DATA ==========================
const PLANETS = {
  amber:  { base:"#ffd84a", shade:"#f4b800", highlight:"#fff8c9", glow:"#ffe05e", ring:false },
  aqua:   { base:"#78d7ff", shade:"#3682ff", highlight:"#eaffff", glow:"#9edbff", ring:true,  ringColor:"rgba(160,210,255,.6)" },
  coral:  { base:"#ff9aa2", shade:"#ff4f6d", highlight:"#ffe9ec", glow:"#ffc3ca", ring:false },
  mint:   { base:"#9df6c7", shade:"#2ce6a1", highlight:"#eafff6", glow:"#aefbd7", ring:false },
  violet: { base:"#b99cff", shade:"#6e52ff", highlight:"#efeaff", glow:"#c9b3ff", ring:true,  ringColor:"rgba(185,156,255,.55)" }
};
const WARP_THEME = { amber:"theme-magma", aqua:"theme-cyan", coral:"theme-magma", mint:"theme-emerald", violet:"theme-violet" };

function makePlanetName(){
  const A=["Vy","Xe","Ka","Or","Ny","Au","Ze","Vo","Sy","Ty","Qui","Ara","Lo"];
  const B=["ris","thos","lune","dris","ron","vera","drax","lyx","phos","thia","nox","lyra","dune"];
  return A[Math.floor(Math.random()*A.length)]+B[Math.floor(Math.random()*B.length)];
}

const LINKS = {
  resume: SITE.links?.resume || "assets/docs/Raymond-Van-Der-Walt-Resume.pdf",
  github: SITE.links?.github || "https://github.com/",
  linkedin: SITE.links?.linkedin || "https://www.linkedin.com/",
  email: (SITE.links?.email && `mailto:${SITE.links.email}`) || (SITE.contact?.email && `mailto:${SITE.contact.email}`) || "mailto:raymond.vdwalt@gmail.com"
};

// helper to reuse link row
function renderLinksRow(){
  return `
    <div class="link-row">
      <a class="link-btn" href="${LINKS.resume}" target="_blank" rel="noopener">📄 Resume</a>
      <a class="link-btn" href="${LINKS.github}" target="_blank" rel="noopener">🐙 GitHub</a>
      <a class="link-btn" href="${LINKS.linkedin}" target="_blank" rel="noopener">🔗 LinkedIn</a>
      <a class="link-btn" href="${LINKS.email}">✉️ Email</a>
    </div>`;
}

// ---------- Contact form endpoint (optional) ----------
const CONTACT_ENDPOINT = (SITE.forms && SITE.forms.contact) || (SITE.contact && SITE.contact.formEndpoint) || "";

// ---------- Skills ----------
const SKILLS = (SITE.skills || []).map(g => ({
  title: g.group || g.title || "Skills",
  items: (g.items || []).map(it => ({ name: it.name, pct: it.level ?? it.pct ?? 0 })),
  badges: g.badges || []
}));

function skillBarClass(){
  const p = String(SITE.skillsPlanet?.palette || "aqua").toLowerCase();
  if (p === "amber") return "skill__fill--amber";
  if (p === "coral") return "skill__fill--coral";
  if (p === "mint")  return "skill__fill--mint";
  return "skill__fill--aqua";
}

function renderSkillsHTML(){
  const barClass = skillBarClass();
  const groups = SKILLS.map(g => {
    const rows = g.items.map(s => `
      <div class="skill">
        <div class="skill__row">
          <div class="skill__name">${s.name}</div>
          <div class="skill__pct">${s.pct}%</div>
        </div>
        <div class="skill__bar"><div class="skill__fill ${barClass}" style="--w:${s.pct}%"></div></div>
      </div>`).join("");
    const badges = g.badges?.length ? `<div class="badges">${g.badges.map(b=>`<span class="badge">${b}</span>`).join("")}</div>` : "";
    return `<section class="skill-group"><h3 class="skill-group__title">${g.title}</h3>${rows}${badges}</section>`;
  }).join("");

  return `<p>Here’s a snapshot of my current toolkit. I focus on cinematic UI and performance.</p><div class="skills">${groups}</div>${renderLinksRow()}`;
}

// Skills planet config
const skillsCfg = SITE.skillsPlanet || {};
const skillsPalette = PLANETS[(skillsCfg.palette || "violet")] || PLANETS.violet;
const SKILLS_PLANET = {
  name: skillsCfg.name || makePlanetName(),
  label: skillsCfg.label || "My Skills",
  r: Math.max(36, Math.min(80, (skillsCfg.size || 54))),
  planet: skillsPalette,
  asteroids: { count: 130, inner: 1.6, outer: 2.15, tilt: -0.28 }
};

// ---------- Video helper ----------
function renderVideo(url){
  if (!url) return "";
  const safe = String(url).trim();
  try {
    const u = new URL(safe, window.location.href);
    const href = u.href;

    // YouTube
    if (/youtube\.com\/watch|youtu\.be\//i.test(href)) {
      const id = href.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/)?.[1] || "";
      if (id) {
        return `<div class="video-wrap"><iframe src="https://www.youtube.com/embed/${id}?rel=0" title="Video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
      }
    }
    // Vimeo
    if (/vimeo\.com\/(\d+)/i.test(href)) {
      const vid = href.match(/vimeo\.com\/(\d+)/i)[1];
      return `<div class="video-wrap"><iframe src="https://player.vimeo.com/video/${vid}" title="Video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
    }
    // MP4 direct
    if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(href)) {
      return `<div class="video-wrap"><video src="${href}" controls playsinline preload="metadata"></video></div>`;
    }
  } catch {}
  return "";
}

// ---------- Case studies ----------
function caseStudyHTML(cs){
  const pills = (cs.stack||cs.tags||[]).map(t=>`<span class="pill">${t}</span>`).join("");
  const bullets = (cs.points||cs.bullets||[]).map(b=>`<li>${b}</li>`).join("");
  const links = (cs.links||[]).map(l=>`<a class="link-btn" href="${l.href}" target="_blank" rel="noopener">${l.label}</a>`).join("");
  const hero = cs.hero ? `<img class="case__hero" src="${cs.hero}" alt="${cs.title} hero" onerror="this.style.display='none'">` : "";
  const video = cs.video ? renderVideo(cs.video) : "";
  const role = cs.role ? `<p class="case__summary"><strong>Role:</strong> ${cs.role}</p>` : "";
  return `
    <article class="case">
      <div>${hero}${video}</div>
      <div>
        <h3 class="case__title">${cs.title}</h3>
        <p class="case__summary">${cs.summary}</p>
        ${role}
        <div class="pills">${pills}</div>
        ${bullets ? `<ul class="case__bullets">${bullets}</ul>` : ""}
        ${links ? `<div class="link-row" style="margin-top:12px">${links}</div>` : ""}
      </div>
    </article>`;
}
const CASE_A = {
  title:"NDA (Horror) Mission HUD",
  summary:"Cinematic, moment-to-moment HUD for objectives, markers, and state transitions.",
  role:"UI/UX · Blueprints + UMG/CommonUI",
  stack:["UE5","UMG/CommonUI","Blueprints","HUD"],
  points:[
    "Objective pipeline with timed beats and diegetic transitions.",
    "Marker system with distance-gated hints and screen-edge indicators.",
    "Budgeted animation curves + lightweight materials to stay 60fps+.",
    "Cinematic feel with smooth transitions and responsive feedback.",
    "Data-driven design for easy iteration and polish."
  ],
  hero:"assets/images/cases/Demo.png",
  video:"assets/videos/Horror.mp4",
  links:[]
};
const CASE_B = {
  title:"Will Tool MVP Dynamic PDF Builder",
  summary:"React app that generates legally structured PDFs from smart forms.",
  role:"Frontend Lead",
  stack:["React","TypeScript","PDF","Forms"],
  points:[
    "Composable question graph → schema-backed output.",
    "Autofill + validation + printer-friendly themes.",
    "Export pipeline with embedded signatures (prototype)."
  ],
  hero:"assets/images/cases/willtool.png",
  video:"",
  links:[]
};
const CASE_C = {
  title:"Hack & Slash ARPG",
  summary:"Reusable menu scaffolding with rotators, input mapping (EnhancedInput), and animation hooks.",
  role:"Gameplay UI · UE 5.3 (C++/BP)",
  stack:["UE5.6","C++","Blueprints","CommonUI","EnhancedInput","Animation","HUD","Widgets","Rotators"],
  points:[
    "Slot-based widgets with data-driven options.",
    "Controller/keyboard navigation rules and sound cues.",
    "Skinning via style assets and data tables.",
    "Rotators for inventory, skills, and equipment.",
    "EnhancedInput for flexible key mapping.",
    "Animation hooks for cinematic transitions."
  ],
  hero:"assets/images/cases/Equipped Axe.png",
  video:"assets/videos/A Basic Dungeon.mp4",
  links:[]
};
const CASE_D = {
  title:"Farmily — Mobile Foundations",
  summary:"Expo/React Native app skeleton with auth and payments plan.",
  role:"Mobile · React Native (Expo)",
  stack:["React Native","Expo","Auth","Payments"],
  points:[
    "Auth flow + protected screens.",
    "Theming and icons; responsive components.",
    "Payments integration plan PayFast."
  ],
  hero:"assets/images/cases/2.jpg",
  video:"",
  links:[]
};

// ---------- Certifications (richer) ----------
const RAW_CERTS = (SITE.certifications && SITE.certifications.length ? SITE.certifications : [
  { name:"(Example) Meta Front-End Developer", issuer:"Coursera", year:"2024", link:"#", status:"complete" },
  { name:"(Example) Google UX Design", issuer:"Coursera", year:"2023", link:"#", status:"complete" },
  { name:"(Example) Advanced JavaScript", issuer:"Udemy", year:"2022", progress: 60 }
]);

function normalizeCert(c){
  // Accept: c.status, c.progress number, or c.progress string ("Completed", "In progress", "75%")
  const rawProg = (c.progress ?? "").toString().trim().toLowerCase();
  const rawStatus = (c.status ?? rawProg).toString().trim().toLowerCase();

  let status = "";         // "complete" | "in-progress" | "planned" | ""
  let pct;

  if (typeof c.progress === "number") {
    pct = Math.max(0, Math.min(100, c.progress));
    status = pct >= 100 ? "complete" : "in-progress";
  } else if (/^\d{1,3}%?$/.test(rawProg)) {
    pct = Math.max(0, Math.min(100, parseInt(rawProg, 10)));
    status = pct >= 100 ? "complete" : "in-progress";
  } else {
    if (rawStatus.includes("complete"))   { status = "complete";   pct = 100; }
    else if (rawStatus.includes("progress")) { status = "in-progress"; }
    else if (rawStatus.includes("plan"))  { status = "planned"; }
  }

  const safeLink = c.verify || c.link ? encodeURI(c.verify || c.link) : "";

  return {
    name: c.name || "",
    issuer: c.issuer || "",
    year: c.year || c.date || "",
    link: safeLink,
    skills: c.skills || [],
    status, pct
  };
}

function statusBadgeHTML(status, pct){
  if (status === "complete" || pct === 100) {
    return `<div class="badges"><span class="badge">Completed</span></div>`;
  }
  if (status === "in-progress" || (typeof pct === "number" && pct < 100)) {
    return `<div class="badges"><span class="badge">In progress${typeof pct === "number" ? ` · ${pct}%` : ""}</span></div>`;
  }
  if (status === "planned") {
    return `<div class="badges"><span class="badge">Planned</span></div>`;
  }
  return "";
}

function progressBarHTML(pct){
  if (typeof pct !== "number" || pct >= 100) return "";
  // Reuse the existing skill bar styles so no extra CSS is needed
  return `<div class="skill__bar" style="margin-top:8px">
            <div class="skill__fill ${skillBarClass()}" style="--w:${pct}%"></div>
          </div>`;
}

function certificationsHTML(){
  const items = (SITE.certifications?.length ? SITE.certifications : RAW_CERTS)
    .map(normalizeCert)
    // Sort: in-progress first, then completed, then others; tiebreaker by year desc
    .sort((a,b) => {
      const order = v => v.status==="complete" ? 0
               : v.status==="in-progress" ? 1
               : 2;
      if (order(a) !== order(b)) return order(a) - order(b);
      const ay = parseInt(a.year) || 0, by = parseInt(b.year) || 0;
      return by - ay;
    });

  const cards = items.map(c => {
    const meta = [c.issuer, c.year].filter(Boolean).join(" · ");
    const skills = c.skills.length ? `<p class="card__sub">Skills</p><p class="case__summary">${c.skills.join(" · ")}</p>` : "";
    const badge = statusBadgeHTML(c.status, c.pct);
    const bar   = progressBarHTML(c.pct);
    const btn   = c.link ? `<div class="link-row"><a class="link-btn" href="${c.link}" target="_blank" rel="noopener">View credential</a></div>` : "";

    return `
      <article class="card">
        <h3 class="card__title">${c.name}</h3>
        <p class="card__desc">${meta}</p>
        ${skills}
        ${badge}
        ${bar}
        ${btn}
      </article>
    `;
  }).join("");

  return `<div class="grid-cards">${cards}</div>`;
}

// ---------- About ----------
const YEARS = Number(SITE.years) || 4;
const PROFILE_SRC =
  (typeof SITE.profile === "string" ? SITE.profile :
   SITE.profile?.photo || SITE.profile?.src) || "assets/images/profile.png";

const aboutHTML = `
  <div class="about about--split">
    <div class="about__text">
      <h3 style="margin:0 0 8px;color:#d7e6ff;font-weight:600;font-size:1rem">About</h3>
      <p>
        I’m Raymond a Frontend &amp; Game Developer who lives where UI meets
        gameplay. For <strong>${YEARS}+ years</strong> I’ve been building cinematic HUDs,
        moment-to-moment interactions, and performance-first web experiences
        with UE5, React, TypeScript, and Canvas/WebGL.
      </p>
      <p>
        I love tuning feel, building micro-feedback, and keeping frame time lean
        so polish never costs performance. I collaborate tightly with design,
        wire UI to real game states, and ship clean, maintainable systems.
      </p>
      <p><strong>Core stack:</strong> UE5 (Blueprints/CommonUI), React + TypeScript, Tailwind/CSS, Canvas/WebGL.</p>
      <p><strong>Highlights:</strong> Objective/HUD systems, animated markers, dynamic PDF tooling, mobile app foundations with Expo.</p>

      <ul class="about__bullets" style="margin:8px 0 12px 18px; line-height:1.6">
        <li>Design-driven dev: prototype fast, iterate on feel, ship.</li>
        <li>Gameplay-aware UI: widgets that respond to signals and inputs.</li>
        <li>Perf focus: budgeted animations, memoized renders, lean shaders.</li>
        <li>Team fit: I speak both “design” and “engineering.”</li>
      </ul>

      <h3 style="margin:14px 0 8px;color:#d7e6ff;font-weight:600;font-size:1rem">Hobbies &amp; Interests</h3>
      <div class="pills pills--hobbies">
        <span class="pill">🎮 Playing video games</span>
        <span class="pill">🎓 Learning on Udemy</span>
        <span class="pill">📚 Reading books</span>
        <span class="pill">🧪 Prototyping UI ideas</span>
        <span class="pill">🎧 Game OSTs &amp; synthwave</span>
        <span class="pill">🌿 Family time &amp; outdoors</span>
      </div>

      <h3 style="margin:14px 0 8px;color:#d7e6ff;font-weight:600;font-size:1rem">Connect</h3>
      ${renderLinksRow()}
    </div>

    <figure class="about__media" aria-label="Portrait">
      <div class="portrait-neo"></div>
      <div class="portrait-fade" aria-hidden="true"></div>
      <img
        class="portrait-neo__img"
        src="${PROFILE_SRC}"
        alt="Raymond Van Der Walt"
        onerror="this.style.display='none'"
        decoding="async"
      />
    </figure>
  </div>
`;

// ---------- Projects (rich details) ----------
const PROJECTS = [
  {
    title:"NDA Signed Mission HUD",
    summary:"Cinematic HUD driving objectives, diegetic markers, and guided flow.",
    requires:["UE5","Blueprints","CommonUI","Materials/Shaders"],
    does:[
      "Objective/state machine → HUD states + timed beats",
      "Marker hints, distance gating, screen-edge arrows",
      "Strict frame-time budget for animations/materials"
    ],
    links:[]
  },
  {
    title:"Will Tool MVP — Dynamic PDF",
    summary:"Form flows that export legally structured PDFs.",
    requires:["HTML","CSS/Tailwind","JavaScript","React","TypeScript","Node"],
    does:[
      "Schema-driven questions with validation + autofill",
      "Accessible components, printer-friendly themes",
      "PDF assembly pipeline (prototype signatures)"
    ],
    links:[]
  },
  {
    title:"Common UI Menu Framework",
    summary:"UE5 menu system with rotators, input mapping and styling.",
    requires:["UE5.6","C++","Blueprints","CommonUI"],
    does:[
      "Slot-based widgets and data-driven options",
      "EnhancedInput navigation + sound cues",
      "Skins via style assets and data tables"
    ],
    links:[]
  },
  {
    title:"Farmily",
    summary:"Expo/React Native app foundations with auth and payments plan.",
    requires:["React Native","Expo","TypeScript","Auth","Stripe (plan)"],
    does:[
      "Auth flow + protected routes",
      "Responsive components + theming",
      "Payments integration plan"
    ],
    links:[]
  }
];
function projectsHTML(){
  const cards = PROJECTS.map(p => `
    <article class="card">
      <h3 class="card__title">${p.title}</h3>
      <p class="card__desc">${p.summary}</p>
      <h4 class="card__sub">What it does</h4>
      <ul class="list">${p.does.map(d=>`<li>${d}</li>`).join("")}</ul>
      <h4 class="card__sub">What it requires</h4>
      <p class="case__summary">${p.requires.join(" · ")}</p>
      ${p.links?.length ? `<div class="link-row">${p.links.map(l=>`<a class="link-btn" href="${l.href}" target="_blank" rel="noopener">${l.label}</a>`).join("")}</div>` : ""}
    </article>
  `).join("");
  return `<div class="grid-cards">${cards}</div><p style="margin-top:12px">Want the source or a live demo? <a href="${LINKS.email}">Email me</a>.</p>`;
}

// ---------- Contact ----------
const CONTACT_HTML = `
  <form id="contact-form" class="contact" novalidate>
    <div class="contact__row">
      <label class="sr-only" for="c-name">Name</label>
      <input id="c-name" class="input" name="name" type="text" placeholder="Your name" required>

      <label class="sr-only" for="c-email">Email</label>
      <input id="c-email" class="input" name="email" type="email" placeholder="you@email.com" required>
    </div>

    <label class="sr-only" for="c-msg">Message</label>
    <textarea id="c-msg" class="textarea" name="message" placeholder="How can I help?" required></textarea>

    <!-- Honeypot -->
    <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">

    <div class="link-row">
      <button class="btn" type="submit">Send message</button>
      <a class="link-btn" href="${LINKS.email}">Or email me directly</a>
    </div>
    <p id="contact-status" aria-live="polite" style="margin:6px 0 0; color:#cfe1ff;"></p>
  </form>
`;

function bindContactForm(){
  const form = landing?.querySelector?.("#contact-form");
  if (!form) return;

  const status = landing.querySelector("#contact-status");
  const endpoint = (CONTACT_ENDPOINT || "").trim();
  const btn = form.querySelector("button[type=submit]");

  const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||"").trim());

  function setInvalid(el, on){
    el.classList.toggle("is-invalid", !!on);
    el.setAttribute("aria-invalid", on ? "true" : "false");
  }

  function validate(){
    const okName = !!form.name.value.trim();
    const okEmail = emailOk(form.email.value);
    const okMsg = !!form.message.value.trim();
    setInvalid(form.name, !okName);
    setInvalid(form.email, !okEmail);
    setInvalid(form.message, !okMsg);
    return okName && okEmail && okMsg;
  }

  ["input","blur","keyup"].forEach(ev=>{
    form.addEventListener(ev, e => {
      if (e.target.matches(".input, .textarea")) validate();
    }, true);
  });

  function mailtoFallback() {
    const n = encodeURIComponent(form.name.value || "");
    const e = encodeURIComponent(form.email.value || "");
    const m = encodeURIComponent(form.message.value || "");
    const subject = encodeURIComponent(`Portfolio contact from ${form.name.value || "visitor"}`);
    const body = encodeURIComponent(`Name: ${decodeURIComponent(n)}\nEmail: ${decodeURIComponent(e)}\n\n${decodeURIComponent(m)}`);
    const emailAddr = (SITE.links?.email || "raymond.vdwalt@gmail.com").replace(/^mailto:/,"");
    window.location.href = `mailto:${emailAddr}?subject=${subject}&body=${body}`;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) { status.textContent = "Please fill all fields correctly."; return; }
    status.textContent = "Sending…";
    btn.disabled = true;

    if (form["_hp"]?.value) { status.textContent = "Thanks!"; form.reset(); btn.disabled = false; return; }

    if (!endpoint) {
      mailtoFallback();
      status.textContent = "Opening your email app…";
      btn.disabled = false;
      return;
    }

    try {
      const fd = new FormData(form);
      const resp = await fetch(endpoint, { method: "POST", body: fd });
      if (!resp.ok) throw new Error("Network error");
      status.textContent = "Thanks! I’ll get back to you shortly.";
      form.reset();
    } catch (err) {
      status.textContent = "Couldn’t reach the server. Opening your email app instead…";
      mailtoFallback();
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- About ----------
const aboutHTMLPanel = aboutHTML;

// ROOMS
const NAMES = ["Volara","Nyxus","Aurelia","Thal-3","Kairon","Xerith","Cindrix","Abyssium","Vespera","Solyn"];

let currentRoom = 0;
const ROOMS = [
  { targets: [
    { name: NAMES[0], px: 18, py: 26, r: 46, planet: PLANETS.amber,  label: "About Me",        action: () => openLanding("About Me", aboutHTMLPanel), warp: "theme-magma" },
    // ring tilt variations added
    { name: NAMES[7], px: 47, py: 42, r: 36, planet: PLANETS.aqua,   label: "Projects",        action: () => openLanding("Projects", projectsHTML()), warp: "theme-cyan",   ringTilt:  0.32 },
    { name: NAMES[9], px: 60, py: 18, r: 34, planet: PLANETS.violet, label: "Certifications",  action: () => openLanding("Certifications", certificationsHTML()), warp: "theme-violet", ringTilt: -0.38 },
    { name: SKILLS_PLANET.name, px: 75, py: 68, r: SKILLS_PLANET.r, planet: SKILLS_PLANET.planet, label: SKILLS_PLANET.label, action: () => openLanding("Skills", renderSkillsHTML()), asteroids: SKILLS_PLANET.asteroids, warp: WARP_THEME[skillsCfg.palette || "violet"] || "theme-violet" },
    { name: NAMES[6], px: 78, py: 22, r: 40, planet: PLANETS.coral,  label: "Contact",         action: () => openLanding("Contact", CONTACT_HTML), warp: "theme-magma" },
    { name: NAMES[3], px: 42, py: 74, r: 40, planet: PLANETS.mint,   label: "Solar System →",     action: () => setRoom(1), warp: "theme-emerald" },
  ]},
  { targets: [
    { name: NAMES[1], px:28, py:30, r:42, planet: PLANETS.aqua,   label:"Case Study A", action: () => openLanding("Case Study A", caseStudyHTML(CASE_A)), warp: "theme-cyan",   ringTilt:  0.22 },
    { name: NAMES[4], px:72, py:30, r:48, planet: PLANETS.coral,  label:"Case Study B", action: () => openLanding("Case Study B", caseStudyHTML(CASE_B)), warp: "theme-magma" },
    { name: NAMES[8], px:30, py:72, r:44, planet: PLANETS.violet, label:"Case Study C", action: () => openLanding("Case Study C", caseStudyHTML(CASE_C)), warp: "theme-violet", ringTilt: -0.28 },
    { name: NAMES[5], px:70, py:72, r:42, planet: PLANETS.mint,   label:"Case Study D", action: () => openLanding("Case Study D", caseStudyHTML(CASE_D)), warp: "theme-emerald" },
    { name: NAMES[2], px:50, py:90, r:38, planet: PLANETS.amber,  label:"← Back",       action: () => setRoom(0), warp: "theme-magma" },
  ]},
];
let TARGETS = ROOMS[currentRoom].targets;

// ---------- image filename overrides (exact case) ----------
const FILE_OVERRIDE = {
  abysium: "Abyssium", abyssium: "Abyssium",
  cindrix: "Cindrix",
  thal3: "Thal3",
  orionisix: "Orionis-IX",
  volara: "Volara",
  nyxus: "Nyxus",
  aurelia: "Aurelia",
  kairon: "Kairon",
  xerith: "Xerith",
  vespera: "Vespera",
  solyn: "Solyn"
};

const planetCache = new Map();
function buildPlanetTextures(list){
  list.forEach(t => {
    const key = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (planetCache.has(key)) { t.tex = planetCache.get(key); ensureAsteroids(t); return; }

    const img = new Image();
    // PATCH: hint async decode to avoid layout jank
    try { img.decoding = "async"; } catch {}
    img.onload = () => { planetCache.set(key, img); t.tex = img; ensureAsteroids(t); };
    img.onerror = () => {
      const tex = makePlanetTexture(t.r, t.planet, t.name.split("").reduce((a,c)=>a+c.charCodeAt(0),0));
      planetCache.set(key, tex); t.tex = tex; ensureAsteroids(t);
    };
    const fname = FILE_OVERRIDE[key] || key;
    img.src = `assets/planets/${fname}.png`;
  });
}
buildPlanetTextures(TARGETS);

function setRoom(i){
  currentRoom = Math.max(0, Math.min(i, ROOMS.length-1));
  TARGETS = ROOMS[currentRoom].targets;
  buildPlanetTextures(TARGETS);
}

// ========================== ASTEROIDS / PLANET TEXTURES ==========================
function seededRand(seed){ let x = seed|0 || 123456789; return () => (x ^= x<<13, x ^= x>>>17, x ^= x<<5, (x>>>0)/4294967295); }
function makePlanetTexture(r, palette, seed=Date.now()){
  const rand = seededRand(seed);
  const c = document.createElement("canvas"); const s = Math.ceil(r*2);
  c.width = c.height = s; const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(s*0.35, s*0.35, r*0.2, s/2, s/2, r);
  g.addColorStop(0, palette.highlight || "#ffffff"); g.addColorStop(0.02, palette.base); g.addColorStop(1, palette.shade);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s/2, s/2, r, 0, Math.PI*2); ctx.fill();
  ctx.save(); ctx.globalCompositeOperation = "overlay";
  for (let i=0;i<120;i++){
    const rr = r*(0.05 + rand()*0.25), a = 0.10 + rand()*0.25;
    ctx.globalAlpha = a; ctx.filter = `blur(${Math.max(0.6, rr*0.15)}px)`;
    const ang = rand()*Math.PI*2, dist = rand()*r*0.7, cx = s/2 + Math.cos(ang)*dist, cy = s/2 + Math.sin(ang)*dist;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI*2); ctx.fillStyle = rand() < 0.5 ? "#ffffff" : "#000000"; ctx.fill();
  }
  ctx.restore(); ctx.filter = "none";
  const rim = ctx.createRadialGradient(s/2, s/2, r*0.9, s/2, s/2, r*1.08);
  rim.addColorStop(0, "rgba(255,255,255,0.0)"); rim.addColorStop(1, (palette.glow || palette.base) + "00");
  ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(s/2, s/2, r*1.08, 0, Math.PI*2); ctx.fill();
  return c;
}
function ensureAsteroids(t){
  if (!t.asteroids || t.beltPoints) return;
  const { count=120, inner=1.6, outer=2.1, tilt=-0.22 } = t.asteroids || {};
  const rand = seededRand(t.name.split("").reduce((a,c)=>a+c.charCodeAt(0),0) ^ 9137);
  const pts = [];
  for (let i=0;i<count;i++){
    const a = (i/count)*Math.PI*2 + rand()*0.5;
    const radius = t.r * (inner + rand()*(outer-inner));
    const er = radius * 0.52;
    pts.push({ a, radius, er, size: 0.6 + rand()*1.4, shade: 0.6 + rand()*0.4, speed: 0.0006 + rand()*0.0006 });
  }
  t.beltPoints = pts; t.beltTilt = tilt;
}
function drawAsteroidBelt(x, y, t){
  if (!t.beltPoints) return;
  uictx.save(); uictx.translate(x,y); uictx.rotate(t.beltTilt || 0);
  for (const p of t.beltPoints){
    p.a += p.speed;
    const px = Math.cos(p.a) * p.radius, py = Math.sin(p.a) * p.er;
    uictx.globalAlpha = 0.75 * p.shade;
    uictx.fillStyle = "rgba(220,230,255,0.85)";
    uictx.beginPath(); uictx.arc(px, py, p.size, 0, Math.PI*2); uictx.fill();
  }
  uictx.restore(); uictx.globalAlpha = 1;
}

// ========================== DRAWING ==========================
let lastHoveredIndex = -1;
function drawPlanetHalo(x, y, t, r, now){
  const pulse = 0.88 + Math.sin(now*0.001 + r*0.03)*0.12;
  uictx.save(); uictx.globalAlpha = 0.16 * pulse;
  uictx.shadowColor = t.planet.glow || t.planet.base;
  uictx.shadowBlur = r * (1.4 + 0.8*pulse);
  uictx.beginPath(); uictx.arc(x, y, r*1.18, 0, Math.PI*2);
  uictx.strokeStyle = "transparent"; uictx.stroke(); uictx.restore();
}
function drawPlanetSparkle(x,y,r,now){
  const a = (now*0.0006) % (Math.PI*2);
  const sx = x + Math.cos(a) * r*0.35, sy = y + Math.sin(a*1.3) * r*0.22;
  uictx.save(); uictx.globalAlpha = 0.25 + Math.sin(now*0.01)*0.1;
  uictx.fillStyle = "#ffffff"; uictx.beginPath(); uictx.arc(sx, sy, Math.max(1.5, r*0.04), 0, Math.PI*2); uictx.fill(); uictx.restore();
}
function jitterFor(t){
  const seed = t.name.split("").reduce((a,c)=>a+c.charCodeAt(0),0);
  const now = performance.now()*0.001;
  const amp = Math.max(1.2, Math.min(6, t.r*0.08));
  return { x: Math.cos(now*0.6 + seed*0.01) * amp, y: Math.sin(now*0.7 + seed*0.02) * amp };
}

function drawTargetPlanet(x,y,t, hovered, now){
  const r = t.r;
  drawPlanetHalo(x,y,t,r,now);
  const j = jitterFor(t);
  const px = x + j.x, py = y + j.y;

  if (t.tex) uictx.drawImage(t.tex, px - r, py - r, r * 2, r * 2);

  if (t.planet.ring){
    uictx.save(); uictx.translate(px, py); uictx.rotate(typeof t.ringTilt === "number" ? t.ringTilt : -0.22);
    uictx.strokeStyle = t.planet.ringColor || "rgba(200,220,255,.55)";
    uictx.lineWidth = Math.max(2, r * 0.12);
    uictx.beginPath(); uictx.ellipse(0, 0, r*1.35, r*0.55, 0, 0, Math.PI*2); uictx.stroke();
    uictx.restore();
  }

  if (t.beltPoints) drawAsteroidBelt(px, py, t);
  drawPlanetSparkle(px,py,r,now);

  if (hovered){
    uictx.save(); uictx.globalAlpha = 0.25;
    uictx.shadowColor = t.planet.glow || t.planet.base; uictx.shadowBlur = r * 1.2;
    uictx.beginPath(); uictx.arc(px, py, r*1.15, 0, Math.PI*2);
    uictx.strokeStyle = "transparent"; uictx.stroke(); uictx.restore();
  }

  ensureTextMetrics(t);

  uictx.font = "600 18px Segoe UI, sans-serif";
  uictx.fillStyle = "#cfe1ff";
  uictx.fillText(t.label, px - t._mw/2, py + r + 10);

  uictx.font = "14px Segoe UI, sans-serif";
  const nameText = `· ${t.name}`;
  uictx.fillStyle = "#ffffff";
  uictx.fillText(nameText, px - t._nw/2, py + r + 30);
}

// === Decorative Space Station (sprite + pseudo-3D) ==========================
const STATION_CFG = {
  label: SITE.station?.label || "Station",
  sprite: SITE.station?.sprite || "",        // e.g. "assets/images/station.png"
  px: (typeof SITE.station?.px === "number") ? SITE.station.px : 22,   // default moved LEFT
  py: (typeof SITE.station?.py === "number") ? SITE.station.py : 18,
  scale: SITE.station?.scale ?? 1
};
let stationImg = null;
if (STATION_CFG.sprite) {
  const _img = new Image();
  _img.onload = () => { stationImg = _img; };
  try { _img.decoding = "async"; } catch {}
  _img.src = STATION_CFG.sprite;
}
const STATION = { r: 18, rot: 0, rotSpeed: 0.0035, pulse: 0, ...STATION_CFG };

function drawStation(){
  const x = toPx(STATION.px, width);
  const y = toPx(STATION.py, height);

  STATION.rot += STATION.rotSpeed;
  STATION.pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.002);

  uictx.save();
  uictx.translate(x, y);
  uictx.rotate(STATION.rot);

  // pseudo-3D ring (tilted ellipse + glow)
  uictx.save();
  uictx.rotate(-0.25);
  uictx.globalAlpha = 0.30 + STATION.pulse * 0.25;
  uictx.strokeStyle = "rgba(180,210,255,0.85)";
  uictx.lineWidth = 1.2;
  uictx.beginPath(); uictx.ellipse(0, 0, STATION.r*1.9, STATION.r*0.9, 0, 0, Math.PI*2); uictx.stroke();
  uictx.restore();

  // sprite (if provided), otherwise vector fallback
  if (stationImg) {
    const s = STATION.r * 2.2 * (STATION.scale || 1);
    // soft drop shadow for depth
    uictx.save();
    uictx.globalAlpha = 0.85;
    uictx.shadowColor = "rgba(100,140,255,0.55)";
    uictx.shadowBlur = 16;
    uictx.drawImage(stationImg, -s*0.5, -s*0.5, s, s);
    uictx.restore();
  } else {
    // vector fallback
    uictx.fillStyle = "#cfe1ff";
    uictx.beginPath(); uictx.arc(0, 0, STATION.r*0.46, 0, Math.PI*2); uictx.fill();

    uictx.strokeStyle = "#9fb6ff";
    uictx.lineWidth = 2;
    uictx.beginPath(); uictx.moveTo(-STATION.r*1.2, 0); uictx.lineTo(STATION.r*1.2, 0); uictx.stroke();
    uictx.beginPath(); uictx.moveTo(0, -STATION.r*1.2); uictx.lineTo(0, STATION.r*1.2); uictx.stroke();
  }

  // tiny blink
  uictx.fillStyle = "rgba(255,255,255,0.9)";
  uictx.beginPath(); uictx.arc(STATION.r*0.75, 0, 1.6 + STATION.pulse*0.8, 0, Math.PI*2); uictx.fill();

  uictx.restore();

  // label (uses SITE.station.label if provided)
  uictx.font = "600 14px Segoe UI, sans-serif";
  const label = STATION.label || "Station";
  const lw = uictx.measureText(label).width;
  uictx.fillStyle = "#cfe1ff";
  uictx.fillText(label, x - lw/2, y + STATION.r + 16);
}

function drawTargets(){
  const warping = cam.active || Math.abs(cam.scale - 1) > 0.02;
  uictx.textBaseline = "top";
  const now = performance.now();
  let hoveredIdx = -1;

  TARGETS.forEach((t, i) => {
    const x = toPx(t.px, width);
    const y = toPx(t.py, height);
    const r = t.r;
    let hovered = false;
    if (!warping && !ship.moving){
      const dist = Math.hypot(mouseX - x, mouseY - y);
      hovered = dist <= r + 6;
      if (hovered) hoveredIdx = i;
    }
    drawTargetPlanet(x, y, t, hovered, now);
  });

  // Decorative station (draw after planets so it floats on top a bit)
  drawStation();

  lastHoveredIndex = hoveredIdx;
}
function drawUI(){
  uictx.clearRect(0,0,width,height);
  uictx.save();
  uictx.translate(width/2, height/2);
  uictx.scale(cam.scale, cam.scale);
  uictx.translate(-width/2 - cam.x, -height/2 - cam.y);
  drawTargets();
  uictx.restore();
}

// ========================== CAMERA ==========================
const cam = { x:0, y:0, scale:1, tx:0, ty:0, ts:1, active:false, arriving:false, onArrive:null };
function updateCam(){
  cam.x += (cam.tx - cam.x) * 0.12;
  cam.y += (cam.ty - cam.y) * 0.12;
  cam.scale += (cam.ts - cam.scale) * 0.12;
  if (cam.active && Math.abs(cam.x-cam.tx)<0.6 && Math.abs(cam.y-cam.ty)<0.6 && Math.abs(cam.scale-cam.ts)<0.01){
    cam.active = false;
    if (!cam.arriving) {
      cam.arriving = true;
      setTimeout(() => {
        cam.arriving = false;
        cam.tx = 0; cam.ty = 0; cam.ts = 1;
        if (typeof cam.onArrive === "function") cam.onArrive();
        cam.onArrive = null;
        warpTarget = CONFIG.STARS.CRUISE_SPEED;
      }, CONFIG.CAMERA.RETURN_DELAY);
    }
  }
}

// ========================== HELPERS ==========================
function toPx(p, size){ return (p/100) * size; }

// ========================== SHIP (3D only) ==========================
function ensureShip(){
  if (!ship.x && !ship.y){
    ship.x = width / 2;
    ship.y = height * 0.86;
    placeShipAt(ship.x, ship.y, ship.angle);
  }
}
function ensureShip3D(){
  const cvs = document.getElementById("ship3d");
  if (!cvs) return;
  if (window.initShip3D && !reduceMotion) {
    try {
      window.initShip3D("ship3d");
      window.updateShip3D?.({ engineOn: true });
      placeShipAt(ship.x, ship.y, ship.angle);
    }
    catch (e){ console.warn("Ship3D init failed:", e); }
  }
}
function placeShipAt(x, y, deg, scale){
  ship.x = x; ship.y = y; ship.angle = deg;
  if (window.updateShip3D){
    try {
      window.updateShip3D({
        x: x/width,
        y: y/height,
        angleDeg: deg + CONFIG.SHIP.ANGLE_OFFSET,
        scale: (typeof scale === "number") ? scale : undefined
      });
    } catch {}
  }
}
function aimShipTowards(tx, ty){
  const dx = tx - ship.x, dy = ty - ship.y;
  const deg = Math.atan2(dy, dx) * 180 / Math.PI;
  placeShipAt(ship.x, ship.y, deg);
}

// Bezier helpers
function cubic(p0,p1,p2,p3,t){ const it=1-t; return { x: it*it*it*p0.x + 3*it*it*t*p1.x + 3*it*t*t*p2.x + t*t*t*p3.x,
                                                      y: it*it*it*p0.y + 3*it*it*t*p1.y + 3*it*t*t*p2.y + t*t*t*p3.y }; }
function cubicTangent(p0,p1,p2,p3,t){ const it=1-t; return { x: 3*it*it*(p1.x-p0.x) + 6*it*t*(p2.x-p1.x) + 3*t*t*(p3.x-p2.x),
                                                             y: 3*it*it*(p1.y-p0.y) + 6*it*t*(p2.y-p1.y) + 3*t*t*(p3.y-p2.y) }; }
const easeInOutCubic = t => t<0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;

function flyShipTo(targetX, targetY, onArrive, theme){
  ensureShip();
  const p0 = { x: ship.x, y: ship.y }, p3 = { x: targetX, y: targetY };
  const dx = p3.x - p0.x, dy = p3.y - p0.y, dist = Math.hypot(dx, dy);
  const arc = dist * CONFIG.SHIP.ARC_HEIGHT;
  const midx = (p0.x + p3.x)/2, midy = (p0.y + p3.y)/2;
  const nx = -dy/(dist||1), ny = dx/(dist||1);
  const p1 = { x: midx + nx*arc, y: midy + ny*arc };
  const p2 = { x: midx + nx*arc, y: midy + ny*arc };

  ship.path = { p0,p1,p2,p3 }; ship.t0 = performance.now(); ship.dur = CONFIG.SHIP.FLIGHT_MS;
  ship.moving = true; ship.onArrive = onArrive || null;

  try { shootSfx.currentTime = 0; shootSfx.play(); } catch {}
  if (!reduceMotion) warpTarget = Math.max(warpTarget, 0.08);

  const ttheme = theme || pickWarpTheme(true);
  warpOverlay.classList.remove("theme-cyan","theme-violet","theme-magma","theme-emerald","pulse");
  warpOverlay.classList.add(ttheme);
  setStarTintFromTheme(ttheme);
  if (CONFIG.WARP.USE_PULSE) warpOverlay.classList.add("pulse");

  window.updateShip3D?.({ engineOn: true });
}
function updateShip(){
  if (!ship.moving || !ship.path) return;
  const t = Math.min(1, (performance.now() - ship.t0) / ship.dur);
  const et = easeInOutCubic(t);

  const p = cubic(ship.path.p0, ship.path.p1, ship.path.p2, ship.path.p3, et);
  const tg = cubicTangent(ship.path.p0, ship.path.p1, ship.path.p2, ship.path.p3, et);
  const angle = Math.atan2(tg.y, tg.x) * 180 / Math.PI;

  const scale = 1 - (1 - CONFIG.SHIP.LAND_SCALE) * et;
  placeShipAt(p.x, p.y, angle, scale);

  if (t >= 1){
    ship.moving = false;
    window.updateShip3D?.({ engineOn: false, scale: CONFIG.SHIP.LAND_SCALE });
    if (!reduceMotion) warpTarget = 0.22;
    cam.tx = ship.x - width/2; cam.ty = ship.y - height/2; cam.ts = CONFIG.CAMERA.ZOOM; cam.active = true;
    const arrive = ship.onArrive; ship.onArrive = null;
    cam.onArrive = () => { if (typeof arrive === "function") arrive(); };
  }
}

// ========================== LANDING OVERLAY ==========================
let landing;
function ensureLanding(){
  if (landing) return;
  landing = document.createElement("div");
  landing.id = "landing"; landing.hidden = true;
  landing.innerHTML = `
    <div class="landing__bg"></div>
    <div class="landing__panel">
      <button class="landing__close" aria-label="Close">Back to orbit</button>
      <h2 id="landing-title"></h2>
      <div id="landing-body"></div>
    </div>`;
  document.body.appendChild(landing);
  landing.querySelector(".landing__close").addEventListener("click", () => { landing.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && landing && !landing.hidden) landing.hidden = true; });
}
function setLandingBackgroundByPlanet(t){
  ensureLanding();
  const bgEl = landing.querySelector(".landing__bg");
  const glow = t?.planet?.glow || "#9fc7ff";
  const base = t?.planet?.base || "#0c1220";
  const shade = t?.planet?.shade || "#060a14";
  bgEl.style.background = `radial-gradient(900px 600px at 25% 20%, ${glow}33 0%, ${base} 35%, ${shade} 70%, #000 100%)`;
}

function refreshSkillBars(){
  const bars = landing?.querySelectorAll?.(".skill__fill");
  if (!bars || !bars.length) return;
  bars.forEach(b => {
    b.style.animation = "none";
    void b.offsetHeight;
    b.style.animation = "";
  });
}

function openLanding(title, html){
  ensureLanding();
  landing.querySelector("#landing-title").textContent = title;
  landing.querySelector("#landing-body").innerHTML = html;
  landing.hidden = false;
  if (landing.querySelector("#contact-form")) bindContactForm();
  if (landing.querySelector(".skills")) refreshSkillBars();
}

// ========================== INPUT ==========================
// Mouse move → coalesced into RAF via setting targets only
let _pendingMouse = null;
function noteInput(){ lastInputAt = performance.now(); autopilotLock = false; }
document.addEventListener("mousemove", (e) => {
  _pendingMouse = { x: e.clientX, y: e.clientY };
  noteInput();
}, { passive: true });

ui.addEventListener("click", (e) => {
  if (cam.active || cam.arriving || ship.moving) return;
  const r = ui.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  for (const t of TARGETS) {
    const tx = toPx(t.px, width), ty = toPx(t.py, height), rr = t.r;
    if (Math.hypot(x - tx, y - ty) <= rr) {
      const ring = document.createElement("div");
      ring.className = "flash"; ring.style.left = tx + "px"; ring.style.top = ty + "px";
      stage.appendChild(ring); ring.addEventListener("animationend", () => ring.remove(), { once: true });
      const theme = t.warp || pickWarpTheme(true);
      flyShipTo(tx, ty, () => { setLandingBackgroundByPlanet(t); t.action(); }, theme);
      return;
    }
  }
  noteInput();
}, { passive: true });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || cam.active || cam.arriving || ship.moving) return;
  if (lastHoveredIndex < 0) return;
  const t = TARGETS[lastHoveredIndex];
  const tx = toPx(t.px, width), ty = toPx(t.py, height);
  const ring = document.createElement("div");
  ring.className = "flash"; ring.style.left = tx + "px"; ring.style.top = ty + "px";
  stage.appendChild(ring); ring.addEventListener("animationend", () => ring.remove(), { once: true });
  const theme = t.warp || pickWarpTheme(true);
  flyShipTo(tx, ty, () => { setLandingBackgroundByPlanet(t); t.action(); }, theme);
  noteInput();
});

// ========================== AUTOPILOT ==========================
function maybeAutopilot(){
  if (ship.moving || cam.active || cam.arriving || autopilotLock) return;
  if (performance.now() - lastInputAt < CONFIG.AUTOPILOT_IDLE_MS) return;
  const t = TARGETS[Math.floor(Math.random()*TARGETS.length)];
  const tx = toPx(t.px, width), ty = toPx(t.py, height);
  const ang = Math.random()*Math.PI*2, offset = t.r * (1.3 + Math.random()*0.6);
  const px = tx + Math.cos(ang)*offset, py = ty + Math.sin(ang)*offset;
  autopilotLock = true;
  flyShipTo(px, py, () => { setLandingBackgroundByPlanet(t); if (typeof t.action === "function") t.action(); }, t.warp || pickWarpTheme(true));
}

// ========================== LOOP ==========================
// ADD: ultra-light jank detector -> toggles LOW_END & lowers star density
let _jankCount = 0, _frames = 0;
function adaptQuality(dt){
  _frames++;
  if (dt > 32) _jankCount++;                 // ~ <30fps frame
  if (_frames >= 120){                       // check every ~2s
    const ratio = _jankCount / _frames;
    if (!LOW_END && ratio > 0.2){            // many slow frames → lower quality
      LOW_END = true;
      document.documentElement.classList.add("low-end");
      STAR_STEP = 2;                         // draw every 2nd star
    } else if (LOW_END && ratio < 0.06){     // recover
      LOW_END = false;
      document.documentElement.classList.remove("low-end");
      STAR_STEP = 1;
    }
    _jankCount = 0; _frames = 0;
  }
}

let _lastTs = performance.now();
function loop(){
  const now = performance.now();
  const dt = now - _lastTs; _lastTs = now;

  // apply coalesced mouse update here (1x per frame)
  if (_pendingMouse){
    mouseX = _pendingMouse.x; mouseY = _pendingMouse.y;
    _pendingMouse = null;
    if (!ship.moving) aimShipTowards(mouseX, mouseY);
  }

  renderStars();
  updateCam();
  updateShip();
  drawUI();
  maybeAutopilot();

  adaptQuality(dt); // PATCH: adaptive perf

  requestAnimationFrame(loop);
}
ensureLanding();
loop();

// Safer, cooler warp on start (cyan/violet bias)
startBtn?.addEventListener("click", async () => {
  try {
    await shootSfx.play();
    shootSfx.pause();
    shootSfx.currentTime = 0;
  } catch {}

  startBgMusic(); // 🔊 fade-in music here
  startWarp(pickWarpTheme(true));
});


// Auto-start intro (if enabled) with cool theme
if (APP_OPTS.autoStartIntroMs) {
  setTimeout(() => {
    const introVisible = getComputedStyle(intro).display !== "none";
    const stageHidden = stage.hasAttribute("hidden");
    if (introVisible && stageHidden) {
      startWarp(pickWarpTheme(true));
    }
  }, APP_OPTS.autoStartIntroMs);
}

// ADD: pause heavy work when tab hidden (lower warp target & star density)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden"){
    warpTarget = CONFIG.STARS.IDLE_SPEED;
    STAR_STEP = 3;
  } else {
    STAR_STEP = LOW_END ? 2 : 1;
  }
}, { passive: true });
