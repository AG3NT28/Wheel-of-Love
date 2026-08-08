(() => {
  'use strict';

  const canvas = document.getElementById('wheel-canvas');
  const ctx = canvas.getContext('2d');
  const form = document.getElementById('spin-form');
  const spinBtn = document.getElementById('spin-btn');
  const errorEl = document.getElementById('form-error');
  const overlay = document.getElementById('overlay');
  const ambient = document.getElementById('ambient');
  const burstLayer = document.getElementById('burst-layer');
  const flashOverlay = document.createElement('div');
  flashOverlay.className = 'flash-overlay';
  document.body.appendChild(flashOverlay);


  let segments = [];
  let cumulativeRotation = 0;
  let isSpinning = false;
  let audioContext = null;
  const tierAudioMap = {
    bronze: '/audio/reward-chime.mp3',
    silver: '/audio/level-up.mp3',
    gold: '/audio/victory-fanfare.mp3',
    platinum: '/audio/fantasy-game-sweep.wav',
    diamond: '/audio/magic-transition-sweep.wav',
  };
  const audioPlayers = {};

  // ---------------------------------------------------------------------
  // Ambient floating hearts
  // ---------------------------------------------------------------------
  function spawnAmbientHearts(count = 14) {
    const glyphs = ['♥', '♡'];
    for (let i = 0; i < count; i++) {
      const span = document.createElement('span');
      span.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
      span.style.setProperty('--x', `${Math.random() * 100}%`);
      span.style.setProperty('--size', `${14 + Math.random() * 22}px`);
      span.style.setProperty('--dur', `${16 + Math.random() * 14}s`);
      span.style.setProperty('--delay', `${-Math.random() * 24}s`);
      ambient.appendChild(span);
    }
  }

  function spawnConfetti(color) {
    const glyphs = ['♥', '♡', '✦'];
    const colors = [color, '#E8CE7B', '#FBF6EC'];
    const count = 34;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.setProperty('--size', `${12 + Math.random() * 18}px`);
      piece.style.setProperty('--dur', `${2.6 + Math.random() * 2}s`);
      piece.style.setProperty('--delay', `${Math.random() * 0.6}s`);
      piece.style.setProperty('--rot', `${(Math.random() > 0.5 ? 1 : -1) * (120 + Math.random() * 240)}deg`);
      piece.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]);
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 5200);
    }
  }

  function ensureAudioContext() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      audioContext = new AudioCtx();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    return audioContext;
  }

  async function playTierSound(tierId) {
    const audioSrc = tierAudioMap[tierId];

    if (audioSrc && typeof Audio !== 'undefined') {
      try {
        if (!audioPlayers[audioSrc]) {
          const audio = new Audio(audioSrc);
          audio.preload = 'auto';
          audio.volume = 0.9;
          audioPlayers[audioSrc] = audio;
        }

        const audio = audioPlayers[audioSrc];
        audio.currentTime = 0;
        await audio.play();
        return;
      } catch (err) {
        // Fall back to synthesized tones if the browser blocks the audio file.
      }
    }

    const ctx = ensureAudioContext();
    if (!ctx) return;

    const presets = {
      bronze: [
        { freq: 220, type: 'sine', duration: 0.14, gain: 0.0007 },
        { freq: 330, type: 'triangle', duration: 0.18, gain: 0.00055 },
      ],
      silver: [
        { freq: 392, type: 'triangle', duration: 0.12, gain: 0.0006 },
        { freq: 523, type: 'sine', duration: 0.16, gain: 0.0005 },
        { freq: 659, type: 'triangle', duration: 0.2, gain: 0.00045 },
      ],
      gold: [
        { freq: 440, type: 'triangle', duration: 0.1, gain: 0.0007 },
        { freq: 659, type: 'sine', duration: 0.14, gain: 0.0006 },
        { freq: 880, type: 'triangle', duration: 0.18, gain: 0.0005 },
      ],
      platinum: [
        { freq: 523, type: 'sine', duration: 0.11, gain: 0.00055 },
        { freq: 698, type: 'triangle', duration: 0.15, gain: 0.0005 },
        { freq: 880, type: 'sine', duration: 0.2, gain: 0.00045 },
      ],
      diamond: [
        { freq: 659, type: 'triangle', duration: 0.11, gain: 0.0007 },
        { freq: 784, type: 'sine', duration: 0.14, gain: 0.0006 },
        { freq: 1046, type: 'triangle', duration: 0.18, gain: 0.00055 },
        { freq: 1318, type: 'sine', duration: 0.22, gain: 0.00045 },
      ],
    };

    const notes = presets[tierId] || presets.gold;
    const now = ctx.currentTime;

    notes.forEach((note, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + index * 0.035;

      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, start);
      osc.frequency.exponentialRampToValueAtTime(note.freq * 1.06, start + note.duration);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);

      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + note.duration + 0.02);
    });
  }

  function triggerTierBurst(result, origin = { x: '50%', y: '50%' }) {
    const tier = segments.find((segment) => segment.id === result?.id) || segments.find((segment) => segment.label === result?.label);
    if (!tier || !burstLayer) return;

    const presets = {
      bronze: { className: 'bronze', sparkleCount: 12, glyphs: ['✦', '✧', '•'], radius: [36, 64], duration: 1.05 },
      silver: { className: 'silver', sparkleCount: 16, glyphs: ['✦', '✺', '✧'], radius: [44, 74], duration: 1.12 },
      gold: { className: 'gold', sparkleCount: 20, glyphs: ['✦', '✺', '♥'], radius: [50, 84], duration: 1.2 },
      platinum: { className: 'platinum', sparkleCount: 18, glyphs: ['✦', '❋', '✧'], radius: [44, 80], duration: 1.25 },
      diamond: { className: 'diamond', sparkleCount: 26, glyphs: ['✦', '✺', '❋', '☆'], radius: [58, 96], duration: 1.35 },
    };

    const preset = presets[tier.id] || presets.gold;
    const burst = document.createElement('div');
    burst.className = `burst ${preset.className}`;
    burst.style.left = origin.x;
    burst.style.top = origin.y;
    burst.style.setProperty('--burst-color', tier.colorLight || tier.color);
    burst.style.setProperty('--burst-duration', `${preset.duration}s`);

    for (let i = 0; i < preset.sparkleCount; i++) {
      const sparkle = document.createElement('span');
      sparkle.className = 'sparkle';
      sparkle.textContent = preset.glyphs[i % preset.glyphs.length];
      sparkle.style.animationDelay = `${Math.random() * 0.05}s`;
      sparkle.style.animationDuration = `${preset.duration - 0.08 + Math.random() * 0.12}s`;
      const angle = (i / preset.sparkleCount) * Math.PI * 2;
      const radius = preset.radius[0] + Math.random() * (preset.radius[1] - preset.radius[0]);
      sparkle.style.setProperty('--x', `${Math.cos(angle) * radius}px`);
      sparkle.style.setProperty('--y', `${Math.sin(angle) * radius}px`);
      burst.appendChild(sparkle);
    }

    burstLayer.appendChild(burst);
    setTimeout(() => burst.remove(), 1500);
  }

  // ---------------------------------------------------------------------
  // Wheel drawing
  // ---------------------------------------------------------------------
  function luminance(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16) / 255;
    const g = parseInt(c.substring(2, 4), 16) / 255;
    const b = parseInt(c.substring(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function textColorFor(hex) {
    return luminance(hex) > 0.55 ? '#2A0E0A' : '#FBF6EC';
  }

  function drawWheel() {
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;
    const n = segments.length;
    if (!n) return;

    const per = (2 * Math.PI) / n;
    const start = -Math.PI / 2 - per / 2;

    ctx.clearRect(0, 0, size, size);

    segments.forEach((seg, i) => {
      const a0 = start + i * per;
      const a1 = a0 + per;

      const grad = ctx.createRadialGradient(cx, cy, r * 0.12, cx, cy, r);
      grad.addColorStop(0, seg.colorLight || seg.color);
      grad.addColorStop(1, seg.color);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = size * 0.005;
      ctx.strokeStyle = 'rgba(247,236,200,0.85)';
      ctx.stroke();

      const mid = a0 + per / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(mid);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = textColorFor(seg.color);
      ctx.font = `600 ${Math.round(size * 0.034)}px Outfit, sans-serif`;
      ctx.fillText((seg.shortLabel || seg.label).toUpperCase(), r - size * 0.09, 0);
      ctx.restore();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = size * 0.007;
    ctx.strokeStyle = 'rgba(247,236,200,0.55)';
    ctx.stroke();
  }

  // ---------------------------------------------------------------------
  // Data + spin
  // ---------------------------------------------------------------------
  async function loadSegments() {
    try {
      const res = await fetch('/api/segments');
      const data = await res.json();
      segments = data.segments || [];
      drawWheel();
      if (!segments.length) {
        showError("The wheel isn't ready yet — please ask our team for a moment.");
        spinBtn.disabled = true;
      }
    } catch (err) {
      showError('Could not load the wheel. Please refresh the page.');
    }
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
  }

  function spinToIndex(index, count) {
    const per = 360 / count;
    const jitter = (Math.random() - 0.5) * per * 0.6;
    const targetAngle = index * per + jitter;
    const targetMod = ((360 - targetAngle) % 360 + 360) % 360;
    const currentMod = ((cumulativeRotation % 360) + 360) % 360;

    let delta = targetMod - currentMod;
    if (delta <= 0) delta += 360;
    const extraSpins = 6 + Math.floor(Math.random() * 3);
    delta += 360 * extraSpins;

    cumulativeRotation += delta;

    const duration = 5000 + Math.random() * 600;
    canvas.style.transition = `transform ${duration}ms cubic-bezier(0.11, 0.79, 0.14, 1)`;
    canvas.style.transform = `rotate(${cumulativeRotation}deg)`;

    return duration;
  }

  function fillBadge(icon, color) {
    const badge = document.getElementById('locket-badge');
    badge.innerHTML = '';
    badge.style.setProperty('--badge-color', color);
    const templateId = icon === 'diamond' ? 'icon-diamond' : 'icon-star';
    const tpl = document.getElementById(templateId);
    badge.appendChild(tpl.content.cloneNode(true));
  }

  function openResult(result) {
    document.getElementById('locket-title').textContent = result.label;
    document.getElementById('locket-today').innerHTML = `<strong>Today:</strong> ${escapeHTML(result.todayReward)}`;
    document.getElementById('locket-future').textContent = result.futureReward;
    document.getElementById('locket-code').textContent = result.code;
    document.getElementById('locket-validity').textContent = result.validityDays;
    fillBadge(result.icon, result.color);
    overlay.classList.add('visible');
    const wheelRing = document.querySelector('.wheel-ring');
    wheelRing?.classList.add('win-glow');
    wheelRing?.classList.add('shake');
    flashOverlay.classList.remove('active');
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add('active');
    setTimeout(() => {
      wheelRing?.classList.remove('win-glow');
      wheelRing?.classList.remove('shake');
    }, 900);
    spawnConfetti(result.color);
    triggerTierBurst(result, { x: '50%', y: '48%' });
    void playTierSound(result.id);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function closeResult() {
    overlay.classList.remove('visible');
    isSpinning = false;
    spinBtn.disabled = false;
    spinBtn.textContent = 'Spin the Wheel';
    form.reset();
  }

  document.getElementById('locket-close').addEventListener('click', closeResult);
  document.getElementById('locket-continue').addEventListener('click', closeResult);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeResult();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    if (isSpinning) return;

    const name = document.getElementById('guest-name').value.trim();
    const phone = document.getElementById('guest-phone').value.trim();
    if (!name) {
      showError('Please enter your name before spinning.');
      return;
    }
    if (!segments.length) {
      showError("The wheel isn't ready yet — please ask our team for a moment.");
      return;
    }

    isSpinning = true;
    spinBtn.disabled = true;
    spinBtn.textContent = 'Spinning…';

    try {
      const res = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }

      const duration = spinToIndex(data.index, data.segmentCount);
      setTimeout(() => openResult(data.result), duration + 250);
    } catch (err) {
      showError(err.message || 'Something went wrong. Please try again.');
      isSpinning = false;
      spinBtn.disabled = false;
      spinBtn.textContent = 'Spin the Wheel';
    }
  });

  spawnAmbientHearts();
  loadSegments();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(drawWheel);
  }
  window.addEventListener('resize', () => {
    // canvas uses a fixed internal resolution scaled by CSS, so no redraw needed
  });
})();
