(() => {
  'use strict';

  const loginView = document.getElementById('login-view');
  const dashboardView = document.getElementById('dashboard-view');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const logoutBtn = document.getElementById('logout-btn');

  const segmentsList = document.getElementById('segments-list');
  const probBar = document.getElementById('prob-bar');
  const probLegend = document.getElementById('prob-legend');
  const addSegmentBtn = document.getElementById('add-segment-btn');
  const saveBtn = document.getElementById('save-btn');
  const resetBtn = document.getElementById('reset-btn');
  const saveStatus = document.getElementById('save-status');

  const statsRow = document.getElementById('stats-row');
  const logTbody = document.getElementById('log-tbody');
  const logEmpty = document.getElementById('log-empty');
  const clearLogBtn = document.getElementById('clear-log-btn');

  let segments = [];
  let dirty = false;
  let seq = 0;

  // ---------------------------------------------------------------- utils
  function uid() {
    seq += 1;
    return `new-${Date.now()}-${seq}`;
  }

  function clamp01(n) {
    return Math.min(1, Math.max(0, n));
  }

  function lighten(hex, amount) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const mix = (v) => Math.round(v + (255 - v) * amount);
    const toHex = (v) => v.toString(16).padStart(2, '0');
    return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`.toUpperCase();
  }

  function markDirty() {
    dirty = true;
    saveStatus.textContent = 'Unsaved changes';
    saveStatus.className = 'save-status dirty';
  }

  function markSaved() {
    dirty = false;
    saveStatus.textContent = 'All changes saved';
    saveStatus.className = 'save-status ok';
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('Session expired. Please log in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // ---------------------------------------------------------------- auth
  async function checkAuth() {
    try {
      const data = await api('/api/admin/check');
      if (data.authenticated) {
        showDashboard();
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
  }

  function showDashboard() {
    loginView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    loadSegments();
    loadLog();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.remove('visible');
    const password = document.getElementById('login-password').value;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      document.getElementById('login-password').value = '';
      showDashboard();
    } catch (err) {
      loginError.textContent = err.message === 'Incorrect password.' ? err.message : 'Incorrect password.';
      loginError.classList.add('visible');
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------------------------------------------------------------- tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('tab-segments').classList.toggle('hidden', tab !== 'segments');
      document.getElementById('tab-log').classList.toggle('hidden', tab !== 'log');
      if (tab === 'log') loadLog();
    });
  });

  // ---------------------------------------------------------------- segments
  async function loadSegments() {
    try {
      const data = await api('/api/admin/segments');
      segments = data.segments;
      markSaved();
      renderSegments();
    } catch (err) {
      saveStatus.textContent = err.message;
      saveStatus.className = 'save-status dirty';
    }
  }

  function renderProbBar() {
    const active = segments.filter((s) => s.active && Number(s.weight) > 0);
    const total = active.reduce((sum, s) => sum + Number(s.weight), 0);

    probBar.innerHTML = '';
    probLegend.innerHTML = '';

    if (!total) {
      probBar.innerHTML = '<div style="width:100%;background:#e6d9bf;"></div>';
      return;
    }

    active.forEach((s) => {
      const pct = clamp01(Number(s.weight) / total) * 100;
      const seg = document.createElement('div');
      seg.style.width = `${pct}%`;
      seg.style.background = s.color;
      seg.title = `${s.label}: ${pct.toFixed(1)}%`;
      probBar.appendChild(seg);

      const legendItem = document.createElement('span');
      legendItem.innerHTML = `<span class="dot" style="background:${s.color}"></span>${s.label} — ${pct.toFixed(1)}%`;
      probLegend.appendChild(legendItem);
    });
  }

  function renderSegments() {
    segmentsList.innerHTML = '';

    segments.forEach((seg, index) => {
      if (!seg.id) seg.id = uid();
      const card = document.createElement('div');
      card.className = `segment-card${seg.active ? '' : ' inactive'}`;

      card.innerHTML = `
        <div class="segment-card-head">
          <div class="order-controls">
            <button type="button" data-action="up" ${index === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
            <button type="button" data-action="down" ${index === segments.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
          </div>
          <input type="color" class="color-swatch" data-field="color" value="${seg.color}" aria-label="Segment color" />
          <input type="text" class="seg-label-input" data-field="label" value="${escapeAttr(seg.label)}" placeholder="Prize name" />
          <select class="icon-select" data-field="icon" aria-label="Badge icon">
            <option value="star" ${seg.icon !== 'diamond' ? 'selected' : ''}>★ Star badge</option>
            <option value="diamond" ${seg.icon === 'diamond' ? 'selected' : ''}>◆ Diamond badge</option>
          </select>
          <label class="toggle">
            <input type="checkbox" data-field="active" ${seg.active ? 'checked' : ''} />
            Active
          </label>
        </div>

        <div class="field-grid">
          <div>
            <label>Wheel label</label>
            <input type="text" data-field="shortLabel" value="${escapeAttr(seg.shortLabel || seg.label)}" placeholder="Short label shown on wheel" />
          </div>
          <div class="weight-field-wrap">
            <label>Weight (probability)</label>
            <div class="weight-field">
              <input type="number" min="0" step="1" data-field="weight" value="${seg.weight}" />
              <span class="weight-pct" data-role="pct"></span>
            </div>
          </div>
          <div>
            <label>Validity (days)</label>
            <input type="number" min="1" step="1" data-field="validityDays" value="${seg.validityDays}" />
          </div>
        </div>

        <div class="field-grid">
          <div style="grid-column: 1 / -1;">
            <label>Today's reward (shown immediately)</label>
            <textarea rows="2" data-field="todayReward" maxlength="200">${escapeText(seg.todayReward)}</textarea>
          </div>
          <div style="grid-column: 1 / -1;">
            <label>Future visits reward</label>
            <textarea rows="2" data-field="futureReward" maxlength="220">${escapeText(seg.futureReward)}</textarea>
          </div>
        </div>

        <div class="segment-card-foot">
          <button type="button" class="btn btn-danger btn-sm" data-action="delete">Remove segment</button>
        </div>
      `;

      // field bindings
      card.querySelectorAll('[data-field]').forEach((el) => {
        const field = el.dataset.field;
        const evt = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input';
        el.addEventListener(evt, () => {
          if (field === 'active') {
            seg.active = el.checked;
            card.classList.toggle('inactive', !seg.active);
          } else if (field === 'weight' || field === 'validityDays') {
            seg[field] = Number(el.value);
          } else if (field === 'color') {
            seg.color = el.value.toUpperCase();
            seg.colorLight = lighten(seg.color, 0.32);
          } else {
            seg[field] = el.value;
          }
          markDirty();
          renderProbBar();
        });
      });

      card.querySelector('[data-action="up"]')?.addEventListener('click', () => {
        if (index === 0) return;
        [segments[index - 1], segments[index]] = [segments[index], segments[index - 1]];
        markDirty();
        renderSegments();
      });
      card.querySelector('[data-action="down"]')?.addEventListener('click', () => {
        if (index === segments.length - 1) return;
        [segments[index + 1], segments[index]] = [segments[index], segments[index + 1]];
        markDirty();
        renderSegments();
      });
      card.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
        if (!confirm(`Remove "${seg.label}" from the wheel?`)) return;
        segments.splice(index, 1);
        markDirty();
        renderSegments();
      });

      segmentsList.appendChild(card);
    });

    renderProbBar();
    syncPctLabels();
  }

  function syncPctLabels() {
    const active = segments.filter((s) => s.active && Number(s.weight) > 0);
    const total = active.reduce((sum, s) => sum + Number(s.weight), 0);
    segmentsList.querySelectorAll('.segment-card').forEach((card, i) => {
      const seg = segments[i];
      const pctEl = card.querySelector('[data-role="pct"]');
      if (!pctEl) return;
      if (!seg.active || !total) {
        pctEl.textContent = seg.active ? '' : 'inactive';
      } else {
        pctEl.textContent = `${((Number(seg.weight) / total) * 100).toFixed(1)}%`;
      }
    });
  }

  // re-sync percentage labels whenever weight changes too
  segmentsList.addEventListener('input', (e) => {
    if (e.target.dataset.field === 'weight') syncPctLabels();
  });
  segmentsList.addEventListener('change', (e) => {
    if (e.target.dataset.field === 'active') syncPctLabels();
  });

  addSegmentBtn.addEventListener('click', () => {
    segments.push({
      id: uid(),
      order: segments.length,
      active: true,
      label: 'New Privilege',
      shortLabel: 'New',
      icon: 'star',
      color: '#BC8F1C',
      colorLight: '#E8CE7B',
      weight: 10,
      todayReward: '',
      futureReward: '',
      validityDays: 90,
    });
    markDirty();
    renderSegments();
  });

  saveBtn.addEventListener('click', async () => {
    if (!segments.length) {
      alert('Add at least one segment before saving.');
      return;
    }
    for (const s of segments) {
      if (!s.label.trim()) {
        alert('Every segment needs a name.');
        return;
      }
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const data = await api('/api/admin/segments', {
        method: 'PUT',
        body: JSON.stringify({ segments }),
      });
      segments = data.segments;
      markSaved();
      renderSegments();
    } catch (err) {
      alert(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
    }
  });

  resetBtn.addEventListener('click', async () => {
    if (!confirm("Reset the wheel to today's default privileges? Unsaved changes will be lost.")) return;
    try {
      const data = await api('/api/admin/segments/reset', { method: 'POST' });
      segments = data.segments;
      markSaved();
      renderSegments();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------------------------------------------------------------- log
  async function loadLog() {
    try {
      const data = await api('/api/admin/spins');
      renderStats(data.spins, data.total, data.counts);
      renderLog(data.spins);
    } catch (err) {
      // silent — log tab is secondary
    }
  }

  function renderStats(spins, total, counts) {
    statsRow.innerHTML = '';
    const items = [{ label: 'Total spins', value: total }];
    segments.forEach((s) => {
      items.push({ label: s.label, value: counts[s.id] || 0, color: s.color });
    });
    items.forEach((it) => {
      const card = document.createElement('div');
      card.className = 'stat-card';
      card.innerHTML = `<div class="num" style="${it.color ? `color:${it.color}` : ''}">${it.value}</div><div class="lbl">${it.label}</div>`;
      statsRow.appendChild(card);
    });
  }

  function renderLog(spins) {
    logTbody.innerHTML = '';
    logEmpty.classList.toggle('hidden', spins.length > 0);

    spins.forEach((s) => {
      const seg = segments.find((x) => x.id === s.segmentId);
      const tr = document.createElement('tr');
      const time = new Date(s.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      tr.innerHTML = `
        <td>${time}</td>
        <td>${escapeText(s.name) || '—'}</td>
        <td>${escapeText(s.phone) || '—'}</td>
        <td><span class="tag" style="background:${seg ? seg.color : '#999'}">${escapeText(s.segmentLabel)}</span></td>
        <td>${escapeText(s.code)}</td>
      `;
      logTbody.appendChild(tr);
    });
  }

  clearLogBtn.addEventListener('click', async () => {
    if (!confirm('Clear the entire spin history? This cannot be undone.')) return;
    try {
      await api('/api/admin/spins', { method: 'DELETE' });
      loadLog();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------------------------------------------------------------- escaping
  function escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function escapeText(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  checkAuth();
})();
