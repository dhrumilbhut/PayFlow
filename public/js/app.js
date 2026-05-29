/**
 * PayFlow Dashboard — Vanilla JS
 *
 * This file handles all interactivity:
 * - Navigation between sections
 * - Payment creation form
 * - Polling for payment updates
 * - Timeline modal
 * - Health status rendering
 *
 * Uses fetch() API — available in all modern browsers without dependencies.
 */

const API = ''; // same origin — relative URLs

// ── Utility ──────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error || 'Request failed'), { data: json });
  return json;
}

function formatDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString();
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusBadge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function shortId(id) {
  return `${id.slice(0, 8)}…`;
}

// ── Navigation ────────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`section-${btn.dataset.section}`).classList.add('active');
    if (btn.dataset.section === 'payments') loadPayments();
    if (btn.dataset.section === 'health') loadHealth();
    if (btn.dataset.section === 'dashboard') loadStats();
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    // Uses a dedicated stats endpoint that runs a single GROUP BY query.
    // Much more efficient than fetching all payments and counting in JS.
    const { data } = await apiFetch('/payments/stats');
    document.getElementById('stat-total').textContent      = data.total;
    document.getElementById('stat-pending').textContent    = data.pending;
    document.getElementById('stat-processing').textContent = data.processing;
    document.getElementById('stat-success').textContent    = data.success;
    document.getElementById('stat-failed').textContent     = data.failed;
  } catch (err) {
    console.error('Failed to load stats', err);
  }
}

document.getElementById('refresh-stats').addEventListener('click', loadStats);
loadStats(); // load on startup

// Auto-refresh stats every 5 seconds
setInterval(loadStats, 5000);

// ── Create Payment Form ───────────────────────────────────────────────────────

function generateKey() {
  const key = `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  document.getElementById('idempotencyKey').value = key;
}
document.getElementById('gen-key').addEventListener('click', generateKey);

document.getElementById('create-payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  const resultBox = document.getElementById('create-result');

  const amount = parseFloat(document.getElementById('amount').value);
  const idempotencyKey = document.getElementById('idempotencyKey').value.trim();

  btn.disabled = true;
  btn.textContent = 'Creating...';
  resultBox.className = 'result-box hidden';

  try {
    const { data } = await apiFetch('/payments', {
      method: 'POST',
      body: JSON.stringify({ amount, idempotencyKey }),
    });

    resultBox.className = 'result-box success';
    resultBox.innerHTML = `
      <strong>✓ Payment created</strong><br/>
      <pre>ID: ${data.id}\nStatus: ${data.status}\nAmount: $${data.amount.toFixed(2)}</pre>
    `;

    loadStats();
  } catch (err) {
    resultBox.className = 'result-box error';
    const detail = err.data?.details?.map((d) => `${d.field}: ${d.message}`).join('\n') || err.message;
    resultBox.innerHTML = `<strong>✗ Error</strong><br/><pre>${detail}</pre>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Payment';
  }
});

// ── Payments Table ────────────────────────────────────────────────────────────

async function loadPayments() {
  const tbody = document.getElementById('payments-tbody');
  const status = document.getElementById('status-filter').value;
  const url = status ? `/payments?status=${status}&limit=50` : '/payments?limit=50';

  tbody.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';

  try {
    const { data } = await apiFetch(url);

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No payments found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map((p) => `
      <tr>
        <td title="${p.id}"><code>${shortId(p.id)}</code></td>
        <td>$${p.amount.toFixed(2)}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.retryCount} / ${p.maxRetries}</td>
        <td>${formatDate(p.createdAt)}</td>
        <td><button class="btn-link" onclick="openTimeline('${p.id}')">Timeline</button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Error loading payments: ${err.message}</td></tr>`;
  }
}

document.getElementById('status-filter').addEventListener('change', loadPayments);
document.getElementById('refresh-payments').addEventListener('click', loadPayments);

// ── Timeline Modal ────────────────────────────────────────────────────────────

const modal = document.getElementById('timeline-modal');

async function openTimeline(paymentId) {
  modal.classList.remove('hidden');
  document.getElementById('modal-payment-id').textContent = `Payment ID: ${paymentId}`;
  document.getElementById('timeline-content').innerHTML = '<p style="color:var(--text-muted)">Loading timeline…</p>';

  try {
    const { data } = await apiFetch(`/payments/${paymentId}/events`);

    if (!data.length) {
      document.getElementById('timeline-content').innerHTML = '<p style="color:var(--text-muted)">No events yet.</p>';
      return;
    }

    document.getElementById('timeline-content').innerHTML = data.map((event) => {
      const metaStr = Object.keys(event.metadata).length
        ? JSON.stringify(event.metadata, null, 2)
        : '';
      return `
        <div class="timeline-item event-${event.eventType}">
          <div class="timeline-time">${formatTime(event.createdAt)}</div>
          <div class="timeline-event">${event.eventType}</div>
          ${metaStr ? `<div class="timeline-meta">${metaStr}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    document.getElementById('timeline-content').innerHTML = `<p style="color:var(--danger)">Error: ${err.message}</p>`;
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Make openTimeline accessible globally (used in onclick attributes in table)
window.openTimeline = openTimeline;

// ── Health Section ────────────────────────────────────────────────────────────

async function loadHealth() {
  const container = document.getElementById('health-content');
  container.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';

  try {
    const health = await apiFetch('/health/dependencies');

    const depsHtml = health.dependencies.map((dep) => `
      <div class="health-dep">
        <span class="health-dep-name">
          <span class="health-dot ${dep.status}"></span>${dep.name}
        </span>
        <span style="font-size:12px; color:${dep.status === 'ok' ? 'var(--success)' : 'var(--danger)'}">
          ${dep.status === 'ok' ? '● Connected' : `✗ ${dep.error || 'Unavailable'}`}
        </span>
      </div>
    `).join('');

    const cbState = health.circuitBreaker?.state || 'UNKNOWN';
    container.innerHTML = `
      <div class="card">
        <h3>Dependencies</h3>
        ${depsHtml}
      </div>
      <div class="card">
        <h3>Circuit Breaker</h3>
        <div style="display:flex; align-items:center; justify-content:space-between; padding-top:8px;">
          <span>Gateway Circuit Breaker</span>
          <span class="cb-state cb-${cbState}">${cbState}</span>
        </div>
        <div style="margin-top:16px; font-size:12px; color:var(--text-muted);">
          <div>Requests: ${health.circuitBreaker?.stats?.fires || 0}</div>
          <div>Failures: ${health.circuitBreaker?.stats?.failures || 0}</div>
          <div>Successes: ${health.circuitBreaker?.stats?.successes || 0}</div>
          <div>Timeouts: ${health.circuitBreaker?.stats?.timeouts || 0}</div>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Error loading health: ${err.message}</p>`;
  }
}

document.getElementById('refresh-health').addEventListener('click', loadHealth);
