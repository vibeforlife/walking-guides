// Oʻahu Walking Guide (Option C: scripts in /scripts)
let routes = [];
let packs = [];
let packFiles = {};
let selectedPackId = null;

let activeRouteIndex = 0;
let activeStopIndex = 0;
let activeCity = null;
let cityToRouteIndexes = new Map();

let walkMode = false;
let walkWatchId = null;
let lastAutoAdvanceAt = 0;
let lastGpsUiUpdateAt = 0;
let lastOffRouteToastAt = 0;

let arrivedStopIds = new Set();
// ---- Memories + Achievements ----
const LS_MEM = "stroll_memories_v1";
const LS_ACH = "stroll_achievements_v1";

function loadJson(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){ return fallback; }
}
function saveJson(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){}
}

function getMemories(){ return loadJson(LS_MEM, []); }
function setMemories(arr){ saveJson(LS_MEM, arr); updateMemUI(); }

function getAchievements(){ return loadJson(LS_ACH, {}); }
function setAchievement(id){
  const a = getAchievements();
  if(a[id]) return false;
  a[id] = {ts: Date.now()};
  saveJson(LS_ACH, a);
  return true;
}

function updateMemUI(){
  const pill = $("memPill");
  if(pill) pill.textContent = `${getMemories().length} saved`;
}

// ---- Ambient sound (fileless WebAudio) ----
let audioCtx = null;
let ambGain = null;
let ambNodes = [];
let ambOn = true;
let ambVol = 0.09;
let ambProfile = "auto"; // auto/city/ocean/market/nature/off
let isNarrating = false;

function ensureAudioCtx(){
  if(audioCtx) return audioCtx;
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    ambGain = audioCtx.createGain();
    ambGain.gain.value = 0;
    ambGain.connect(audioCtx.destination);
  }catch(e){}
  return audioCtx;
}

function stopAmbient(){
  try{
    ambNodes.forEach(n=>{ try{ n.stop && n.stop(); }catch(e){} try{ n.disconnect && n.disconnect(); }catch(e){} });
  }catch(e){}
  ambNodes = [];
}

function makeNoiseSource(){
  const ctx = ensureAudioCtx();
  if(!ctx) return null;
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i=0;i<bufferSize;i++){
    data[i] = (Math.random()*2-1) * 0.35;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

function startAmbient(profile){
  const ctx = ensureAudioCtx();
  if(!ctx || !ambGain) return;

  stopAmbient();

  // base noise
  const noise = makeNoiseSource();
  if(!noise) return;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 800;

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 40;

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.08;

  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 120;

  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);

  // ocean swell (very low sine)
  const swell = ctx.createOscillator();
  swell.type = "sine";
  swell.frequency.value = 55;
  const swellGain = ctx.createGain();
  swellGain.gain.value = 0;

  // market "chatter" bandpass
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1200;
  bp.Q.value = 0.8;
  const bpGain = ctx.createGain();
  bpGain.gain.value = 0;

  // nature birds-ish (higher resonance)
  const birdOsc = ctx.createOscillator();
  birdOsc.type = "triangle";
  birdOsc.frequency.value = 900;
  const birdGain = ctx.createGain();
  birdGain.gain.value = 0;

  const birdLfo = ctx.createOscillator();
  birdLfo.type = "sine";
  birdLfo.frequency.value = 0.35;
  const birdLfoGain = ctx.createGain();
  birdLfoGain.gain.value = 180;
  birdLfo.connect(birdLfoGain);
  birdLfoGain.connect(birdOsc.frequency);

  // Profile tuning
  if(profile === "city"){
    filter.frequency.value = 650;
  } else if(profile === "ocean"){
    filter.frequency.value = 420;
    swellGain.gain.value = 0.035;
  } else if(profile === "market"){
    filter.frequency.value = 850;
    bpGain.gain.value = 0.07;
  } else if(profile === "nature"){
    filter.frequency.value = 520;
    birdGain.gain.value = 0.03;
  }

  noise.connect(hp);
  hp.connect(filter);
  filter.connect(ambGain);

  // add profile layers
  noise.connect(bp);
  bp.connect(bpGain);
  bpGain.connect(ambGain);

  swell.connect(swellGain);
  swellGain.connect(ambGain);

  birdOsc.connect(birdGain);
  birdGain.connect(ambGain);

  // start nodes
  noise.start();
  lfo.start();
  swell.start();
  birdOsc.start();
  birdLfo.start();

  ambNodes = [noise, lfo, swell, birdOsc, birdLfo];

  applyAmbientGain();
}

function applyAmbientGain(){
  if(!ambGain) return;
  const base = (ambOn && ambProfile !== "off") ? ambVol : 0;
  const duck = isNarrating ? 0.25 : 1.0;
  const target = base * duck;
  try{
    const t = ensureAudioCtx().currentTime;
    ambGain.gain.cancelScheduledValues(t);
    ambGain.gain.setTargetAtTime(target, t, 0.18);
  }catch(e){
    ambGain.gain.value = target;
  }
  const pill = $("ambientPill");
  if(pill) pill.textContent = `vol: ${ambVol.toFixed(2)}` + (isNarrating ? " (duck)" : "");
}

function autoAmbientProfileForStop(stop){
  const tags = (stop.tags || []).map(t=>String(t).toLowerCase());
  if(tags.includes("food")) return "market";
  if(tags.includes("view") || tags.includes("nature")) return "ocean";
  if(tags.includes("industrial")) return "city";
  if(tags.includes("architecture")) return "city";
  return "city";
}

function refreshAmbientForActiveStop(){
  const stop = routes[activeRouteIndex]?.stops?.[activeStopIndex];
  if(!stop) return;
  const prof = (ambProfile === "auto") ? autoAmbientProfileForStop(stop) : ambProfile;
  startAmbient(prof);
}


function showToast(msg, ms=2600, action=null){
  const el = $("toast");
  const msgEl = $("toastMsg");
  const btn = $("toastBtn");
  if(!el || !msgEl || !btn) return;

  msgEl.textContent = msg;

  // Reset button
  btn.style.display = "none";
  btn.textContent = "Action";
  btn.onclick = null;

  if(action && action.label && typeof action.onClick === "function"){
    btn.textContent = action.label;
    btn.style.display = "inline-flex";
    btn.onclick = ()=>{
      try{ action.onClick(); }catch(e){}
      el.classList.remove("show");
    };
  }

  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=> el.classList.remove("show"), ms);
}

function recenterToRoute(){
  try{
    const r = routes[activeRouteIndex];
    if(!r) return;

    // If we have GPS, center on user (works online and offline modes)
    if(lastGeo && lastGeo.coords){
      const lat = lastGeo.coords.latitude;
      const lng = lastGeo.coords.longitude;
      if(offlineMapEnabled){
        renderOfflineMap();
        showToast("Centered on you.", 1600);
        return;
      }
      if(typeof map !== "undefined" && map){
        map.setView([lat, lng], Math.max(map.getZoom(), 15));
        showToast("Centered on you.", 1600);
        return;
      }
    }

    // Otherwise center to route bounds
    const line = (r.line || []).map(([lat,lng])=>[lat,lng]);
    if(line.length && typeof L !== "undefined" && typeof map !== "undefined" && map){
      map.fitBounds(L.latLngBounds(line), {padding:[20,20]});
      showToast("Centered on route.", 1600);
    } else {
      // Offline fallback just re-renders
      if(offlineMapEnabled) renderOfflineMap();
      showToast("Centered on route.", 1600);
    }
  }catch(e){}
}


function rememberLineForStop(stop){
  return extractRememberLine(stop.script || "");
}

function saveCurrentMoment(){
  const r = routes[activeRouteIndex];
  const stop = r?.stops?.[activeStopIndex];
  if(!stop) return;
  const mems = getMemories();
  const key = `${r.id}::${stop.id}`;
  if(mems.some(m=>m.key===key)){
    showToast("Already saved.", 1600);
    return;
  }
  mems.unshift({
    key,
    ts: Date.now(),
    city: r.city || "",
    country: r.country || "",
    routeId: r.id,
    routeName: r.name,
    stopId: stop.id,
    stopTitle: stop.title,
    quote: rememberLineForStop(stop)
  });
  setMemories(mems);
  showToast("Saved to Memories ✓", 1800);
  if(setAchievement("saved_memory_1")){
    showToast("Achievement: Saved a memory ✨", 2400);
  }
  // Multi-city achievement
  const cities = new Set(mems.map(m=>m.city).filter(Boolean));
  if(cities.size >= 2 && setAchievement("two_cities")){
    showToast("Achievement: Two cities explored 🌍", 2600);
  }
}

function openMemories(){
  const modal = $("memoriesModal");
  if(!modal) return;
  modal.classList.add("show");
  modal.setAttribute("aria-hidden","false");
  renderMemoriesList();
}
function closeMemories(){
  const modal = $("memoriesModal");
  if(!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden","true");
}

function renderMemoriesList(){
  const list = $("memoriesList");
  if(!list) return;
  const mems = getMemories();
  updateMemUI();
  if(mems.length === 0){
    list.innerHTML = `<div class="pill" style="box-shadow:none">No memories yet. Tap “★ Save moment” on a stop.</div>`;
    return;
  }

  list.innerHTML = mems.map(m=>{
    const when = new Date(m.ts).toLocaleString();
    const route = routes.find(r=>r.id===m.routeId);
    const stopIdx = route?.stops?.findIndex(s=>s.id===m.stopId) ?? -1;
    const thumb = route ? svgThumbForRouteStop(route, stopIdx) : "";
    return `
      <div style="border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:12px;background:rgba(0,0,0,.15)">
        <div class="memRow">
          <div class="memThumb" aria-hidden="true">${thumb}</div>
          <div style="flex:1">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <div style="font-weight:700">${m.stopTitle}</div>
              <div style="opacity:.7;font-size:12px">${when}</div>
            </div>
            <div style="opacity:.8;font-size:12px;margin-top:4px">${m.city} • ${m.routeName}</div>
            <div style="margin-top:8px;font-size:16px;line-height:1.4">“${m.quote || ""}”</div>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="secondary" data-jump="${m.key}" style="border-radius:999px;padding:6px 10px">Go</button>
              <button class="secondary" data-share="${m.key}" style="border-radius:999px;padding:6px 10px">Share</button>
              <button class="secondary" data-del="${m.key}" style="border-radius:999px;padding:6px 10px">Delete</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll("[data-jump]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.getAttribute("data-jump");
      jumpToMemory(key);
    });
  });
  list.querySelectorAll("[data-share]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.getAttribute("data-share");
      const mems = getMemories();
      const m = mems.find(x=>x.key===key);
      if(m) shareMemory(m);
    });
  });
  list.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.getAttribute("data-del");
      deleteMemory(key);
    });
  });
}

function jumpToMemory(key){
  const mems = getMemories();
  const m = mems.find(x=>x.key===key);
  if(!m) return;
  // Find route index by id
  const idx = routes.findIndex(r=>r.id===m.routeId);
  if(idx>=0){
    setRoute(idx);
    const si = routes[idx].stops.findIndex(s=>s.id===m.stopId);
    if(si>=0) setActiveStop(si, true);
  }
  closeMemories();
}

function deleteMemory(key){
  const mems = getMemories().filter(m=>m.key!==key);
  setMemories(mems);
  renderMemoriesList();
  showToast("Deleted.", 1400);
}

function clearMemories(){
  setMemories([]);
  renderMemoriesList();
  showToast("Memories cleared.", 1800);
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c=>({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    "\"":"&quot;",
    "'":"&#39;"
  }[c]));
}

function groupBy(arr, keyFn){
  const m = new Map();
  for(const x of arr){
    const k = keyFn(x);
    if(!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function generateSouvenirPack(){
  const mems = getMemories();
  if(mems.length === 0){
    showToast("Save a moment first.", 1800);
    return;
  }

  // Create printable HTML
  const grouped = groupBy(mems, m=>m.routeId);
  const now = new Date().toLocaleString();

  const sections = Array.from(grouped.entries()).map(([routeId, items])=>{
    const route = routes.find(r=>r.id===routeId);
    const routeName = route?.name || items[0]?.routeName || "Tour";
    const city = route?.city || items[0]?.city || "";
    const thumb = route ? svgThumbForRouteStop(route, -1) : "";

    const cards = items.map(m=>{
      return `
        <div class="card">
          <div class="meta">
            <div class="title">${escapeHtml(m.stopTitle)}</div>
            <div class="sub">${escapeHtml(city)} • ${escapeHtml(routeName)}</div>
          </div>
          <div class="quote">“${escapeHtml(m.quote)}”</div>
          <div class="when">${escapeHtml(new Date(m.ts).toLocaleString())}</div>
        </div>
      `;
    }).join("");

    return `
      <section class="section">
        <div class="sectionHeader">
          <div>
            <h2>${escapeHtml(routeName)}</h2>
            <div class="small">${escapeHtml(city)}</div>
          </div>
          <div class="thumb">${thumb}</div>
        </div>
        <div class="grid">${cards}</div>
      </section>
    `;
  }).join("");

  const doc = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Stroll Souvenir Pack</title>
    <style>
      @page { margin: 14mm; }
      body{
        font-family: ui-sans-serif, system-ui, -apple-system;
        color:#0F172A;
      }
      .cover{
        border: 2px solid rgba(15,23,42,.15);
        border-radius: 18px;
        padding: 18mm;
        margin-bottom: 10mm;
      }
      .brand{font-size:28px;font-weight:800;letter-spacing:.2px}
      .tag{margin-top:6px;font-size:16px;opacity:.8}
      .metaLine{margin-top:14px;font-size:12px;opacity:.75}
      .section{break-inside:avoid; margin-top: 10mm;}
      .sectionHeader{
        display:flex; justify-content:space-between; gap:12px; align-items:flex-start;
        border-bottom:1px solid rgba(15,23,42,.12);
        padding-bottom:6px;
      }
      h2{margin:0;font-size:18px}
      .small{font-size:12px;opacity:.7}
      .thumb{width:140px}
      .thumb svg{width:140px;height:90px}
      .grid{
        display:grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 10px;
      }
      .card{
        border:1px solid rgba(15,23,42,.12);
        border-radius: 14px;
        padding: 10px;
      }
      .title{font-weight:800}
      .sub{font-size:12px;opacity:.7;margin-top:2px}
      .quote{margin-top:10px;font-size:14px;line-height:1.35}
      .when{margin-top:10px;font-size:11px;opacity:.65}
      .printHint{
        position: fixed; top: 10px; right: 10px;
        font-size: 12px; padding: 8px 10px;
        border: 1px solid rgba(15,23,42,.15); border-radius: 999px;
        background: #fff;
      }
      @media print{
        .printHint{display:none}
      }
    </style>
  </head>
  <body>
    <div class="printHint">Press ⌘P / Ctrl+P → Save as PDF</div>
    <div class="cover">
      <div class="brand">Stroll Walking Guide</div>
      <div class="tag">Every place has a story</div>
      <div class="metaLine">Souvenir Pack • ${escapeHtml(now)} • ${mems.length} memories</div>
    </div>

    ${sections}
  </body>
  </html>
  `;

  const w = window.open("", "_blank");
  if(!w){
    showToast("Popup blocked—allow popups for PDF.", 2800);
    return;
  }
  w.document.open();
  w.document.write(doc);
  w.document.close();
  // One-tap: auto-open print dialog after render
  setTimeout(()=>{ try{ w.focus(); w.print(); }catch(e){} }, 600);
  showToast("Souvenir pack ready ✓", 1800);
}


async function exportMemories(){
  const mems = getMemories();
  const payload = JSON.stringify({schema:"stroll_memories_v1", exportedAt: new Date().toISOString(), memories: mems}, null, 2);
  try{
    await navigator.clipboard.writeText(payload);
    const pill = $("memExportPill");
    if(pill) pill.textContent = "Copied ✓";
    showToast("Copied export to clipboard.", 1700);
  }catch(e){
    const pill = $("memExportPill");
    if(pill) pill.textContent = "Copy failed";
    showToast("Couldn’t copy (browser blocked).", 2200);
  }
}


function extractRememberLine(text){
  if(!text) return "";
  const lines = text.split(/\n+/).map(l=>l.trim()).filter(Boolean);
  return lines.slice(-1)[0] || "";
}

function showArrival(stop){
  const card = $("arrivalCard");
  if(!card) return;
  $("arrivalTitle").textContent = stop.title;
  $("arrivalLine").textContent = extractRememberLine(stop.script || "");
  card.classList.add("show");
  handleTourCompleted();
  setTimeout(()=>card.classList.remove("show"), 2800);
}

function handleTourCompleted(){
  if(setAchievement("tour_complete_1")){
    showToast("Achievement: First walk completed 🎉", 2800);
  }
  if(!navigator.onLine && setAchievement("walked_offline")){
    showToast("Achievement: Walked offline 📴", 2800);
  }
}

function showCompletion(){

  const card = $("completionCard");
  if(!card) return;
  const r = routes[activeRouteIndex];
  $("completionStats").textContent = `You completed “${r.name}”.`;
  card.classList.add("show");
}

function haptic(){
  try{
    if(navigator.vibrate) navigator.vibrate([25,40,25]);
  }catch(e){}
}


function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = (d)=> d * Math.PI / 180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function setWalkPill(text, show=true){
  const el = $("walkPill");
  if(!el) return;
  el.style.display = show ? "inline-flex" : "none";
  el.textContent = text;
}

const PACK_PREFIX = "stroll-pack-";
function packCacheName(routeId){
  return `${PACK_PREFIX}${routeId}-v1`;
}

let map, poly, markers = new Map();
let audioEl = new Audio();
audioEl.preload = "auto";

let voices = [];
let isSpeaking=false, isPaused=false;

const scriptCache = new Map(); // stopId -> string

function $(id){ return document.getElementById(id); }
function setPulse(on){ $("pulse").classList.toggle("on", !!on); }
function setStatus(txt){ $("nowStatus").textContent = txt; setPulse(txt === "Playing" || txt === "Speaking"); }

function setOfflineReady(state){
  const el = $("offlineReadyPill");
  if(!el) return;
  el.textContent = state;
}

function setButtons(){
  $("btnStop").disabled = !(isSpeaking || isPaused);
  $("btnPause").disabled = !(isSpeaking || isPaused);
  $("btnPlay").textContent = (isSpeaking && isPaused) ? "▶ Resume" : "▶ Play";
}

function stopAll(){
  try{ audioEl.pause(); audioEl.currentTime = 0; audioEl.src = ""; }catch(e){}
  if("speechSynthesis" in window) window.speechSynthesis.cancel();
  isSpeaking=false; isPaused=false;
  setButtons(); setPulse(false);
}

function getSelectedVoice(){
  const idx = parseInt($("voiceSelect").value || "0", 10);
  return voices[idx] || null;
}

async function loadScriptText(stop){
  if(scriptCache.has(stop.id)) return scriptCache.get(stop.id);

  let text = "";
  if(stop.scriptFile){
    try{
      const res = await fetch(stop.scriptFile, {cache:"no-cache"});
      if(!res.ok) throw new Error("HTTP "+res.status);
      text = await res.text();
    } catch(e){
      text = "Narration failed to load. (scriptFile fetch error)";
    }
  } else if(stop.script){
    text = stop.script;
  } else {
    text = "";
  }

  text = (text || "").trim();
  scriptCache.set(stop.id, text);
  return text;
}

function speakTTS(text){
  stopAll();
  if(!("speechSynthesis" in window)){
    alert("Speech Synthesis not supported. Use offline pack audio.");
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  const v = getSelectedVoice(); if(v) u.voice = v;
  u.rate = parseFloat($("rateSelect").value || "1.0");
  u.onstart = ()=>{ isSpeaking=true; isPaused=false; setStatus("Speaking"); setButtons(); };
  u.onend   = ()=>{ isSpeaking=false; isPaused=false; setStatus("Done"); setButtons(); };
  u.onerror = ()=>{ isSpeaking=false; isPaused=false; setStatus("Error"); setButtons(); };
  window.speechSynthesis.speak(u);
}

async function playFromPack(stopId){
  const explicit = packFiles[stopId];
  const candidates = [];
  if(explicit) candidates.push(explicit);
  if(selectedPackId){
    candidates.push(`audio/${selectedPackId}/${stopId}.mp3`);
    candidates.push(`audio/${selectedPackId}/${stopId}.wav`);
  }
  for(const url of candidates){
    try{
      const r = await fetch(url, {method:"HEAD"});
      if(r.ok){
        stopAll();
        audioEl.src = url;
        await audioEl.play();
        return true;
      }
    } catch(e){}
  }
  return false;
}

async function playStop(stop){
  const mode = $("audioMode").value;

  if(mode !== "tts"){
    const ok = await playFromPack(stop.id);
    if(ok) return;

    if(mode === "pack"){
      alert("No offline audio file found for this stop. Switch Audio to Auto or TTS.");
      return;
    }
  }

  const text = await loadScriptText(stop);
  if(!text){
    alert("No narration text available for this stop.");
    return;
  }
  speakTTS(text);
}

function pauseResume(){
  if(isSpeaking && !isPaused){
    if(audioEl.src && !audioEl.paused) audioEl.pause();
    if("speechSynthesis" in window) window.speechSynthesis.pause();
    isPaused=true; setStatus("Paused"); setButtons();
  } else if(isSpeaking && isPaused){
    if(audioEl.src && audioEl.paused) audioEl.play();
    else if("speechSynthesis" in window) window.speechSynthesis.resume();
    isPaused=false; setStatus("Playing"); setButtons();
  }
}

audioEl.addEventListener("playing", ()=>{ isSpeaking=true; isPaused=false; setStatus("Playing"); setButtons(); });
audioEl.addEventListener("ended", ()=>{ isSpeaking=false; isPaused=false; setStatus("Done"); setButtons(); });
audioEl.addEventListener("pause", ()=>{ if(isSpeaking){ isPaused=true; setStatus("Paused"); setButtons(); } });

function haversineKm(a,b){
  const R=6371, toRad=x=>x*Math.PI/180;
  const dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
  const lat1=toRad(a[0]), lat2=toRad(b[0]);
  const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function approxRouteKm(line){
  let km=0; for(let i=1;i<line.length;i++) km += haversineKm(line[i-1], line[i]);
  return km;
}
function markerLabel(n){
  return L.divIcon({
    className: "",
    html: `<div style="width:30px;height:30px;border-radius:12px;display:grid;place-items:center;background:rgba(125,211,252,.18);border:1px solid rgba(125,211,252,.35);color:#e8eefc;font-weight:900;box-shadow:0 10px 25px rgba(0,0,0,.35)">${n}</div>`,
    iconSize:[30,30], iconAnchor:[15,15]
  });
}
function renderMapForRoute(r){
  if(poly) map.removeLayer(poly);
  markers.forEach(m=>map.removeLayer(m));
  markers=new Map();

  poly = L.polyline(r.line, {weight:5, opacity:0.9}).addTo(map);
  map.fitBounds(poly.getBounds(), {padding:[22,22]});

  r.stops.forEach((s, idx)=>{
    const m = L.marker([s.lat, s.lng], {icon: markerLabel(idx+1)})
      .addTo(map)
      .bindPopup(`<strong>${idx+1}. ${s.title}</strong><br/><span style="opacity:.85">${s.location}</span>`);
    markers.set(s.id, m);
  });
}

function renderStops(){
  const list = $("stopList");
  list.innerHTML = "";
  const r = routes[activeRouteIndex];
  const foodOnly = $("foodOnly").checked;

  r.stops.forEach((s, idx)=>{
    if(foodOnly && !s.cheapEats) return;
    const el = document.createElement("div");
    el.className = "stop";
    el.dataset.index = String(idx);
    el.innerHTML = `
      <div class="stop-top">
        <div class="num">${idx+1}</div>
        <div style="flex:1">
          <h3>${s.title}</h3>
          <div class="meta">${s.location}${s.walkFromPrevMin ? ` · ~${s.walkFromPrevMin} min` : ""}</div>
        </div>
      </div>
      <div class="chips">
        ${(s.tags||[]).slice(0,4).map(t=>`<span class="chip">${t}</span>`).join("")}
        ${s.cheapEats ? `<span class="chip food">🍽️ cheap eats</span>` : ``}
        ${s.tone === "serious" ? `<span class="chip serious">⚓ reflective</span>` : ``}
      </div>
      ${s.cheapEats ? `<div class="meta" style="margin-top:10px"><strong style="color:#e8eefc">Budget bites:</strong> ${(s.cheapEats.nearby||[]).join(" · ")}<br/><span style="opacity:.9">${s.cheapEats.budgetHint||""}</span></div>` : ``}
    `;
    el.addEventListener("click", ()=> setActiveStop(idx, true));
    list.appendChild(el);
  });

  [...document.querySelectorAll(".stop")].forEach(el=>{
    const idx = parseInt(el.dataset.index,10);
    el.classList.toggle("active", idx === activeStopIndex);
  });
}

async function setActiveStop(i, autoplay=false){
  activeStopIndex = Math.max(0, Math.min(routes[activeRouteIndex].stops.length-1, i));
  const s = routes[activeRouteIndex].stops[activeStopIndex];
  if(s) showArrival(s);

  [...document.querySelectorAll(".stop")].forEach(el=>{
    const idx = parseInt(el.dataset.index,10);
    el.classList.toggle("active", idx === activeStopIndex);
  });

  $("nowTitle").textContent = `${activeStopIndex+1}. ${s.title}`;
  $("etaHint").textContent = s.walkFromPrevMin ? `Walk from previous stop: ~${s.walkFromPrevMin} min` : "";
  setStatus("Loading…");
  setButtons();

  map.setView([s.lat, s.lng], 15, {animate:true});
  const m = markers.get(s.id); if(m) m.openPopup();

  const text = await loadScriptText(s);
  $("nowText").textContent = text || "No narration.";
  setStatus("Ready");

  if(autoplay) await playStop(s);
  if(offlineMapEnabled) renderOfflineMap();
  refreshAmbientForActiveStop();
}

function setRoute(idx){
  stopAll();
  activeRouteIndex = Math.max(0, Math.min(routes.length-1, idx));
  activeStopIndex = 0;
  const r = routes[activeRouteIndex];
  $("routeTitle").textContent = r.name;
  $("routeDesc").textContent = r.description;
  $("distancePill").textContent = `~${approxRouteKm(r.line).toFixed(1)} km`;
  renderMapForRoute(r);
  arrivedStopIds.clear();
  renderStops();
  if(offlineMapEnabled) renderOfflineMap();
  // Sync city/tour selectors
  const citySel = $("citySelect");
  if(citySel && r.city){ citySel.value = r.city; activeCity = r.city; }
  populateRouteSelectForCity();
  const routeSel = $("routeSelect");
  if(routeSel) routeSel.value = String(activeRouteIndex);
  updatePackUI();
  if(offlineMapEnabled) renderOfflineMap();
  setActiveStop(0, false);
}


function buildCityIndex(){
  cityToRouteIndexes = new Map();
  routes.forEach((r, idx)=>{
    const city = r.city || "Other";
    if(!cityToRouteIndexes.has(city)) cityToRouteIndexes.set(city, []);
    cityToRouteIndexes.get(city).push(idx);
  });
}

function populateCitySelect(){
  const input = $("citySearch");
  const list = $("cityList");
  if(!input || !list) return;

  list.innerHTML = "";
  const cities = Array.from(cityToRouteIndexes.keys()).sort((a,b)=>a.localeCompare(b));
  cities.forEach(city=>{
    const o=document.createElement("option");
    o.value = city;
    list.appendChild(o);
  });

  activeCity = routes[0]?.city || cities[0] || "Other";
  input.value = activeCity;

  input.addEventListener("change", ()=>{
    if(!cityToRouteIndexes.has(input.value)) return;
    activeCity = input.value;
    populateRouteSelectForCity();
    const idxs = cityToRouteIndexes.get(activeCity) || [0];
    setRoute(idxs[0]);
  });
}


async function getCurrentTourAssets(){
  const r = routes[activeRouteIndex];
  const assets = ["./", "./index.html", "./app.js", "./routes.json", "./sw.js"];
  // Add scripts for this tour
  (r.stops || []).forEach(s=>{
    if(s.scriptFile) assets.push("./" + s.scriptFile.replace(/^\.\//,""));
  });
  // Icons
  assets.push("./icons/icon-192.png","./icons/icon-512.png");
  return {routeId: r.id, assets};
}

async function isTourPackDownloaded(routeId){
  try{
    const cache = await caches.open(packCacheName(routeId));
    const keys = await cache.keys();
    return keys && keys.length > 0;
  }catch(e){ return false; }
}

async function updatePackUI(){
  const r = routes[activeRouteIndex];
  const pill = $("packPill");
  const prog = $("packProgress");
  const btnD = $("btnDownloadTour");
  const btnR = $("btnRemoveTour");
  if(!pill || !prog || !btnD || !btnR) return;

  if(!("caches" in window)){
    pill.textContent = "pack: not supported";
    btnD.disabled = true;
    btnR.disabled = true;
    return;
  }
  const has = await isTourPackDownloaded(r.id);
  pill.textContent = has ? `pack: ${r.name} ✓` : "pack: none";
  btnR.disabled = !has;
}

async function downloadCurrentTourPack(){
  const r = routes[activeRouteIndex];
  const prog = $("packProgress");
  if(prog) prog.textContent = "Preparing download…";

  const {routeId, assets} = await getCurrentTourAssets();
  const cache = await caches.open(packCacheName(routeId));

  let done = 0;
  for(const url of assets){
    try{
      await cache.add(url);
    }catch(e){
      // ignore individual failures (e.g., if a file path changes)
    }
    done++;
    if(prog) prog.textContent = `Downloading… ${done}/${assets.length}`;
  }
  if(prog) prog.textContent = "Offline pack ready ✓";
  await updatePackUI();
}

async function removeCurrentTourPack(){
  const r = routes[activeRouteIndex];
  const prog = $("packProgress");
  if(prog) prog.textContent = "Removing offline pack…";
  try{
    await caches.delete(packCacheName(r.id));
  }catch(e){}
  if(prog) prog.textContent = "Offline pack removed.";
  await updatePackUI();
}

function populateRouteSelectForCity(){
  const sel = $("routeSelect");
  sel.innerHTML = "";
  const idxs = cityToRouteIndexes.get(activeCity) || [];
  idxs.forEach((routeIdx)=>{
    const r = routes[routeIdx];
    const o=document.createElement("option");
    o.value = String(routeIdx);
    o.textContent = r.name;
    sel.appendChild(o);
  });
  sel.value = String(activeRouteIndex);
}

function populateRouteSelect(){
  // City-filtered route selector
  populateRouteSelectForCity();
  const sel = $("routeSelect");
  sel.addEventListener("change", ()=> setRoute(parseInt(sel.value,10)));
}


function populateVoices(){
  if(!("speechSynthesis" in window)) return;
  voices = window.speechSynthesis.getVoices() || [];
  const sel = $("voiceSelect");
  sel.innerHTML = "";
  voices.forEach((v,i)=>{
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  });
  // Prefer iOS voice "Samantha" (en-US) if available; otherwise fall back to first English voice
  const samantha = voices.findIndex(v => (v.name || "").toLowerCase().includes("samantha") && (v.lang || "").toLowerCase() === "en-us");
  const preferred = (samantha >= 0) ? samantha : voices.findIndex(v => /en/i.test(v.lang || ""));
  sel.value = String(Math.max(0, preferred));
}

async function loadPacks(){
  // Hide "Offline Pack only" unless we confirm a pack exists with files
  const packOpt = Array.from($("audioMode").options).find(o => o.value === "pack");
  if(packOpt) packOpt.hidden = true;

  try{
    const res = await fetch("./audio/packs.json", {cache:"no-cache"});
    if(!res.ok) throw new Error("packs.json HTTP " + res.status);

    const j = await res.json();
    packs = j.packs || [];
    const first = packs[0];

    const hasFiles = !!(first && first.files && Object.keys(first.files).length > 0);
    if(first && hasFiles){
      selectedPackId = first.packId;
      packFiles = first.files || {};
      $("offlinePill").textContent = `offline pack: ${selectedPackId} ✓`;
      if(packOpt) packOpt.hidden = false;
      return;
    }

    // No usable pack
    $("offlinePill").textContent = "offline pack: none (TTS fallback)";
    if(packOpt) packOpt.hidden = true;
    if($("audioMode").value === "pack") $("audioMode").value = "tts";
  } catch(e){
    $("offlinePill").textContent = "offline pack: none (TTS fallback)";
    if(packOpt) packOpt.hidden = true;
    if($("audioMode").value === "pack") $("audioMode").value = "tts";
  }
}


function toggleWalkMode(force){
  const want = (typeof force === "boolean") ? force : !walkMode;
  walkMode = want;

  const btn = $("btnWalk");
  if(btn) btn.textContent = walkMode ? "🚶 Walk Mode: ON" : "🚶 Walk Mode";

  if(!walkMode){
    if(walkWatchId !== null && navigator.geolocation){
      navigator.geolocation.clearWatch(walkWatchId);
      walkWatchId = null;
    }
    setWalkPill("walk: off", false);
    return;
  }

  // Start watching location
  if(!navigator.geolocation){
    setWalkPill("walk: no GPS", true);
    return;
  }

  setWalkPill("walk: seeking GPS…", true);

  const radius = parseInt(($("walkRadius")?.value || "60"), 10);
  const cooldown = parseInt(($("walkCooldown")?.value || "35"), 10) * 1000;

  walkWatchId = navigator.geolocation.watchPosition((pos)=>{
lastGeo = pos;

// Throttle UI heavy work (battery friendly)
const saver = !!$("batterySaver")?.checked;
const minMs = saver ? 8000 : 2000;
const nowUi = Date.now();
const doUi = (nowUi - lastGpsUiUpdateAt) > minMs;
if(doUi) lastGpsUiUpdateAt = nowUi;

if(doUi && offlineMapEnabled) renderOfflineMap();
  const r = routes[activeRouteIndex];
  const stops = (r.stops||[]);
  if(stops.length === 0) return;

  const radius = parseInt(($("walkRadius")?.value || "60"), 10);
  const cooldown = parseInt(($("walkCooldown")?.value || "35"), 10) * 1000;
  const targetMode = ($("walkTarget")?.value || "next");

  const current = stops[activeStopIndex];
  const nextIdx = Math.min(activeStopIndex + 1, stops.length - 1);
  const next = stops[nextIdx];

  // Choose which stop we're measuring toward
  const targetStop = (targetMode === "current") ? current : next;
  const targetIdx  = (targetMode === "current") ? activeStopIndex : nextIdx;

  if(!targetStop) return;

  const d = Math.round(haversineMeters(
    pos.coords.latitude, pos.coords.longitude,
    targetStop.lat, targetStop.lng
  ));

  const label = (targetMode === "current") ? "current" : "next";
  setWalkPill(`walk: ${d}m → ${label}`, true);

  const now = Date.now();

  // Arrival trigger
  if(d <= radius && (now - lastAutoAdvanceAt) > cooldown){
    // Prevent repeated triggers for the same stop (especially for 'current' mode)
    if(arrivedStopIds.has(targetStop.id)) return;

    arrivedStopIds.add(targetStop.id);
    lastAutoAdvanceAt = now;
    haptic();
    showToast(`Arrived: ${targetStop.title} ✓`);

    if(targetMode === "next" && targetIdx !== activeStopIndex){
      setActiveStop(targetIdx, true);
    }

    // Try to play; if blocked, user can tap Play
    playCurrent();
  }
}, (err)=>{
    setWalkPill("walk: GPS blocked", true);
  }, (()=>{
      const saver = !!$("batterySaver")?.checked;
      return {enableHighAccuracy: !saver, maximumAge: saver ? 30000 : 10000, timeout: 15000};
    })());
}

let offlineMapEnabled = false;
let lastGeo = null;
function equirectangularMeters(lat, lng, refLat, refLng){
  // Simple projection for small areas (good enough for city walks)
  const R = 6371000;
  const toRad = d=> d*Math.PI/180;
  const x = (toRad(lng - refLng)) * Math.cos(toRad((lat + refLat)/2)) * R;
  const y = (toRad(lat - refLat)) * R;
  return {x,y};
}

function distancePointToSegment(px, py, ax, ay, bx, by){
  const dx = bx - ax, dy = by - ay;
  if(dx === 0 && dy === 0) return Math.hypot(px-ax, py-ay);
  const t = ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy);
  const tt = Math.max(0, Math.min(1, t));
  const cx = ax + tt*dx, cy = ay + tt*dy;
  return Math.hypot(px-cx, py-cy);
}

function distancePointToPolylineMeters(lat, lng, poly){
  if(!poly || poly.length < 2) return Infinity;
  // Use first point as reference
  const ref = poly[0];
  const p = equirectangularMeters(lat, lng, ref.lat, ref.lng);
  let best = Infinity;
  for(let i=0;i<poly.length-1;i++){
    const a0 = equirectangularMeters(poly[i].lat, poly[i].lng, ref.lat, ref.lng);
    const b0 = equirectangularMeters(poly[i+1].lat, poly[i+1].lng, ref.lat, ref.lng);
    best = Math.min(best, distancePointToSegment(p.x,p.y,a0.x,a0.y,b0.x,b0.y));
  }
  return best;
}

function getWalkMps(){
  const v = parseFloat(($("walkSpeed")?.value || "1.4"));
  return isFinite(v) && v>0 ? v : 1.4;
}

function computeETAtoEndMeters(fromLat, fromLng){
  const r = routes[activeRouteIndex];
  const stops = r.stops || [];
  if(stops.length === 0) return 0;
  const nextIdx = Math.min(activeStopIndex+1, stops.length-1);
  let meters = 0;
  const next = stops[nextIdx];
  if(next){
    meters += haversineMeters(fromLat, fromLng, next.lat, next.lng);
  }
  // Sum remaining stop-to-stop distances
  for(let i=nextIdx;i<stops.length-1;i++){
    meters += haversineMeters(stops[i].lat, stops[i].lng, stops[i+1].lat, stops[i+1].lng);
  }
  return meters;
}


// --- ETA helpers ---
const DEFAULT_WALK_MPS = 1.4; // ~5 km/h

function computeETA(meters, mps=getWalkMps()){
  if(!meters || meters < 0) return "";
  const secs = Math.round(meters / mps);
  if(secs < 60) return `${secs}s`;
  const mins = Math.round(secs/60);
  return `${mins} min`;
}

function bearingDeg(lat1, lon1, lat2, lon2){
  const toRad = d=> d*Math.PI/180;
  const toDeg = r=> r*180/Math.PI;
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return (toDeg(Math.atan2(y,x))+360)%360;
}


function enableOfflineMap(enable){
  offlineMapEnabled = enable;
  const wrap = $("offlineMapWrap");
  if(!wrap) return;
  wrap.classList.toggle("show", !!enable);
  wrap.setAttribute("aria-hidden", enable ? "false" : "true");
  if(enable){
    renderOfflineMap();
  }
}

function projectPoints(points, pad=60){
  // points: [{lat,lng}]
  let minLat= 90, maxLat=-90, minLng=180, maxLng=-180;
  points.forEach(p=>{
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  });
  // Avoid divide-by-zero
  const latSpan = Math.max(1e-9, maxLat - minLat);
  const lngSpan = Math.max(1e-9, maxLng - minLng);

  const W=1000, H=650;
  const innerW = W - pad*2, innerH = H - pad*2;

  const proj = (lat,lng)=>{
    const x = pad + ((lng - minLng)/lngSpan) * innerW;
    const y = pad + ((maxLat - lat)/latSpan) * innerH;
    return {x,y};
  };

  return {proj, bounds:{minLat,maxLat,minLng,maxLng}};
}

function renderOfflineMap(){
  const svg = $("offlineMapSvg");
  if(!svg) return;
  const r = routes[activeRouteIndex];
  if(!r) return;

  const line = (r.line || []).map(([lat,lng])=>({lat, lng}));
  const stops = (r.stops || []).map(s=>({lat:s.lat, lng:s.lng, id:s.id, title:s.title}));

  const allPts = [...line, ...stops];
  if(allPts.length === 0){
    svg.innerHTML = "";
    return;
  }

  const {proj, bounds} = projectPoints(allPts);

  const linePts = line.map(p=>{ const q=proj(p.lat,p.lng); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(" ");
  const stopEls = stops.map((s, i)=>{
    const q = proj(s.lat,s.lng);
    const isActive = i === activeStopIndex;
    const r0 = isActive ? 16 : 12;
    const stroke = isActive ? "rgba(245,158,11,.95)" : "rgba(255,255,255,.55)";
    const fill = isActive ? "rgba(245,158,11,.35)" : "rgba(0,0,0,.20)";
    const labelFill = "rgba(255,255,255,.95)";
    return `
      <g class="stop" data-stop="${s.id}">
        <circle cx="${q.x}" cy="${q.y}" r="${r0}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <text x="${q.x}" y="${q.y+4}" text-anchor="middle" font-size="12" fill="${labelFill}" font-family="ui-sans-serif, system-ui">${i+1}</text>
      </g>
    `;
  }).join("");

  let arrow = "";
let etaLabel = "";

const userDot = (lastGeo && lastGeo.coords) ? (()=> {
    const q = proj(lastGeo.coords.latitude, lastGeo.coords.longitude);
    // Arrow + ETA toward next stop
const r = routes[activeRouteIndex];
const stops = r.stops || [];
const nextIdx = Math.min(activeStopIndex+1, stops.length-1);
const next = stops[nextIdx];

if(next){
  const d = Math.round(haversineMeters(
    lastGeo.coords.latitude, lastGeo.coords.longitude,
    next.lat, next.lng
  ));
  const eta = computeETA(d);
  const brg = bearingDeg(
    lastGeo.coords.latitude, lastGeo.coords.longitude,
    next.lat, next.lng
  );
  const arrowLen = 28;
  const rad = (brg-90) * Math.PI/180;
  const ax = q.x + Math.cos(rad)*arrowLen;
  const ay = q.y + Math.sin(rad)*arrowLen;
  arrow = `<line x1="${q.x}" y1="${q.y}" x2="${ax}" y2="${ay}"
             stroke="rgba(59,130,246,.9)" stroke-width="4" stroke-linecap="round"/>`;
  etaLabel = `<text x="${q.x}" y="${q.y-14}" text-anchor="middle"
               font-size="12" fill="rgba(255,255,255,.95)"
               font-family="ui-sans-serif, system-ui">
               ${eta} • end ${computeETA(computeETAtoEndMeters(lastGeo.coords.latitude, lastGeo.coords.longitude))}
              </text>`;
}

return `<circle id="userDot" cx="${q.x}" cy="${q.y}" r="8"
         fill="rgba(59,130,246,.75)"
         stroke="rgba(255,255,255,.7)" stroke-width="2"/>`;
  })() : "";

  svg.innerHTML = `
    <rect x="0" y="0" width="1000" height="650" fill="rgba(0,0,0,0)"/>
    <polyline points="${linePts}" fill="none" stroke="rgba(231,220,203,.85)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    ${stopEls}
    ${arrow}${etaLabel}${userDot}
  `;

  // Click stops in offline map to select
  svg.querySelectorAll("g.stop").forEach((g, idx)=>{
    g.style.cursor = "pointer";
    g.addEventListener("click", ()=>{
      setActiveStop(idx, true);
    });
  });
}

function setupControls(){
  $("foodOnly").addEventListener("change", renderStops);
  // Settings modal
const bs = $("btnSettings");
// Ambient controls (Settings)
const aOn = $("ambientOn");
const aVol = $("ambientVol");
const aProf = $("ambientProfile");
if(aOn) aOn.addEventListener("change", ()=>{ ambOn = !!aOn.checked; applyAmbientGain(); });
if(aVol) aVol.addEventListener("input", ()=>{ ambVol = parseFloat(aVol.value || "0.09"); applyAmbientGain(); });
if(aProf) aProf.addEventListener("change", ()=>{ ambProfile = aProf.value; refreshAmbientForActiveStop(); });

// Memories buttons (Settings)
const bm = $("btnOpenMemories");
if(bm) bm.addEventListener("click", openMemories);
const bclr = $("btnClearMemories");
if(bclr) bclr.addEventListener("click", clearMemories);
const bsp = $("btnSouvenirPdf");
if(bsp) bsp.addEventListener("click", generateSouvenirPack);

  if(bs) bs.addEventListener("click", openSettings);
  const bc = $("btnCloseSettings");
  if(bc) bc.addEventListener("click", closeSettings);
  const bd = $("btnDoneSettings");
  if(bd) bd.addEventListener("click", closeSettings);
  const backdrop = $("settingsBackdrop");
  if(backdrop) backdrop.addEventListener("click", (e)=>{ if(e.target === backdrop) closeSettings(); });
  $("btnPrev").addEventListener("click", ()=> setActiveStop(activeStopIndex-1, true));
  $("btnNext").addEventListener("click", ()=> setActiveStop(activeStopIndex+1, true));
  $("btnPlay").addEventListener("click", ()=>{
    const s = routes[activeRouteIndex].stops[activeStopIndex];
    if(isSpeaking && isPaused) return pauseResume();
    playStop(s);
  });
  $("btnPause").addEventListener("click", pauseResume);
  $("btnStop").addEventListener("click", ()=>{ stopAll(); setStatus("Stopped"); });

  window.addEventListener("keydown", (e)=>{
    if(e.target && e.target.tagName === "SELECT") return;
    if(e.code === "Space"){
      e.preventDefault();
      if(isSpeaking) pauseResume();
      else playStop(routes[activeRouteIndex].stops[activeStopIndex]);
    }
    if(e.key.toLowerCase()==="j") setActiveStop(activeStopIndex-1, true);
    if(e.key.toLowerCase()==="k") setActiveStop(activeStopIndex+1, true);
    if(e.key === "Escape") closeSettings();
    if(e.key.toLowerCase()==="s"){ stopAll(); setStatus("Stopped"); }
  });
}


function openSettings(){
  const b = $("settingsBackdrop");
  if(!b) return;
  b.classList.add("open");
  b.setAttribute("aria-hidden","false");
}
function closeSettings(){
  const b = $("settingsBackdrop");
  if(!b) return;
  b.classList.remove("open");
  b.setAttribute("aria-hidden","true");
}

function initMap(){
  map = L.map("map", {zoomControl:true}).setView([21.297,-157.848], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
}

async function boot(){
  initMap();
  setupControls();
  // Offline map fallback: show static route when offline
  enableOfflineMap(!navigator.onLine);
  window.addEventListener("offline", ()=> enableOfflineMap(true));
  window.addEventListener("online", ()=> enableOfflineMap(false));
  document.addEventListener("visibilitychange", ()=>{
    if(!walkMode) return;
    if(document.hidden){
      // reduce GPS usage when tab not visible
      try{ if(walkWatchId !== null) navigator.geolocation.clearWatch(walkWatchId); }catch(e){}
      walkWatchId = null;
      setWalkPill("walk: paused (background)", true);
    } else {
      // resume
      toggleWalkMode(true);
    }
  });

  // Offline indicator
  if ("serviceWorker" in navigator) {
    setOfflineReady(navigator.serviceWorker.controller ? "offline: ready ✓" : "offline: preparing…");
    navigator.serviceWorker.addEventListener("message", (evt) => {
      if (evt && evt.data && evt.data.type === "OFFLINE_READY") setOfflineReady("offline: ready ✓");
    });
  } else {
    setOfflineReady("offline: not supported");
  }

  try{
    const res = await fetch("./routes.json", {cache:"no-cache"});
    routes = await res.json();
  } catch(e){
    alert("Failed to load routes.json");
    return;
  }

  await loadPacks();
  buildCityIndex();
  populateCitySelect();
  populateRouteSelect();
  populateVoices();
  if("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = populateVoices;

  setRoute(0);
  updatePackUI();
}
boot();

function svgThumbForRouteStop(route, stopIdx){
  // returns inline SVG string
  const W=220, H=140, pad=14;
  const line = (route.line || []).map(([lat,lng])=>({lat, lng}));
  const stops = (route.stops || []).map(s=>({lat:s.lat, lng:s.lng}));

  const allPts = [...line, ...stops];
  if(allPts.length < 2){
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  // bounds
  let minLat= 90, maxLat=-90, minLng=180, maxLng=-180;
  for(const p of allPts){
    minLat=Math.min(minLat,p.lat); maxLat=Math.max(maxLat,p.lat);
    minLng=Math.min(minLng,p.lng); maxLng=Math.max(maxLng,p.lng);
  }
  const latSpan=Math.max(1e-9, maxLat-minLat);
  const lngSpan=Math.max(1e-9, maxLng-minLng);
  const innerW=W-pad*2, innerH=H-pad*2;
  const proj=(lat,lng)=>{
    const x=pad+((lng-minLng)/lngSpan)*innerW;
    const y=pad+((maxLat-lat)/latSpan)*innerH;
    return {x,y};
  };

  const pts = line.map(p=>{const q=proj(p.lat,p.lng);return `${q.x.toFixed(1)},${q.y.toFixed(1)}`}).join(" ");
  const stopDots = stops.map((s,i)=>{
    const q=proj(s.lat,s.lng);
    const active = i===stopIdx;
    const r = active ? 8 : 5;
    const stroke = active ? "rgba(245,158,11,.95)" : "rgba(255,255,255,.5)";
    const fill = active ? "rgba(245,158,11,.25)" : "rgba(0,0,0,.15)";
    return `<circle cx="${q.x}" cy="${q.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  }).join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" rx="16" ry="16" fill="rgba(15,23,42,.35)"/>
      <polyline points="${pts}" fill="none" stroke="rgba(231,220,203,.85)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      ${stopDots}
    </svg>
  `;
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines=6){
  const words = String(text || "").split(/\s+/);
  let line = "";
  let lines = [];
  for(const w of words){
    const test = line ? (line + " " + w) : w;
    if(ctx.measureText(test).width > maxWidth && line){
      lines.push(line);
      line = w;
      if(lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if(lines.length < maxLines && line) lines.push(line);
  return lines.map((l,i)=> (ctx.fillText(l, x, y + i*lineHeight), l));
}

async function makeMemoryCardPng(memory){
  const size = 1080;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");

  // Background
  ctx.fillStyle = "#0F172A";
  ctx.fillRect(0,0,size,size);

  // Soft gradient
  const g = ctx.createLinearGradient(0,0,0,size);
  g.addColorStop(0, "rgba(255,255,255,.06)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,size,size);

  // Card border
  const pad = 84;
  const r = 44;
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 4;
  roundRect(ctx, pad, pad, size-pad*2, size-pad*2, r);
  ctx.stroke();

  // Title
  ctx.fillStyle = "rgba(248,250,252,.96)";
  ctx.font = "700 64px ui-sans-serif, system-ui, -apple-system";
  ctx.fillText(memory.stopTitle || "A moment", pad+56, pad+128);

  // Meta
  ctx.fillStyle = "rgba(248,250,252,.72)";
  ctx.font = "500 34px ui-sans-serif, system-ui, -apple-system";
  const meta = [memory.city, memory.routeName].filter(Boolean).join(" • ");
  ctx.fillText(meta, pad+56, pad+182);

  // Quote
  ctx.fillStyle = "rgba(231,220,203,.96)";
  ctx.font = "600 50px ui-sans-serif, system-ui, -apple-system";
  const quote = memory.quote ? `“${memory.quote}”` : "“Every place has a story.”";
  wrapText(ctx, quote, pad+56, pad+300, size-pad*2-112, 70, 6);

  // Footer brand
  ctx.fillStyle = "rgba(248,250,252,.62)";
  ctx.font = "600 34px ui-sans-serif, system-ui, -apple-system";
  ctx.fillText("Stroll Walking Guide", pad+56, size-pad-84);
  ctx.fillStyle = "rgba(248,250,252,.45)";
  ctx.font = "500 30px ui-sans-serif, system-ui, -apple-system";
  ctx.fillText("Every place has a story", pad+56, size-pad-42);

  return await new Promise(resolve=> c.toBlob(resolve, "image/png"));
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

async function shareMemory(memory){
  try{
    const blob = await makeMemoryCardPng(memory);
    if(!blob){ showToast("Couldn’t generate image.", 2000); return; }
    const file = new File([blob], "stroll-memory.png", {type:"image/png"});

    if(navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({
        title: "Stroll Memory",
        text: `${memory.stopTitle} — ${memory.city || ""}`,
        files: [file]
      });
      showToast("Shared ✓", 1600);
      return;
    }

    // Fallback: download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stroll-memory.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
    showToast("Downloaded image ✓", 1900);
  }catch(e){
    showToast("Share canceled.", 1600);
  }
}
