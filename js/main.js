// ========================== ELEMENTS ==========================
const bg = document.getElementById("bg-canvas");
const bctx = bg.getContext("2d", { alpha: false });

const stage = document.getElementById("stage");
const ui = document.getElementById("fps-canvas");
const uictx = ui.getContext("2d");

const intro = document.getElementById("intro");
const warpOverlay = document.getElementById("warp");
const startBtn = document.getElementById("start-button");
const shootSfx = document.getElementById("sfx-shoot");

// Site data (skills, links, etc.)
const SITE = (() => { try { return JSON.parse(document.getElementById("site-data")?.textContent || "{}"); } catch { return {}; } })();
const APP_OPTS = window.APP_OPTS || {};

// ========================== CONFIG / STATE ==========================
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CONFIG = {
  STARS: { COUNT: 420, IDLE_SPEED: 0.0, CRUISE_SPEED: reduceMotion ? 0.002 : 0.006, WARP_SPEED: reduceMotion ? 0.12 : 0.28, METEOR_PROB: 0.001, METEOR_MAX: 1 },
  CAMERA: { ZOOM: reduceMotion ? 1.35 : 1.85, RETURN_DELAY: 180 },
  UI: { SHOW_CROSSHAIR: false },
  SHIP: { FLIGHT_MS: reduceMotion ? 500 : 900, ARC_HEIGHT: 0.18, LAND_SCALE: 0.55, ANGLE_OFFSET: 0 },
  AUTOPILOT_IDLE_MS: Infinity
};

// 3D ship state (Three.js only)
let ship = { x: 0, y: 0, angle: -90, moving: false, onArrive: null, path: null, t0: 0, dur: CONFIG.SHIP.FLIGHT_MS };

// DPI + input
let dpr = Math.max(1, window.devicePixelRatio || 1);
let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
let lastInputAt = performance.now(), autopilotLock = false;

// ========================== SIZING ==========================
function sizeCanvas(c) {
  const w = Math.floor(window.innerWidth), h = Math.floor(window.innerHeight);
  c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
  c.style.width = w + "px"; c.style.height = h + "px";
  c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}
function resizeAll() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  sizeCanvas(bg); sizeCanvas(ui);
  placeShipAt(ship.x || window.innerWidth/2, ship.y || window.innerHeight*0.86, ship.angle);
}
resizeAll();
addEventListener("resize", resizeAll);

// ========================== STARFIELD ==========================
let starSpeed = CONFIG.STARS.IDLE_SPEED;
let warpTarget = CONFIG.STARS.IDLE_SPEED;
const stars = Array.from({ length: CONFIG.STARS.COUNT }, () => spawnStar());
const meteors = [];

function spawnStar() {
  const w = innerWidth, h = innerHeight;
  return { x: (Math.random()-0.5)*w*2, y:(Math.random()-0.5)*h*2, base:0.15+Math.random()*0.35, a:0, ta:0, next:performance.now()+500+Math.random()*1500, twEnd:0 };
}
function spawnMeteor() {
  const w = innerWidth, h = innerHeight;
  const edges = ["top","right","bottom","left"][Math.floor(Math.random()*4)];
  let x, y, vx, vy; const speed = 3.5 + Math.random()*2.2;
  if (edges==="top"){ x=Math.random()*w; y=-20; vx=(Math.random()*2-1)*0.6; vy=speed; }
  if (edges==="bottom"){ x=Math.random()*w; y=h+20; vx=(Math.random()*2-1)*0.6; vy=-speed; }
  if (edges==="left"){ x=-20; y=Math.random()*h; vx=speed; vy=(Math.random()*2-1)*0.6; }
  if (edges==="right"){ x=w+20; y=Math.random()*h; vx=-speed; vy=(Math.random()*2-1)*0.6; }
  meteors.push({ x, y, vx, vy, life: 0, maxLife: 120 + Math.random()*100, len: 40 + Math.random()*60 });
}
function updateMeteors(ctx){
  const w = innerWidth, h = innerHeight;
  if (!reduceMotion && Math.random() < CONFIG.STARS.METEOR_PROB && meteors.length < CONFIG.STARS.METEOR_MAX) spawnMeteor();
  ctx.lineCap = "round";
  for (let i = meteors.length - 1; i >= 0; i--){
    const m = meteors[i];
    m.x += m.vx; m.y += m.vy; m.life++;
    const tailX = m.x - m.vx * (m.len / 10);
    const tailY = m.y - m.vy * (m.len / 10);
    const alpha = Math.max(0, 1 - m.life / m.maxLife);
    ctx.strokeStyle = `rgba(255,255,255,${0.55*alpha})`;
    ctx.lineWidth = Math.max(1, 1.8*alpha);
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tailX, tailY); ctx.stroke();
    if (m.life>m.maxLife || m.x<-120 || m.y<-120 || m.x>w+120 || m.y>h+120) meteors.splice(i,1);
  }
}
function renderStars() {
  const w = innerWidth, h = innerHeight;
  bctx.fillStyle = "#000"; bctx.fillRect(0, 0, w, h);
  const grd = bctx.createRadialGradient(w*0.2,h*0.15,0,w*0.5,h*0.5,Math.max(w,h));
  grd.addColorStop(0,"#0a0b12"); grd.addColorStop(0.6,"#06070d"); grd.addColorStop(1,"#000");
  bctx.fillStyle = grd; bctx.fillRect(0,0,w,h);

  starSpeed += (warpTarget - starSpeed) * 0.06;
  const cx = w/2, cy = h/2;
  const parallaxFactor = starSpeed > 0.02 ? 0.0006 : 0.00008;
  const parallaxX = (mouseX - cx) * parallaxFactor;
  const parallaxY = (mouseY - cy) * parallaxFactor;
  const now = performance.now();

  if (starSpeed < 0.01) {
    bctx.fillStyle = "#fff";
    for (const s of stars) {
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
    for (const s of stars) {
      s.x += s.x * starSpeed + parallaxX * 40;
      s.y += s.y * starSpeed + parallaxY * 40;
      if (s.x*s.x + s.y*s.y > (w*w + h*h)) Object.assign(s, spawnStar());
      const len = Math.min(18, 2 + starSpeed * 900);
      const brightness = Math.min(1, 0.3 + starSpeed * 40);
      bctx.strokeStyle = `rgba(255,255,255,${brightness})`;
      bctx.lineWidth = Math.max(1, starSpeed * 40);
      bctx.beginPath();
      bctx.moveTo(cx + s.x, cy + s.y);
      bctx.lineTo(cx + s.x - (s.x * starSpeed * len), cy + s.y - (s.y * starSpeed * len));
      bctx.stroke();
    }
  }
  updateMeteors(bctx);
}
function startWarp(theme="theme-cyan"){
  warpOverlay.classList.remove("theme-cyan","theme-violet","theme-magma","theme-emerald");
  if (theme) warpOverlay.classList.add(theme,"pulse");
  warpOverlay.hidden=false; warpOverlay.classList.add("active");
  warpTarget = CONFIG.STARS.WARP_SPEED;

  setTimeout(() => {
    intro.style.display = "none";
    stage.hidden = false;
    resizeAll();
    ensureShip();
    ensureShip3D();
  }, reduceMotion ? 0 : 700);

  setTimeout(() => {
    warpTarget = CONFIG.STARS.CRUISE_SPEED;
    warpOverlay.classList.remove("active","pulse");
    setTimeout(() => { warpOverlay.hidden = true; }, reduceMotion ? 0 : 300);
  }, reduceMotion ? 200 : 1600);
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
  resume: SITE.links?.resume || "assets/docs/Raymond-Van-der-Walt-Resume.pdf",
  github: SITE.links?.github || "https://github.com/",
  linkedin: SITE.links?.linkedin || "https://www.linkedin.com/",
  email: (SITE.links?.email && `mailto:${SITE.links.email}`) || (SITE.contact?.email && `mailto:${SITE.contact.email}`) || "mailto:raymond.vdwalt@gmail.com"
};

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

  const links = `
    <div class="link-row">
      <a class="link-btn" href="${LINKS.resume}" target="_blank" rel="noopener">📄 Resume</a>
      <a class="link-btn" href="${LINKS.github}" target="_blank" rel="noopener">🐙 GitHub</a>
      <a class="link-btn" href="${LINKS.linkedin}" target="_blank" rel="noopener">🔗 LinkedIn</a>
      <a class="link-btn" href="${LINKS.email}">✉️ Email</a>
    </div>`;
  return `<p>Here’s a snapshot of my current toolkit. I focus on cinematic UI and performance.</p><div class="skills">${groups}</div>${links}`;
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

// ---------- Case studies ----------
function caseStudyHTML(cs){
  const pills = (cs.tags||[]).map(t=>`<span class="pill">${t}</span>`).join("");
  const bullets = (cs.points||[]).map(b=>`<li>${b}</li>`).join("");
  const links = (cs.links||[]).map(l=>`<a class="link-btn" href="${l.href}" target="_blank" rel="noopener">${l.label}</a>`).join("");
  const hero = cs.hero ? `<img class="case__hero" src="${cs.hero}" alt="${cs.title} hero" onerror="this.style.display='none'">` : "";
  return `
    <article class="case">
      <div>${hero}</div>
      <div>
        <h3 class="case__title">${cs.title}</h3>
        <p class="case__summary">${cs.summary}</p>
        <div class="pills">${pills}</div>
        ${bullets ? `<ul class="case__bullets">${bullets}</ul>` : ""}
        ${links ? `<div class="link-row" style="margin-top:12px">${links}</div>` : ""}
      </div>
    </article>`;
}
const CASE_A = {
  title:"They Fear The Light — Mission HUD",
  summary:"Cinematic, moment-to-moment HUD for objectives, markers, and state transitions.",
  tags:["UE5","UMG/CommonUI","Blueprints","HUD"],
  points:[
    "Objective pipeline with timed beats and diegetic transitions.",
    "Marker system with distance-gated hints and screen-edge indicators.",
    "Budgeted animation curves + lightweight materials to stay 60fps+."
  ],
  hero:"assets/images/cases/tftl-hud.jpg",
  links:[]
};
const CASE_B = {
  title:"Will Tool MVP — Dynamic PDF Builder",
  summary:"React app that generates legally structured PDFs from smart forms.",
  tags:["React","TypeScript","PDF","Forms"],
  points:[
    "Composable question graph → schema-backed output.",
    "Autofill + validation + printer-friendly themes.",
    "Export pipeline with embedded signatures (prototype)."
  ],
  hero:"assets/images/cases/willtool.jpg",
  links:[]
};

// ---------- Contact ----------
const YEARS = Number(SITE.years) || 8;
const PROFILE_SRC =
  (typeof SITE.profile === "string" ? SITE.profile :
   SITE.profile?.photo || SITE.profile?.src) || "assets/images/profile.jpg";

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
    status.textContent = "Sending…";

    if (form["_hp"]?.value) { status.textContent = "Thanks!"; form.reset(); return; }

    if (!endpoint) {
      mailtoFallback();
      status.textContent = "Opening your email app…";
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
    }
  });
}

// ---------- About ----------
const aboutHTML = `
  <div class="about">
    <div class="about__avatar-wrap">
      <img
        class="about__avatar"
        src="${PROFILE_SRC}"
        alt="Portrait of Raymond Van Der Walt"
        onerror="this.parentElement.remove()"
      />
    </div>
    <div class="about__text">
      <p>
        I’m Raymond — a Frontend &amp; Game Developer who lives where UI meets
        gameplay. For <strong>${YEARS}+ years</strong> I’ve been building cinematic HUDs,
        moment-to-moment interactions, and performance-first web experiences
        with UE5, React, TypeScript, and Canvas/WebGL.
      </p>
      <p>
        My thing is making interfaces <em>feel</em> great: tuning timing, adding
        micro-feedback, and keeping frame time lean so polish doesn’t cost
        performance. I love collaborating with design, wiring UI to real game
        states, and shipping clean, maintainable systems.
      </p>
      <p><strong>Core stack:</strong> UE5 (Blueprints/CommonUI), React + TypeScript, Tailwind/CSS, Canvas/WebGL.</p>
      <p><strong>Highlights:</strong> Objective/HUD systems, animated markers, dynamic PDF tooling, mobile app foundations with Expo.</p>
      <ul class="about__bullets" style="margin:8px 0 0 18px; line-height:1.6">
        <li>Design-driven dev: prototype fast, iterate on feel, ship.</li>
        <li>Gameplay-aware UI: widgets that respond to signals and inputs.</li>
        <li>Perf focus: budgeted animations, memoized renders, lean shaders.</li>
        <li>Team fit: I speak both “design” and “engineering.”</li>
      </ul>
    </div>
  </div>
`;

// ---------- Projects ----------
const projectsHTML = `
  <ul style="margin:0; padding-left:18px; line-height:1.8">
    <li><strong>They Fear The Light — Mission HUD:</strong> Cinematic objective flow + markers (UE5).</li>
    <li><strong>Will Tool MVP:</strong> Dynamic forms + legal PDF output with smart autofill (React).</li>
    <li><strong>Common UI Menu Framework:</strong> Modular rotators + EnhancedInput (UE 5.6 C++).</li>
    <li><strong>Farmily:</strong> Expo app skeleton + payments integration plan.</li>
  </ul>
  <p style="margin-top:12px">Want the source or a live demo? <a href="${LINKS.email}">Email me</a>.</p>
`;

// ROOMS
const NAMES = ["Volara","Nyxus","Aurelia","Thal-3","Kairon","Xerith","Cindrix","Abyssium","Vespera","Solyn"];

let currentRoom = 0;
const ROOMS = [
  { targets: [
    { name: NAMES[0], px: 18, py: 26, r: 46, planet: PLANETS.amber,  label: "About Me",    action: () => openLanding("About Me", aboutHTML), warp: "theme-magma" },
    { name: NAMES[7], px: 47, py: 42, r: 36, planet: PLANETS.aqua,   label: "Projects",    action: () => openLanding("Projects", projectsHTML), warp: "theme-cyan" },
    { name: SKILLS_PLANET.name, px: 75, py: 68, r: SKILLS_PLANET.r, planet: SKILLS_PLANET.planet, label: SKILLS_PLANET.label, action: () => openLanding("Skills", renderSkillsHTML()), asteroids: SKILLS_PLANET.asteroids, warp: WARP_THEME[skillsCfg.palette || "violet"] || "theme-violet" },
    { name: NAMES[6], px: 78, py: 22, r: 40, planet: PLANETS.coral,  label: "Contact",     action: () => openLanding("Contact", CONTACT_HTML), warp: "theme-magma" },
    { name: NAMES[3], px: 42, py: 74, r: 40, planet: PLANETS.mint,   label: "Next Room →", action: () => setRoom(1), warp: "theme-emerald" },
  ]},
  { targets: [
    { name: NAMES[1], px:30, py:30, r:42, planet: PLANETS.aqua,  label:"Case Study A", action: () => openLanding("Case Study A", caseStudyHTML(CASE_A)), warp: "theme-cyan" },
    { name: NAMES[4], px:70, py:30, r:48, planet: PLANETS.coral, label:"Case Study B", action: () => openLanding("Case Study B", caseStudyHTML(CASE_B)), warp: "theme-magma" },
    { name: NAMES[2], px:50, py:80, r:40, planet: PLANETS.amber, label:"← Back",       action: () => setRoom(0), warp: "theme-magma" },
  ]},
];
let TARGETS = ROOMS[currentRoom].targets;

// ---------- image filename overrides (exact case) ----------
const FILE_OVERRIDE = {
  // Known special cases:
  abysium: "Abyssium", abyssium: "Abyssium",
  cindrix: "Cindrix",
  thal3: "Thal3",         // <<< your file is Thal3.png (no dash)
  orionisix: "Orionis-IX",
  // Capitalization for all names we use:
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
    img.onload = () => { planetCache.set(key, img); t.tex = img; ensureAsteroids(t); };
    img.onerror = () => {
      // procedural fallback
      const tex = makePlanetTexture(t.r, t.planet, t.name.split("").reduce((a,c)=>a+c.charCodeAt(0),0));
      planetCache.set(key, tex); t.tex = tex; ensureAsteroids(t);
    };
    const fname = FILE_OVERRIDE[key] || key; // exact filename (no .png)
    // >>> FIXED PATH to match your folder: assets/planets/*.png
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
    uictx.save(); uictx.translate(px, py); uictx.rotate(-0.22);
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

  uictx.font = "600 18px Segoe UI, sans-serif";
  let text = t.label, w = uictx.measureText(text).width;
  uictx.fillStyle = "#cfe1ff";
  uictx.fillText(text, px - w/2, py + r + 10);

  uictx.font = "14px Segoe UI, sans-serif";
  text = `· ${t.name}`;
  w = uictx.measureText(text).width;
  uictx.fillStyle = "#ffffff";
  uictx.fillText(text, px - w/2, py + r + 30);
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
  lastHoveredIndex = hoveredIdx;
}
function drawUI(){
  width  = ui.clientWidth  || innerWidth;
  height = ui.clientHeight || innerHeight;
  uictx.clearRect(0,0,width,height);
  uictx.save();
  uictx.translate(width/2, height/2);
  uictx.scale(cam.scale, cam.scale);
  uictx.translate(-width/2 - cam.x, -height/2 - cam.y);
  drawTargets();
  uictx.restore();
}

// ========================== CAMERA ==========================
let width = ui.clientWidth || innerWidth;
let height = ui.clientHeight || innerHeight;
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
    ship.x = innerWidth / 2;
    ship.y = innerHeight * 0.86;
    placeShipAt(ship.x, ship.y, ship.angle);
  }
}
function ensureShip3D(){
  const cvs = document.getElementById("ship3d");
  if (!cvs) return;
  if (window.initShip3D && !reduceMotion) {
    try {
      window.initShip3D("ship3d");
      // make sure the flame is visible once initialised
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
        x: x/(ui.clientWidth||innerWidth),
        y: y/(ui.clientHeight||innerHeight),
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

  if (theme){ warpOverlay.classList.remove("theme-cyan","theme-violet","theme-magma","theme-emerald"); warpOverlay.classList.add(theme,"pulse"); }
  // flame ON during the flight
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
function noteInput(){ lastInputAt = performance.now(); autopilotLock = false; }
document.addEventListener("mousemove", (e) => {
  mouseX = e.clientX; mouseY = e.clientY;
  if (!ship.moving) aimShipTowards(mouseX, mouseY);
  noteInput();
});
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
      const theme = t.warp || "theme-cyan";
      flyShipTo(tx, ty, () => { setLandingBackgroundByPlanet(t); t.action(); }, theme);
      return;
    }
  }
  noteInput();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || cam.active || cam.arriving || ship.moving) return;
  if (lastHoveredIndex < 0) return;
  const t = TARGETS[lastHoveredIndex];
  const tx = toPx(t.px, width), ty = toPx(t.py, height);
  const ring = document.createElement("div");
  ring.className = "flash"; ring.style.left = tx + "px"; ring.style.top = ty + "px";
  stage.appendChild(ring); ring.addEventListener("animationend", () => ring.remove(), { once: true });
  const theme = t.warp || "theme-cyan";
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
  flyShipTo(px, py, () => { setLandingBackgroundByPlanet(t); if (typeof t.action === "function") t.action(); }, t.warp || "theme-cyan");
}

// ========================== LOOP ==========================
function loop(){
  renderStars();
  updateCam();
  updateShip();
  drawUI();
  maybeAutopilot();
  requestAnimationFrame(loop);
}
ensureLanding();
loop();

startBtn.addEventListener("click", async () => {
  try { await shootSfx.play(); shootSfx.pause(); shootSfx.currentTime = 0; } catch {}
  const themes = ["theme-cyan","theme-violet","theme-magma","theme-emerald"];
  startWarp(themes[Math.floor(Math.random()*themes.length)]);
});

if (APP_OPTS.autoStartIntroMs) {
  setTimeout(() => {
    const introVisible = getComputedStyle(intro).display !== "none";
    const stageHidden = stage.hasAttribute("hidden");
    if (introVisible && stageHidden) {
      const themes = ["theme-cyan","theme-violet","theme-magma","theme-emerald"];
      startWarp(themes[Math.floor(Math.random()*themes.length)]);
    }
  }, APP_OPTS.autoStartIntroMs);
}
