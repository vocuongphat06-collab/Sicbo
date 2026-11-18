// audio.js - Procedural Web Audio API Salon Sound Engine (Zero External Assets)
class SoundFX {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.lastHeartbeatTime = 0;
    try {
      const saved = localStorage.getItem('sicbo_sound_enabled');
      this.enabled = saved === null ? true : (saved !== 'false' && saved !== '0');
    } catch (_) {
      this.enabled = true;
    }
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
    try {
      localStorage.setItem('sicbo_sound_enabled', String(this.enabled));
    } catch (_) {}
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  init() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return Boolean(this.ctx);
  }

  // Casino Ceramic Chip Placement Click
  playChip() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(2500 + Math.random() * 550, now);
    osc.frequency.exponentialRampToValueAtTime(820, now + 0.042);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.05);
  }

  // Physics-Synced Single Die Bounce / Die-to-Die Ivory Clack
  playDiceBounce(intensity = 0.7) {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const amp = Math.max(0.06, Math.min(1.0, intensity));

    // 1. Short Ivory / Porcelain Click Transient (Bandpass Noise)
    const dur = 0.032;
    const bufSize = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.28));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1650 + Math.random() * 950, now);
    filter.Q.setValueAtTime(5.5, now);

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.32 * amp, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(ctx.destination);

    noise.start(now);
    noise.stop(now + dur);

    // 2. Resonant Lacquer Tray Body Thud
    const bodyOsc = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    bodyOsc.type = 'sine';
    const baseFreq = 210 + Math.random() * 90;
    bodyOsc.frequency.setValueAtTime(baseFreq, now);
    bodyOsc.frequency.exponentialRampToValueAtTime(88, now + 0.045);

    bodyGain.gain.setValueAtTime(0.20 * amp, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.0008, now + 0.048);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(ctx.destination);

    bodyOsc.start(now);
    bodyOsc.stop(now + 0.052);
  }

  // Mechanical Dome Shaker Agitation Rattle
  playDiceShake() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 0.92;

    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1350, now);
    filter.Q.setValueAtTime(4.2, now);

    for (let i = 0; i < 12; i++) {
      const t = now + (i * 0.075);
      filter.frequency.setValueAtTime(900 + Math.random() * 1450, t);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.04, now);
    for (let i = 0; i < 11; i++) {
      const t = now + (i * 0.078);
      gain.gain.setValueAtTime(0.18 + Math.random() * 0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.02, t + 0.055);
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
    noise.stop(now + duration);
  }

  // Suspense Heartbeat & Rim Slide Friction during 3D Bowl Squeeze ("Nặn Bát")
  playSqueezeTension(progress = 0.4) {
    if (!this.enabled || !this.init()) return;
    const nowMs = performance.now();
    // Heartbeat accelerates from 640ms interval down to 290ms as bowl nears reveal!
    const intervalMs = 640 - Math.min(1, Math.max(0, progress)) * 350;
    if (nowMs - this.lastHeartbeatTime < intervalMs) return;
    this.lastHeartbeatTime = nowMs;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vol = 0.14 + progress * 0.22;

    // Lub-Dub double sub-bass pulse
    [0, 0.13].forEach((offset, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const startF = idx === 0 ? 66 : 56;
      osc.frequency.setValueAtTime(startF, now + offset);
      osc.frequency.exponentialRampToValueAtTime(30, now + offset + 0.11);

      gain.gain.setValueAtTime(0.001, now + offset);
      gain.gain.linearRampToValueAtTime(vol * (idx === 0 ? 1 : 0.72), now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + offset + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.13);
    });
  }

  // Bowl Pop / Reveal Shimmer
  playBowlRevealPop() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.16); // D6

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.34);
  }

  // Watch Escapement Tick for 15s Auto-Live Salon Timer
  playTimerTick(isUrgent = false) {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = isUrgent ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(isUrgent ? 1480 : 960, now);
    gain.gain.setValueAtTime(isUrgent ? 0.14 : 0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + (isUrgent ? 0.055 : 0.025));

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  // Win Chime Fanfare
  playWin() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.095);

      gain.gain.setValueAtTime(0, now + idx * 0.095);
      gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.095 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.095 + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.095);
      osc.stop(now + idx * 0.095 + 0.65);
    });
  }

  // Big Win Jackpot Fanfare
  playBigWin() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const chord = [523.25, 659.25, 783.99, 1046.50, 1318.51]; // C Major 9

    chord.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);

      gain.gain.setValueAtTime(0.25, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 1.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 1.3);
    });
  }

  // Short click / UI tap
  playTick() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(840, now);
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.035);
  }

  // Chip Remove / Undo
  playChipRemove() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1320 + Math.random() * 180, now);
    osc.frequency.exponentialRampToValueAtTime(460, now + 0.048);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.052);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.056);
  }

  // Breakeven Push Chime ("HÒA VỐN • ±0 ₫")
  playBreakeven() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    [392.0, 587.33].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);
      gain.gain.setValueAtTime(0.001, now + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.11, now + i * 0.08 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + i * 0.08 + 0.34);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.36);
    });
  }

  // Subtle Felt Thud on Loss
  playLoss() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(125, now + 0.13);
    gain.gain.setValueAtTime(0.085, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  // Daily Bonus / Bankruptcy Aid / Account Upgrade Shimmer
  playBonus() {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    [659.25, 830.61, 987.77, 1318.51].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.06);
      gain.gain.setValueAtTime(0.001, now + i * 0.06);
      gain.gain.linearRampToValueAtTime(0.13, now + i * 0.06 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + i * 0.06 + 0.42);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.45);
    });
  }

  // Toast Notification Cue
  playToast(type = 'info') {
    if (!this.enabled || !this.init()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type === 'error' ? 'triangle' : 'sine';
    const f0 = type === 'error' ? 310 : (type === 'success' ? 660 : 540);
    const f1 = type === 'error' ? 220 : (type === 'success' ? 880 : 620);
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.09);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.11);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }
}

window.soundFX = new SoundFX();
