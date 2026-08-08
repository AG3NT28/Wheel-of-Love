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
  const logSearch = document.getElementById('log-search');
  const logPageSize = document.getElementById('log-page-size');
  const logPagination = document.getElementById('log-pagination');
  const resetStatus = document.getElementById('reset-status');

  let segments = [];
  let dirty = false;
  let seq = 0;
  let allSpins = [];
  let currentPage = 1;
  let currentQuery = '';
  let pageSize = Number(logPageSize?.value || 10);
  let logRefreshTimer = null;
  const LOG_REFRESH_INTERVAL = 3000;

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
      label: 'New Tier',
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
      updateResetStatus();
    } catch (err) {
      alert(err.message);
    }
  });

  function updateResetStatus() {
    resetStatus.textContent = `Last reset: ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  }

  // ---------------------------------------------------------------- log
  async function loadLog() {
    try {
      const data = await api('/api/admin/spins');
      allSpins = data.spins;
      renderStats(data.spins, data.total, data.counts);
      renderLog(allSpins);
    } catch (err) {
      // silent — log tab is secondary
    }
  }

  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function filterSpins(spins) {
    const query = currentQuery.trim().toLowerCase();
    if (!query) return spins;
    return spins.filter((spin) => {
      return [spin.name, spin.phone, spin.segmentLabel, spin.code]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    });
  }

  function renderLog(spins) {
    const filtered = filterSpins(spins);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageSpins = filtered.slice(start, start + pageSize);

    logTbody.innerHTML = '';
    logEmpty.classList.toggle('hidden', pageSpins.length > 0);
    logPagination.innerHTML = '';

    pageSpins.forEach((s) => {
      const seg = segments.find((x) => x.id === s.segmentId);
      const tr = document.createElement('tr');
      const time = formatDate(s.timestamp);
      tr.innerHTML = `
        <td>${time}</td>
        <td>${escapeText(s.name) || '—'}</td>
        <td>${escapeText(s.phone) || '—'}</td>
        <td><span class="tag" style="background:${seg ? seg.color : '#999'}">${escapeText(s.segmentLabel)}</span></td>
        <td>${escapeText(s.code)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm delete-spin-btn" data-id="${escapeAttr(s.id)}">Delete</button></td>
      `;
      logTbody.appendChild(tr);
    });

    renderPagination(totalPages);
    if (exportBtn) exportBtn.classList.toggle('disabled', filtered.length === 0);
    clearLogBtn.disabled = filtered.length === 0;
  }

  function renderPagination(totalPages) {
    logPagination.innerHTML = '';
    if (totalPages <= 1) return;

    const addPageButton = (label, page, disabled = false, active = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = disabled;
      if (active) button.classList.add('active');
      button.addEventListener('click', () => {
        currentPage = page;
        renderLog(allSpins);
      });
      logPagination.appendChild(button);
    };

    addPageButton('«', 1, currentPage === 1);
    for (let i = 1; i <= totalPages; i += 1) {
      addPageButton(i.toString(), i, false, currentPage === i);
    }
    addPageButton('»', totalPages, currentPage === totalPages);
  }

  const logStatus = document.getElementById('log-status');

  function showLogStatus(message, type = 'success') {
    logStatus.textContent = message;
    logStatus.classList.remove('hidden');
    logStatus.style.background = type === 'error'
      ? 'rgba(220, 53, 69, 0.08)'
      : 'rgba(40, 167, 69, 0.08)';
    logStatus.style.borderColor = type === 'error'
      ? 'rgba(220, 53, 69, 0.2)'
      : 'rgba(40, 167, 69, 0.2)';
    logStatus.style.color = type === 'error' ? '#6a1c24' : '#214f24';
    setTimeout(() => {
      logStatus.classList.add('hidden');
    }, 3000);
  }

  logTbody.addEventListener('click', async (event) => {
    const button = event.target.closest('.delete-spin-btn');
    if (!button) return;

    const spinId = button.dataset.id;
    if (!spinId) return;
    if (!confirm('Delete this spin log entry? This cannot be undone.')) return;

    button.disabled = true;
    try {
      await api(`/api/admin/spins/${encodeURIComponent(spinId)}`, { method: 'DELETE' });
      showLogStatus('Spin log entry deleted successfully.');
      scheduleLogRefresh();
    } catch (err) {
      showLogStatus(err.message, 'error');
      button.disabled = false;
    }
  });

  logSearch.addEventListener('input', () => {
    currentQuery = logSearch.value;
    currentPage = 1;
    renderLog(allSpins);
  });

  logPageSize.addEventListener('change', () => {
    pageSize = Number(logPageSize.value) || 10;
    currentPage = 1;
    renderLog(allSpins);
  });

  clearLogBtn.addEventListener('click', async () => {
    if (!confirm('Clear the entire spin history? This cannot be undone.')) return;
    try {
      await api('/api/admin/spins', { method: 'DELETE' });
      scheduleLogRefresh();
    } catch (err) {
      alert(err.message);
    }
  });

  function scheduleLogRefresh() {
    clearTimeout(logRefreshTimer);
    logRefreshTimer = setTimeout(loadLog, LOG_REFRESH_INTERVAL);
  }

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
