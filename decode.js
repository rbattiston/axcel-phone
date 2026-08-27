// ADVISORY DECODER -- FOR THE SCREEN ONLY.
//
// host/protocol.py is the authoritative parser. This file exists so the phone
// can show a live trace, a stillness light and a link-health readout while
// recording. Nothing it produces is ever written to storage: the phone stores
// the raw BLE bytes verbatim, and the laptop re-derives everything from those.
//
// That separation is the point. The wire format lives in main.c and
// protocol.py; letting a third implementation become load-bearing is precisely
// what broke monitor.py's event handling for weeks (docs/decisions.md 028). A
// bug in here costs a misleading screen and nothing else, because nothing
// downstream reads its output.
//
// Mirrored from host/protocol.py -- change together, but only the display
// suffers if they drift.

export const MAGIC0 = 0xa5;
export const SAMPLE_MAGIC1 = 0x5a;
export const EVENT_MAGIC1 = 0x5b;
export const BATTERY_MAGIC1 = 0x5c;

const SAMPLE_HEADER_SIZE = 12;
const EVENT_SIZE = 12;
const BATTERY_SIZE = 13;
const BYTES_PER_SAMPLE = 12;

// Datasheet DocID030071 Rev 3, Table 3, at the full scales the firmware sets.
const ACCEL_MG_PER_LSB = 0.488; // +/-16 g
const GYRO_MDPS_PER_LSB = 70.0; // +/-2000 dps
const G = 9.80665;

export const EV_BOOT = 1;
export const EV_SET_START = 2;
export const EV_SET_END_BUTTON = 3;
export const EV_SET_END_IDLE = 4;
export const EV_POWER_OFF = 5;
export const EV_BUTTON_DOWN = 6;
export const EV_BUTTON_UP = 7;

export const EVENT_NAMES = {
  1: 'boot',
  2: 'set start',
  3: 'set end (button)',
  4: 'set end (idle)',
  5: 'power off',
  6: 'button down',
  7: 'button up',
};

export const BATT_FLAG_CHARGING = 0x01;
export const BATT_FLAG_VALID = 0x02;

function sum(bytes, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s = (s + bytes[i]) & 0xffff;
  return s;
}

/**
 * Resynchronising decoder over a byte stream carrying all three packet types.
 *
 * Same shape as protocol.Parser: feed it chunks, get items back. Keeps a
 * leftover buffer because a BLE notification can split a packet anywhere.
 */
export class Decoder {
  constructor() {
    this.buf = new Uint8Array(0);
    this.stats = { packets: 0, samples: 0, events: 0, batteries: 0, badChecksum: 0, resyncs: 0, lostPackets: 0, lastSeq: null };
  }

  feed(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out = [];
    let i = 0;
    for (;;) {
      // Find a plausible frame start.
      while (i < this.buf.length && this.buf[i] !== MAGIC0) {
        i++;
        this.stats.resyncs++;
      }
      if (i + 2 > this.buf.length) break;

      const kind = this.buf[i + 1];
      if (kind !== SAMPLE_MAGIC1 && kind !== EVENT_MAGIC1 && kind !== BATTERY_MAGIC1) {
        i++;
        continue;
      }

      const item = kind === EVENT_MAGIC1 ? this._event(i)
        : kind === BATTERY_MAGIC1 ? this._battery(i)
        : this._samples(i);

      if (item === null) break;          // need more bytes
      if (item === false) { i += 2; continue; } // bad checksum, resync past it
      out.push(item.value);
      i += item.size;
    }
    this.buf = this.buf.slice(i);
    return out;
  }

  _view(at, len) {
    return new DataView(this.buf.buffer, this.buf.byteOffset + at, len);
  }

  _event(at) {
    if (at + EVENT_SIZE > this.buf.length) return null;
    const v = this._view(at, EVENT_SIZE);
    const want = v.getUint16(10, true);
    if (sum(this.buf, at, at + EVENT_SIZE - 2) !== want) {
      this.stats.badChecksum++;
      return false;
    }
    this.stats.events++;
    return {
      size: EVENT_SIZE,
      value: {
        kind: 'event',
        seq: v.getUint16(2, true),
        t_us: v.getUint32(4, true),
        code: v.getUint8(8),
        state: v.getUint8(9),
        name: EVENT_NAMES[v.getUint8(8)] || `event ${v.getUint8(8)}`,
      },
    };
  }

  _battery(at) {
    if (at + BATTERY_SIZE > this.buf.length) return null;
    const v = this._view(at, BATTERY_SIZE);
    const want = v.getUint16(11, true);
    if (sum(this.buf, at, at + BATTERY_SIZE - 2) !== want) {
      this.stats.badChecksum++;
      return false;
    }
    this.stats.batteries++;
    const flags = v.getUint8(10);
    return {
      size: BATTERY_SIZE,
      value: {
        kind: 'battery',
        seq: v.getUint16(2, true),
        t_us: v.getUint32(4, true),
        mv: v.getUint16(8, true),
        flags,
        valid: !!(flags & BATT_FLAG_VALID),
        charging: !!(flags & BATT_FLAG_CHARGING),
      },
    };
  }

  _samples(at) {
    if (at + SAMPLE_HEADER_SIZE > this.buf.length) return null;
    const v = this._view(at, SAMPLE_HEADER_SIZE);
    const n = v.getUint8(10);
    if (n === 0 || n > 64) {
      this.stats.badChecksum++;
      return false;
    }
    const total = SAMPLE_HEADER_SIZE + n * BYTES_PER_SAMPLE + 2;
    if (at + total > this.buf.length) return null;

    const want = new DataView(this.buf.buffer, this.buf.byteOffset + at + total - 2, 2).getUint16(0, true);
    if (sum(this.buf, at, at + total - 2) !== want) {
      this.stats.badChecksum++;
      return false;
    }

    const seq = v.getUint16(2, true);
    const t_us = v.getUint32(4, true);
    const period_us = v.getUint16(8, true);
    const rows = [];
    const body = new DataView(this.buf.buffer, this.buf.byteOffset + at + SAMPLE_HEADER_SIZE, n * BYTES_PER_SAMPLE);
    for (let k = 0; k < n; k++) {
      const o = k * BYTES_PER_SAMPLE;
      rows.push([
        (body.getInt16(o + 0, true) * GYRO_MDPS_PER_LSB) / 1000,
        (body.getInt16(o + 2, true) * GYRO_MDPS_PER_LSB) / 1000,
        (body.getInt16(o + 4, true) * GYRO_MDPS_PER_LSB) / 1000,
        ((body.getInt16(o + 6, true) * ACCEL_MG_PER_LSB) / 1000) * G,
        ((body.getInt16(o + 8, true) * ACCEL_MG_PER_LSB) / 1000) * G,
        ((body.getInt16(o + 10, true) * ACCEL_MG_PER_LSB) / 1000) * G,
      ]);
    }

    this.stats.packets++;
    this.stats.samples += n;
    if (this.stats.lastSeq !== null) {
      // A large gap means the link was down, not that packets were lost in
      // flight -- the device streams to nobody and discards. Same rule as
      // protocol.Health.note_samples.
      const gap = (seq - this.stats.lastSeq - 1) & 0xffff;
      if (gap > 0 && gap < 200) this.stats.lostPackets += gap;
    }
    this.stats.lastSeq = seq;

    return { size: total, value: { kind: 'samples', seq, t_us, period_us, rows } };
  }
}
