// Is the device still enough to give the analysis a usable static block?
//
// Re-implements axcel.orientation.is_stationary and the run-length requirement
// of find_static_block. Deliberately variance-based, not |a| against g: turn-on
// bias is unknown at this point -- it is the very thing the static block exists
// to estimate -- so an absolute test either rejects genuinely still samples or
// has to be loosened until it stops discriminating.
//
// The code is written twice; the NUMBERS are not. thresholds.js is generated
// from the Python signatures, because Capture.static_block_s once carried a
// private copy of them and the gym-time warning could quietly stop agreeing
// with what the analysis would accept.
//
// One difference from the Python, and it is deliberate: is_stationary uses a
// centred rolling window, which needs samples from the future. Live on a phone
// the window has to trail. Verdicts therefore agree on the same span of data
// but not sample-for-sample at the edges, which is what test_stillness.html
// checks.

import { ACCEL_TOL, GYRO_TOL_DPS, WINDOW_S, MIN_STATIC_S } from './thresholds.js';

export function std(values) {
  const n = values.length;
  if (n < 2) return 0;
  let m = 0;
  for (const v of values) m += v;
  m /= n;
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / n);
}

/**
 * Verdict for one explicit window.
 * @param {{a: number[], g: number[]}[]} win accel m/s^2, gyro deg/s
 * @returns {boolean|null} null when there is not yet enough data to say
 */
export function stationary(win, minSamples = 6) {
  if (!win || win.length < minSamples) return null;
  for (let k = 0; k < 3; k++) {
    if (std(win.map((s) => s.a[k])) >= ACCEL_TOL) return false;
    if (std(win.map((s) => s.g[k])) >= GYRO_TOL_DPS) return false;
  }
  return true;
}

/**
 * Tracks how long the device has been continuously still.
 *
 * The run length is the whole point. `find_static_block` needs MIN_STATIC_S of
 * *contiguous* stillness, and the set this project actually lost had nine
 * isolated still windows in its first six seconds and no usable run. An
 * indicator keyed on the instantaneous verdict would have shown green on it.
 */
export class StillnessTracker {
  constructor() {
    this.win = [];
    this.runStartUs = null;
    this.lastUs = null;
    this.verdict = null;
  }

  /** @param {number} t_us @param {number[]} a @param {number[]} g */
  push(t_us, a, g) {
    this.win.push({ t_us, a, g });
    const cut = t_us - WINDOW_S * 1e6;
    while (this.win.length && this.win[0].t_us < cut) this.win.shift();
    this.lastUs = t_us;

    this.verdict = stationary(this.win);
    if (this.verdict === true) {
      if (this.runStartUs === null) this.runStartUs = this.win[0].t_us;
    } else if (this.verdict === false) {
      this.runStartUs = null;
    }
  }

  /** Seconds of continuous stillness so far. */
  heldFor() {
    if (this.runStartUs === null || this.lastUs === null) return 0;
    return (this.lastUs - this.runStartUs) / 1e6;
  }

  /** True once the run is long enough for find_static_block to use it. */
  get good() {
    return this.heldFor() >= MIN_STATIC_S;
  }

  /** 'good' | 'holding' | 'moving' | 'waiting' */
  get status() {
    if (this.verdict === null) return 'waiting';
    if (this.good) return 'good';
    return this.verdict ? 'holding' : 'moving';
  }

  reset() {
    this.win = [];
    this.runStartUs = null;
    this.verdict = null;
  }
}
