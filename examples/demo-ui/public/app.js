// ferry402 demo-ui — vanilla JS, no build step, no frontend dependencies.
// Consumes the server's Server-Sent Events (via fetch + ReadableStream,
// since POST bodies aren't readable through the native EventSource API)
// and renders each stage into its own card. Nothing here ever receives or
// displays a private key — only addresses, tx hashes, and amounts the
// server already scrubbed (see server.ts's header comment).

'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- formatting helpers ----------

function truncateMiddle(value, front = 10, back = 8) {
  if (typeof value !== 'string') return String(value);
  if (value.length <= front + back + 1) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

function formatUsdcAtomic(atomic) {
  try {
    const n = BigInt(atomic);
    const whole = n / 1000000n;
    const frac = (n % 1000000n).toString().padStart(6, '0');
    return `$${whole.toString()}.${frac}`;
  } catch {
    return String(atomic);
  }
}

function formatMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function basescanAddress(addr) {
  return `https://sepolia.basescan.org/address/${addr}`;
}
function basescanTx(hash) {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

/** Builds a copyable, middle-truncated monospace value, optionally linked. */
function hashEl({ value, href, linkLabel, front, back }) {
  const wrap = document.createElement('span');
  wrap.className = 'hashval';

  const text = document.createElement('span');
  text.textContent = truncateMiddle(value, front, back);
  text.title = value;
  wrap.appendChild(text);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied to clipboard');
    } catch {
      toast('Copy failed — select manually');
    }
  });
  wrap.appendChild(copyBtn);

  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'ext-link';
    a.textContent = linkLabel || 'View ↗';
    wrap.appendChild(a);
  }

  return wrap;
}

function kv(dtText, ddNode) {
  const dt = document.createElement('dt');
  dt.textContent = dtText;
  const dd = document.createElement('dd');
  if (ddNode instanceof Node) dd.appendChild(ddNode);
  else dd.textContent = ddNode;
  return [dt, dd];
}

function kvGrid(pairs) {
  const dl = document.createElement('dl');
  dl.className = 'kv-grid';
  for (const [dtText, ddNode] of pairs) {
    const [dt, dd] = kv(dtText, ddNode);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}

// ---------- SSE (POST) consumption ----------

async function streamPost(url, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.message || body.error || message;
    } catch {
      // ignore — keep the generic message
    }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          onEvent(JSON.parse(json));
        } catch (err) {
          console.error('ferry402 demo-ui: could not parse SSE event', err, json);
        }
      }
    }
  }
}

// ---------- starting position ----------

async function loadState() {
  try {
    const res = await fetch('/api/state');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    $('#state-ledger').textContent = `${body.escrowLedgerRow} (${formatUsdcAtomic(body.escrowLedgerRow)})`;
    $('#state-balance').textContent = `${body.escrowRealUsdcBalance} (${formatUsdcAtomic(body.escrowRealUsdcBalance)})`;
    $('#state-journal').textContent = `${body.journalTotal} (${formatUsdcAtomic(body.journalTotal)})`;
    $('#state-meta').textContent =
      `merchant EVM ${body.merchantEvm} · escrow ${body.escrowAddress} · HCS topic ${body.topicId}` +
      (body.matches ? ' · all three agree' : ' · note: totals differ (see reconciliation step for why that can be expected)');
  } catch (err) {
    $('#state-meta').textContent = `Could not load starting position: ${err.message}`;
  }
}

// ---------- step card rendering ----------

const STEP_IDS = ['challenge', 'signed', 'served', 'settled', 'ledger', 'journal', 'reconciled'];

function setStepState(stage, status) {
  const card = $(`#step-${stage}`);
  if (!card) return;
  card.classList.remove('is-active', 'is-done', 'is-failed');
  if (status === 'running') card.classList.add('is-active');
  if (status === 'done') card.classList.add('is-done');
  if (status === 'failed') card.classList.add('is-failed');
  $('[data-field="status"]', card).textContent = status;
}

function setStepTiming(stage, durationMs) {
  const card = $(`#step-${stage}`);
  if (!card || durationMs == null) return;
  $('[data-field="timing"]', card).textContent = formatMs(durationMs);
}

function setStepBody(stage, node) {
  const card = $(`#step-${stage}`);
  if (!card) return;
  const body = $('[data-field="body"]', card);
  body.innerHTML = '';
  body.appendChild(node);
}

function renderChallenge(data) {
  const node = document.createElement('div');
  node.appendChild(kvGrid([
    ['HTTP status', `${data.httpStatus} (Payment Required, as expected)`],
    ['Resource', data.resource],
    ['Network', data.network],
    ['Price', `${data.maxAmountRequired} atomic USDC (${formatUsdcAtomic(data.maxAmountRequired)})`],
    ['Pay to (escrow)', hashEl({ value: data.payTo, href: basescanAddress(data.payTo), linkLabel: 'Basescan ↗' })],
    ['Derived paymentId', hashEl({ value: data.paymentId })],
    ['Derived nonce', hashEl({ value: data.nonce })],
  ]));
  if (data.resourceNote) {
    const note = document.createElement('p');
    note.className = 'step-note';
    note.textContent = data.resourceNote;
    node.appendChild(note);
  }
  return node;
}

function renderSigned(data) {
  const node = document.createElement('div');
  node.appendChild(kvGrid([
    ['Signed by', hashEl({ value: data.signer, href: basescanAddress(data.signer), linkLabel: 'Basescan ↗' })],
    ['Header length', `${data.headerLength} base64 chars`],
  ]));
  return node;
}

function renderServed(data) {
  const node = document.createElement('div');
  node.appendChild(kvGrid([
    ['HTTP status', `${data.httpStatus} OK — resource served`],
    ['Resource', data.resource],
  ]));
  const pre = document.createElement('pre');
  pre.className = 'quote-json';
  pre.textContent = JSON.stringify(data.quote, null, 2);
  node.appendChild(pre);
  return node;
}

function renderSettled(data) {
  const node = document.createElement('div');
  node.appendChild(kvGrid([
    ['Transaction', hashEl({ value: data.transaction, href: data.basescanUrl, linkLabel: 'Basescan ↗' })],
    ['Network', data.network],
    ['Amount settled', `${data.settledAmount} atomic USDC (${formatUsdcAtomic(data.settledAmount)})`],
    ['Gas used', data.gasUsed],
  ]));
  return node;
}

function renderLedger(data) {
  const node = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'ledger-row';
  row.innerHTML = `
    <div class="ledger-num"><span class="num">${data.before}</span><span class="label">before</span></div>
    <div class="ledger-arrow">→</div>
    <div class="ledger-num"><span class="num">${data.after}</span><span class="label">after</span></div>
    <div class="ledger-delta">+${data.delta} atomic USDC (${formatUsdcAtomic(data.delta)})</div>
  `;
  node.appendChild(row);
  const meta = document.createElement('p');
  meta.className = 'check-note';
  meta.textContent = `Confirmed after ${data.attempts} read${data.attempts === 1 ? '' : 's'} against ${data.rpcUrl}.`;
  node.appendChild(meta);
  return node;
}

function renderJournal(data) {
  const node = document.createElement('div');
  node.appendChild(kvGrid([
    ['Sequence number', `#${data.sequenceNumber}`],
    ['Consensus timestamp', hashEl({ value: data.consensusTimestamp, href: data.hashscanTxUrl, linkLabel: 'Hashscan ↗', front: 14, back: 6 })],
    ['Topic', hashEl({ value: data.topicId, href: data.hashscanTopicUrl, linkLabel: 'Hashscan topic ↗' })],
  ]));
  const pre = document.createElement('pre');
  pre.className = 'entry-json';
  pre.textContent = JSON.stringify(data.entry, null, 2);
  node.appendChild(pre);
  return node;
}

function renderReconciled(data) {
  const node = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'reconcile-grid';
  const tiles = [
    ['HCS journal total', data.journalTotal],
    ['Escrow ledger row', data.escrowLedgerRow],
    ['Escrow real USDC balance', data.escrowRealUsdcBalance],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'reconcile-tile';
    tile.innerHTML = `<span class="label">${label}</span><span class="value">${value}</span>`;
    grid.appendChild(tile);
  }
  node.appendChild(grid);

  const verdict = document.createElement('div');
  verdict.className = `reconcile-verdict ${data.matches ? 'match' : 'mismatch'}`;
  verdict.innerHTML = data.matches
    ? '<span class="glyph">✓</span> ALL THREE AGREE'
    : '<span class="glyph">⚠</span> NUMBERS DIFFER (see note below)';
  node.appendChild(verdict);

  if (!data.matches) {
    const note = document.createElement('p');
    note.className = 'check-note';
    note.textContent = 'Can legitimately differ if this escrow/topic has prior activity from other merchants or runs predating this journal query window.';
    node.appendChild(note);
  }
  return node;
}

const STEP_RENDERERS = {
  challenge: renderChallenge,
  signed: renderSigned,
  served: renderServed,
  settled: renderSettled,
  ledger: renderLedger,
  journal: renderJournal,
  reconciled: renderReconciled,
};

function renderError(stage, message) {
  const node = document.createElement('p');
  node.className = 'placeholder';
  node.style.color = 'var(--bad-text)';
  node.textContent = `Failed: ${message}`;
  setStepBody(stage, node);
}

// ---------- run a payment ----------

const runBtn = $('#run-btn');
const runErrorBanner = $('#run-error');
const elapsedEl = $('#run-elapsed');
const checkButtons = $all('[data-check]');

function setBusy(busy) {
  runBtn.disabled = busy;
  for (const btn of checkButtons) btn.disabled = busy;
}

let elapsedTimer = null;
function startElapsedTimer() {
  const start = Date.now();
  elapsedEl.textContent = '0.0s';
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = `${((Date.now() - start) / 1000).toFixed(1)}s`;
  }, 100);
}
function stopElapsedTimer(finalMs) {
  clearInterval(elapsedTimer);
  if (finalMs != null) elapsedEl.textContent = `${(finalMs / 1000).toFixed(1)}s total`;
}

async function runPayment() {
  runErrorBanner.hidden = true;
  setBusy(true);
  for (const id of STEP_IDS) {
    setStepState(id, 'pending');
    $(`#step-${id} [data-field="timing"]`).textContent = '';
  }
  startElapsedTimer();

  let failed = false;
  try {
    await streamPost('/api/run', (event) => {
      const { stage, status, durationMs, data } = event;
      if (stage === 'complete') {
        stopElapsedTimer(durationMs);
        return;
      }
      if (stage === 'error') {
        failed = true;
        runErrorBanner.hidden = false;
        runErrorBanner.textContent = `Run failed: ${data?.message ?? 'unknown error'}`;
        return;
      }
      if (!STEP_RENDERERS[stage]) return;
      setStepState(stage, status);
      setStepTiming(stage, durationMs);
      if (status === 'done') {
        setStepBody(stage, STEP_RENDERERS[stage](data));
      } else if (status === 'failed') {
        renderError(stage, data?.error ?? 'rejected unexpectedly');
      }
    });
  } catch (err) {
    failed = true;
    runErrorBanner.hidden = false;
    runErrorBanner.textContent = `Run failed: ${err.message}`;
  } finally {
    if (failed) stopElapsedTimer();
    setBusy(false);
    loadState();
  }
}

runBtn.addEventListener('click', runPayment);
$('#refresh-state-btn').addEventListener('click', loadState);

// ---------- security checks ----------

const CHECK_LABELS = {
  replay: 'invalid_payment',
  'cross-route': 'invalid_payment',
  'zero-balance': 'insufficient_funds',
};

function renderCheckResult(container, data) {
  container.innerHTML = '';

  const pill = document.createElement('span');
  pill.className = `verdict-pill ${data.correct ? 'correct' : 'wrong'}`;
  pill.textContent = data.correct ? 'Correctly rejected' : 'Unexpected result';
  container.appendChild(pill);

  const code = document.createElement('span');
  code.className = 'reason-code';
  code.textContent = data.reasonCode ?? `HTTP ${data.httpStatus}`;
  container.appendChild(document.createElement('br'));
  container.appendChild(code);

  const note = document.createElement('p');
  note.className = 'check-note';
  note.textContent = data.note || '';
  container.appendChild(note);

  if (data.fundedFresh) {
    const fundedNote = document.createElement('p');
    fundedNote.className = 'check-note';
    fundedNote.textContent = 'No prior payment existed yet, so this check made one real payment first to have a consumed nonce to replay.';
    container.appendChild(fundedNote);
  }
}

async function runCheck(kind) {
  const container = $(`#check-${kind} [data-field="result"]`);
  container.innerHTML = '<span class="check-running">Running…</span>';
  setBusy(true);
  try {
    await streamPost(`/api/check/${kind}`, (event) => {
      const { stage, data } = event;
      if (stage === 'error') {
        container.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'placeholder';
        p.style.color = 'var(--bad-text)';
        p.textContent = `Failed: ${data?.message ?? 'unknown error'}`;
        container.appendChild(p);
        return;
      }
      if (stage !== 'check') return;
      // Intermediate "running" events (the bare {kind}, or a note about a
      // setup payment) carry no verdict yet — only a final event has
      // `rejected`. Keep showing a running indicator until then, rather
      // than rendering a half-filled, momentarily-wrong verdict pill.
      if (data.rejected === undefined) {
        container.innerHTML = `<span class="check-running">${data.note ?? 'Running…'}</span>`;
        return;
      }
      renderCheckResult(container, data);
    });
  } catch (err) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.style.color = 'var(--bad-text)';
    p.textContent = `Failed: ${err.message}`;
    container.appendChild(p);
  } finally {
    setBusy(false);
    loadState();
  }
}

for (const btn of checkButtons) {
  btn.addEventListener('click', () => runCheck(btn.dataset.check));
}

// ---------- init ----------

loadState();
