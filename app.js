// Axcel phone recorder.
//
// The phone stores two things and only two things: the raw BLE byte stream,
// verbatim, and the per-set labels a human typed. Everything else on screen is
// decoded for display and thrown away -- host/protocol.py re-derives the real
// answer from the bytes later. See phone/decode.js.
//
// Raw chunks go to IndexedDB as they arrive rather than to an array in memory,
// because the failure that actually costs a session is a silently lost
// recording, and a reloaded tab should not be able to cause one.

import { Decoder, EV_SET_START, EV_SET_END_BUTTON, EV_SET_END_IDLE } from './decode.js';
import { EXERCISES } from './exercises.js';
import { MIN_STATIC_S } from './thresholds.js';

// The importer keeps this much of the stream before the set event, so stillness
// held before pressing the button is in the recording and counts.
const PRE_ROLL_S = 3.0;
import { StillnessTracker } from './stillness.js';

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const DEVICE_NAME = 'Axcel';

const TRACE_S = 8;
const NOMINAL_HZ = 109;   // display only; real rate comes from the timestamps
const REDRAW_MS = 80;     // ~12 fps is plenty and keeps the BLE callback cheap

const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------- storage

const DB_NAME = 'axcel';
let db = null;

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { autoIncrement: true });
      if (!d.objectStoreNames.contains('sets')) d.createObjectStore('sets', { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function put(store, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).add(value);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

function all(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const q = tx.objectStore(store).getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

function clearAll() {
  return new Promise((res, rej) => {
    const tx = db.transaction(['chunks', 'sets'], 'readwrite');
    tx.objectStore('chunks').clear();
    tx.objectStore('sets').clear();
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

// -------------------------------------------------------------------- state

const dec = new Decoder();
const state = {
  device: null,
  recording: false,
  setStartUs: null,
  pending: null,          // {start_t_us, end_t_us, samples, still_s}
  sets: [],
  trace: [],              // {t_us, mag}
  lastAccel: null,
  battery: null,
  rxBytes: 0,
  rateWindow: [],
  wakeLock: null,
  setCounter: 1,
};

// ------------------------------------------------------------------ helpers

function fmtBattery(b) {
  if (!b) return '';
  if (!b.valid) return 'battery n/a';
  const v = (b.mv / 1000).toFixed(2);
  // Bands mirror host/protocol.py BATTERY_BANDS. Volts and a band, never a
  // percentage -- see docs/decisions.md 027.
  const band = b.mv >= 3850 ? 'good' : b.mv >= 3700 ? 'ok' : b.mv >= 3550 ? 'low' : 'charge me';
  return `${v} V ${band}${b.charging ? ' ⚡' : ''}`;
}

const still = new StillnessTracker();

// -------------------------------------------------------------------- BLE

async function connect() {
  if (!navigator.bluetooth) {
    alert('This browser has no Web Bluetooth. Use Chrome on Android.');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }],
      optionalServices: [NUS_SERVICE],
    });
    state.device = device;
    device.addEventListener('gattserverdisconnected', onDisconnected);
    await attach(device);
  } catch (err) {
    if (err.name !== 'NotFoundError') setLink('error: ' + err.message, 'bad');
  }
}

async function attach(device) {
  setLink('connecting…');
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(NUS_SERVICE);
  const tx = await svc.getCharacteristic(NUS_TX);
  await tx.startNotifications();
  tx.addEventListener('characteristicvaluechanged', onData);
  setLink('connected', 'on');
  requestWakeLock();
}

function onDisconnected() {
  setLink('disconnected', 'bad');
  // Reconnect rather than sit dead. The phone is in a pocket; a dropout that
  // needs a human to notice is a lost set.
  if (state.device) {
    setTimeout(() => attach(state.device).catch(() => setLink('reconnecting…', 'bad')), 1200);
  }
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not fatal; the screen may just sleep */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.device?.gatt?.connected) requestWakeLock();
});

// ------------------------------------------------------------------ ingest

function onData(ev) {
  ingest(new Uint8Array(ev.target.value.buffer.slice(0)), true);
}

function ingest(bytes, persist) {
  state.rxBytes += bytes.length;

  // Store the raw bytes FIRST, before anything below can throw. Display is
  // optional; the recording is not.
  if (persist) put('chunks', bytes).catch((e) => console.error('IndexedDB write failed', e));

  for (const item of dec.feed(bytes)) {
    if (item.kind === 'samples') onSamples(item);
    else if (item.kind === 'event') onEvent(item);
    else if (item.kind === 'battery') state.battery = item;
  }
}

/**
 * ?replay -- drive the whole display path from a recorded fixture, so the UI
 * can be checked without the device present. Nothing is persisted. The fixture
 * is imported dynamically and is not in the service worker's cache list, so it
 * never ships to the phone in normal use.
 */
async function startReplay() {
  let STREAM_B64;
  try {
    ({ STREAM_B64 } = await import('./fixture.js'));
  } catch {
    // The fixture is real captured data and stays in the private repo, so it is
    // absent from a published build. Replay is a development aid, not a feature.
    setLink('no replay fixture in this build', 'bad');
    return;
  }
  const bytes = Uint8Array.from(atob(STREAM_B64), (c) => c.charCodeAt(0));
  setLink('replay', 'on');
  let i = 0;
  (function pump() {
    if (i >= bytes.length) { setLink('replay finished', 'on'); return; }
    const step = 220;
    ingest(bytes.subarray(i, Math.min(i + step, bytes.length)), false);
    i += step;
    setTimeout(pump, 12);
  })();
}

function onSamples(pkt) {
  const n = pkt.rows.length;
  for (let i = 0; i < n; i++) {
    const t = pkt.t_us - (n - 1 - i) * pkt.period_us;
    const r = pkt.rows[i];
    const a = [r[3], r[4], r[5]];
    const g = [r[0], r[1], r[2]];
    state.lastAccel = a;
    state.trace.push({ t_us: t, mag: Math.hypot(a[0], a[1], a[2]) });
    still.push(t, a, g);
  }
  const traceCut = pkt.t_us - TRACE_S * 1e6;
  while (state.trace.length && state.trace[0].t_us < traceCut) state.trace.shift();

  state.rateWindow.push([performance.now(), n]);
  const cut = performance.now() - 2000;
  while (state.rateWindow.length && state.rateWindow[0][0] < cut) state.rateWindow.shift();
}

function onEvent(ev) {
  if (ev.code === EV_SET_START) {
    state.recording = true;
    state.setStartUs = ev.t_us;
    state.samplesAtStart = dec.stats.samples;
    $('state').textContent = 'RECORDING';
    setLink('connected', 'rec');
  } else if ((ev.code === EV_SET_END_BUTTON || ev.code === EV_SET_END_IDLE) && state.recording) {
    state.recording = false;
    setLink('connected', 'on');
    state.pending = {
      start_t_us: state.setStartUs,
      end_t_us: ev.t_us,
      samples: dec.stats.samples - (state.samplesAtStart || 0),
      duration_s: (ev.t_us - state.setStartUs) / 1e6,
      end_reason: ev.code === EV_SET_END_BUTTON ? 'button' : 'idle',
      // The question find_static_block asks: was there a usable still stretch
      // anywhere in what gets saved, pre-roll included. Emphatically NOT "were
      // you still the instant the set started" -- SET_START fires ~150 ms after
      // the button is released, so that instant always contains the press.
      still_best_s: Math.round(
        still.longestRunIn(state.setStartUs - PRE_ROLL_S * 1e6, ev.t_us) * 100) / 100,
    };
    state.pending.still_ok = state.pending.still_best_s >= MIN_STATIC_S;
    openForm();
  }
}

// -------------------------------------------------------------------- form

function openForm() {
  const p = state.pending;
  $('form').classList.remove('hidden');
  $('state').textContent = 'set finished';
  $('f-set').value = state.setCounter;
  $('f-reps').value = '';
  $('f-rir').value = '';
  $('f-note').value = '';
  const warn = p.still_ok === false
    ? `  ⚠ LONGEST STILL STRETCH ${p.still_best_s}s (need ${MIN_STATIC_S}s) — `
      + 'this set may not be analysable'
    : '';
  $('f-summary').textContent =
    `${p.duration_s.toFixed(0)} s · ${p.samples} samples · ended by ${p.end_reason}${warn}`;
  $('f-summary').className = warn ? 'small' : 'dim small';
  if (warn) $('f-summary').style.color = 'var(--bad)'; else $('f-summary').style.color = '';
  $('f-exercise').focus();
}

async function saveSet() {
  const exercise = $('f-exercise').value.trim();
  if (!exercise) { alert('Which exercise?'); return; }
  const num = (el) => (el.value.trim() === '' ? null : Number(el.value));
  const rec = {
    ...state.pending,
    exercise,
    load: num($('f-load')),
    unit: $('f-unit').value,
    set_number: num($('f-set')) ?? state.setCounter,
    reps: num($('f-reps')),
    rir: num($('f-rir')),
    note: $('f-note').value.trim(),
    saved_at: new Date().toISOString(),
  };
  await put('sets', rec);
  state.sets.push(rec);
  state.setCounter = (rec.set_number || 0) + 1;
  state.pending = null;
  $('form').classList.add('hidden');
  $('state').textContent = 'press the device button to start a set';
  renderSets();
}

function renderSets() {
  const ol = $('sets');
  if (!state.sets.length) { ol.innerHTML = '<li class="dim">nothing yet</li>'; return; }
  ol.innerHTML = state.sets.map((s) => {
    const bad = s.still_ok === false;
    return `<li class="${bad ? 'warn' : ''}">${s.exercise} · set ${s.set_number} · ` +
           `${s.reps ?? '?'} reps · ${s.duration_s.toFixed(0)}s${bad ? ' ⚠' : ''}</li>`;
  }).join('');
}

// ------------------------------------------------------------------ export

async function exportSession() {
  const chunks = await all('chunks');
  const sets = await all('sets');
  if (!chunks.length) { alert('Nothing recorded yet.'); return; }

  let total = 0;
  for (const c of chunks) total += c.length ?? c.byteLength;
  const raw = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { const u = c instanceof Uint8Array ? c : new Uint8Array(c); raw.set(u, o); o += u.length; }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
  download(new Blob([raw], { type: 'application/octet-stream' }), `session-${stamp}.axc`);
  download(new Blob([JSON.stringify({
    schema: 1,
    exported_at: new Date().toISOString(),
    raw_bytes: total,
    sets,
  }, null, 2)], { type: 'application/json' }), `session-${stamp}.json`);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// -------------------------------------------------------------------- draw

function setLink(text, cls) {
  const el = $('link');
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

function drawBubble() {
  const c = $('bubble');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== 88 * dpr) { c.width = 88 * dpr; c.height = 88 * dpr; }
  const x = c.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, 88, 88);
  x.strokeStyle = '#2a323c';
  x.beginPath(); x.arc(44, 44, 38, 0, 7); x.stroke();
  x.beginPath(); x.arc(44, 44, 13, 0, 7); x.stroke();
  x.beginPath(); x.moveTo(44, 4); x.lineTo(44, 84); x.moveTo(4, 44); x.lineTo(84, 44); x.stroke();

  const a = state.lastAccel;
  if (!a) return;
  const mag = Math.hypot(a[0], a[1], a[2]);
  if (mag < 1e-6) return;
  const k = a.map(Math.abs).indexOf(Math.max(...a.map(Math.abs)));
  const others = [0, 1, 2].filter((i) => i !== k);
  const st = still.status;
  x.fillStyle = { waiting: '#8b98a5', good: '#2f9e44', holding: '#e8a33d', moving: '#e8a33d' }[st];
  x.beginPath();
  x.arc(44 + (a[others[0]] / mag) * 38, 44 + (a[others[1]] / mag) * 38, 7, 0, 7);
  x.fill();

  $('up').textContent = `up = ${a[k] > 0 ? '+' : '-'}${'XYZ'[k]}`;
  $('tilt').textContent = `tilt ${(Math.acos(Math.min(1, Math.abs(a[k]) / mag)) * 180 / Math.PI).toFixed(0)}° off ${'XYZ'[k]}`;
  const el = $('still');
  const held = still.heldFor();
  el.textContent = {
    waiting: 'waiting for data',
    good: `still ${held.toFixed(1)}s — good static block`,
    holding: `holding ${held.toFixed(1)}s — need ${MIN_STATIC_S}s`,
    moving: 'moving',
  }[st];
  el.className = st === 'good' ? 'ok' : st === 'waiting' ? 'dim' : 'moving';
}

function drawTrace() {
  const c = $('trace');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 320;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = 150 * dpr; }
  const x = c.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, 150);

  const pts = state.trace;
  if (pts.length < 2) return;

  // Decimate to roughly one point per pixel. Drawing 900 samples into 350 px
  // costs time and shows nothing extra.
  const step = Math.max(1, Math.floor(pts.length / w));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pts.length; i += step) { const v = pts[i].mag; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 0.5) { const m = (hi + lo) / 2; lo = m - 0.25; hi = m + 0.25; }
  const pad = (hi - lo) * 0.1;
  lo -= pad; hi += pad;

  const t0 = pts[0].t_us, span = Math.max(1, TRACE_S * 1e6);
  x.strokeStyle = '#2a323c';
  const gy = 150 - ((9.80665 - lo) / (hi - lo)) * 150;
  if (gy > 0 && gy < 150) { x.beginPath(); x.moveTo(0, gy); x.lineTo(w, gy); x.stroke(); }

  x.strokeStyle = state.recording ? '#e5484d' : '#3b82f6';
  x.lineWidth = 1.5;
  x.beginPath();
  for (let i = 0, first = true; i < pts.length; i += step) {
    const px = ((pts[i].t_us - t0) / span) * w;
    const py = 150 - ((pts[i].mag - lo) / (hi - lo)) * 150;
    if (first) { x.moveTo(px, py); first = false; } else x.lineTo(px, py);
  }
  x.stroke();
}

function tick() {
  drawBubble();
  drawTrace();
  const s = dec.stats;
  const secs = state.rateWindow.length ? 2 : 1;
  const n = state.rateWindow.reduce((a, b) => a + b[1], 0);
  $('rate').textContent = s.samples
    ? `${Math.round(n / secs)}/s · ${s.samples} samples · ${s.lostPackets} lost · ${s.badChecksum} bad`
    : '';
  $('batt').textContent = fmtBattery(state.battery);
  setTimeout(tick, REDRAW_MS);
}

// -------------------------------------------------------------------- init

(async function init() {
  db = await openDb();
  state.sets = await all('sets');
  if (state.sets.length) state.setCounter = (state.sets.at(-1).set_number || 0) + 1;
  renderSets();

  $('exercise-list').innerHTML = EXERCISES.map((e) => `<option value="${e}">`).join('');
  $('connect').onclick = connect;
  $('export').onclick = exportSession;
  $('wipe').onclick = async () => {
    if (!confirm('Delete the recorded session from this phone? Export it first.')) return;
    await clearAll();
    state.sets = []; state.setCounter = 1; renderSets();
  };
  $('f-save').onclick = saveSet;
  $('f-discard').onclick = () => {
    // The bytes stay on disk either way -- discarding drops the labels, not the
    // recording, so a mis-tapped button cannot destroy data.
    state.pending = null;
    $('form').classList.add('hidden');
    $('state').textContent = 'press the device button to start a set';
  };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  tick();
  if (new URLSearchParams(location.search).has('replay')) startReplay();
})();
