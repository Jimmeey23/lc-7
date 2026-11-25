// LC-7 Control Room — vanilla JS single-page app. All server data is escaped
// before it is inserted into the DOM.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const state = {
    session: null,
    locations: [],
    location: localStorage.getItem('lc7.location') || 'default',
    view: 'overview',
    overview: null,
    members: { status: 'active', q: '', rows: [], loading: false },
    lines: [],
    live: { connected: false, paused: false, level: 'all' },
    running: {},
    source: null
};

const STATUS = {
    DETECTED: { label: 'Detected', tone: 'info' },
    LC7_TAG_ASSIGNED: { label: 'Tag added', tone: 'info' },
    FUTURE_BOOKINGS_CANCELLED: { label: 'Bookings cancelled', tone: 'info' },
    WAITING_7_DAYS: { label: 'Serving LC-7', tone: 'accent' },
    P57_TAG_ASSIGNED: { label: 'Restored', tone: 'ok' },
    OVERRIDE: { label: 'Override pending', tone: 'warn' },
    FAILED: { label: 'Needs attention', tone: 'bad' },
    RETRY_PENDING: { label: 'Retry pending', tone: 'warn' }
};

const NAV = [
    { id: 'overview', label: 'Overview', icon: '◎' },
    { id: 'members', label: 'Members', icon: '◐' },
    { id: 'at-risk', label: 'At risk', icon: '△' },
    { id: 'activity', label: 'Live activity', icon: '≋' },
    { id: 'runs', label: 'Run history', icon: '↻' },
    { id: 'emails', label: 'Emails', icon: '✉' },
    { id: 'locations', label: 'Locations', icon: '⌖' }
];

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-LC7-Request': '1' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty */ }
    if (response.status === 401 && path !== '/api/login') {
        state.session = { ...(state.session || {}), authenticated: false };
        render();
        throw new Error('Signed out');
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}
const L = path => `/api/l/${encodeURIComponent(state.location)}${path}`;

// ---------- Helpers ----------
function parseSheetDate(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
        const [, d, m, y, hh = '00', mm = '00', ss = '00'] = match;
        return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+05:30`);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}
function rel(date) {
    if (!date) return '';
    const diff = date.getTime() - Date.now();
    const abs = Math.abs(diff);
    const units = [['d', 86400000], ['h', 3600000], ['m', 60000]];
    for (const [unit, ms] of units) {
        if (abs >= ms) {
            const n = Math.round(abs / ms);
            return diff > 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
        }
    }
    return diff > 0 ? 'in <1m' : 'just now';
}
function fmt(date) {
    if (!date) return '—';
    return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function fmtCell(value) {
    const date = parseSheetDate(value);
    return date ? `<span class="date" title="${esc(value)}">${esc(fmt(date))}</span>` : '<span class="muted">—</span>';
}
function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
}
function hue(text) {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}
function avatar(name, id) {
    return `<div class="avatar" style="background:hsl(${hue(id || name)} 45% 90%);color:hsl(${hue(id || name)} 40% 28%)">${esc(initials(name))}</div>`;
}
function statusPill(status) {
    const info = STATUS[status] || { label: status || 'Unknown', tone: '' };
    return `<span class="pill ${info.tone}">${esc(info.label)}</span>`;
}
function toast(message, tone = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), tone === 'bad' ? 7000 : 4000);
}
function currentLocation() {
    return state.locations.find(loc => loc.id === state.location) || state.locations[0] || { id: 'default', name: 'Primary location' };
}
function blockProgress(cycle) {
    const start = parseSheetDate(cycle.lc7TagAssignedAt || cycle.latestLateCancellationAt);
    const end = parseSheetDate(cycle.p57EligibleAt);
    if (!start || !end || end <= start) return 0;
    return Math.max(0, Math.min(100, ((Date.now() - start) / (end - start)) * 100));
}

// ---------- Live stream ----------
function connectLive() {
    if (state.source) state.source.close();
    const source = new EventSource(`/api/live?location=${encodeURIComponent(state.location)}`);
    state.source = source;
    source.addEventListener('hello', event => {
        const data = JSON.parse(event.data);
        state.lines = data.lines;
        for (const [id, st] of Object.entries(data.state || {})) state.running[id] = st.running;
        state.live.connected = true;
        updateLiveBits();
        appendFeedLine();
        if (state.view === 'activity') renderConsole();
    });
    source.addEventListener('line', event => {
        const line = JSON.parse(event.data);
        state.lines.push(line);
        if (state.lines.length > 1500) state.lines.splice(0, state.lines.length - 1500);
        if (!state.live.paused) appendConsoleLine(line);
        appendFeedLine(line);
    });
    source.addEventListener('run', event => {
        const data = JSON.parse(event.data);
        state.running[data.location] = data.running;
        updateLiveBits();
        if (!data.running && data.location === state.location) {
            toast(data.status === 'FAILED' ? 'Run finished with an error — see Live activity.' : 'Run complete.', data.status === 'FAILED' ? 'bad' : 'ok');
            softRefresh();
        }
    });
    source.addEventListener('changed', event => {
        const data = JSON.parse(event.data);
        if (data.location === state.location) scheduleSoftRefresh();
    });
    source.onerror = () => {
        state.live.connected = false;
        updateLiveBits();
    };
    source.onopen = () => {
        state.live.connected = true;
        updateLiveBits();
    };
}

let refreshTimer = null;
function scheduleSoftRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(softRefresh, 1200);
}
function softRefresh() {
    if (['overview', 'members', 'at-risk', 'runs', 'emails'].includes(state.view)) loadView(true);
}

function updateLiveBits() {
    const running = state.running[state.location];
    const dot = $('#live-dot');
    if (dot) dot.className = `live-dot ${running ? 'busy' : state.live.connected ? 'on' : ''}`;
    const label = $('#live-label');
    if (label) label.textContent = running ? 'Processing…' : state.live.connected ? 'Live' : 'Reconnecting…';
    const runBtn = $('#run-now');
    if (runBtn) {
        runBtn.disabled = Boolean(running);
        runBtn.innerHTML = running ? '<span class="spinner"></span> Running' : '↻ Run now';
    }
}

// ---------- Rendering ----------
function render() {
    const app = $('#app');
    if (!state.session) {
        app.innerHTML = '<div class="login"><div class="login-panel"><div class="spinner"></div></div></div>';
        return;
    }
    if (!state.session.authenticated) return renderLogin(app);
    renderShell(app);
}

function renderLogin(app) {
    app.innerHTML = `
    <div class="login">
        <div class="login-art">
            <div class="brand"><div class="brand-mark">7</div><div><div class="brand-name">LC-7 Control Room</div><div class="brand-sub">Late-cancellation lifecycle</div></div></div>
            <div>
                <h1>Fair booking rules, running on their own.</h1>
                <p>Watch late cancellations arrive in real time, see who is serving LC-7, step in when a member needs an exception, and roll the same rules out to new cities.</p>
            </div>
            <div class="small" style="color:#7b7872">Physique 57 · Momence automation</div>
        </div>
        <div class="login-panel">
            <form class="login-card" id="login-form">
                <h2>Sign in</h2>
                <p class="muted" style="margin:0 0 22px">Enter the admin password to continue.</p>
                ${state.session.configured ? '' : '<div class="form-error">The dashboard is locked. Set <b>ADMIN_PASSWORD</b> in Railway variables, then reload.</div>'}
                <div id="login-error"></div>
                <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required autofocus></div>
                <button class="btn primary block" type="submit" ${state.session.configured ? '' : 'disabled'}>Continue</button>
            </form>
        </div>
    </div>`;
    $('#login-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('#login-form button');
        button.disabled = true;
        try {
            await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
            await boot();
        } catch (error) {
            $('#login-error').innerHTML = `<div class="form-error">${esc(error.message)}</div>`;
            button.disabled = false;
        }
    });
}

function renderShell(app) {
    const loc = currentLocation();
    const counts = state.overview?.counts || {};
    const badge = { members: counts.active, 'at-risk': counts.atRisk };
    app.innerHTML = `
    <div class="shell">
        <aside class="side">
            <div class="brand"><div class="brand-mark">7</div><div><div class="brand-name">LC-7 Control Room</div><div class="brand-sub">Late-cancellation lifecycle</div></div></div>
            <div class="loc-switch">
                <label for="loc-select">Location</label>
                <select id="loc-select">${state.locations.map(item => `<option value="${esc(item.id)}" ${item.id === state.location ? 'selected' : ''}>${esc(item.name)}${item.enabled === false ? ' (paused)' : ''}</option>`).join('')}</select>
            </div>
            <nav class="nav">${NAV.map(item => `<a href="#/${item.id}" class="${state.view === item.id ? 'active' : ''}"><span class="nav-icon">${item.icon}</span>${item.label}${badge[item.id] ? `<span class="count">${badge[item.id]}</span>` : ''}</a>`).join('')}</nav>
            <div class="side-foot">
                <div>Rules: 3 unlimited-membership late cancellations within 7 days → LC-7 for 7 days.</div>
                <button id="logout">Sign out</button>
            </div>
        </aside>
        <main class="main">
            <header class="top">
                <div>
                    <h1>${esc(NAV.find(item => item.id === state.view)?.label || '')}</h1>
                    <div class="sub">${esc(loc.name)}${loc.dryRun ? ' · dry run' : ''}</div>
                </div>
                <div class="top-actions">
                    <span class="status-chip"><span id="live-dot" class="live-dot"></span><span id="live-label">Connecting…</span></span>
                    ${state.view === 'members' || state.view === 'overview' ? '<button class="btn" id="block-btn">⛔ Block a member</button>' : ''}
                    <button class="btn primary" id="run-now">↻ Run now</button>
                </div>
            </header>
            <section class="content" id="content"></section>
        </main>
    </div>`;
    $('#loc-select').addEventListener('change', event => {
        state.location = event.target.value;
        localStorage.setItem('lc7.location', state.location);
        state.overview = null;
        state.members.rows = [];
        connectLive();
        render();
        loadView();
    });
    $('#logout').addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        if (state.source) state.source.close();
        state.session = { ...state.session, authenticated: false };
        render();
    });
    $('#run-now').addEventListener('click', runNow);
    $('#block-btn')?.addEventListener('click', () => openBlockModal());
    updateLiveBits();
    renderView();
}

function setContent(html) {
    const el = $('#content');
    if (el) el.innerHTML = html;
    return el;
}

function loadingCard(rows = 5) {
    return `<div class="card"><div class="card-body">${Array.from({ length: rows }, () => '<div class="skeleton" style="margin:12px 0"></div>').join('')}</div></div>`;
}

function errorBanner(message) {
    return `<div class="banner bad">⚠ ${esc(message)}</div>`;
}

function renderView() {
    const views = {
        overview: renderOverview,
        members: renderMembers,
        'at-risk': renderAtRisk,
        activity: renderActivity,
        runs: renderRuns,
        emails: renderEmails,
        locations: renderLocations
    };
    (views[state.view] || renderOverview)();
}

async function loadView(soft = false) {
    try {
        if (state.view === 'overview') {
            state.overview = await api(L('/overview'));
            if (!soft) render(); else renderOverview();
        } else if (state.view === 'members') {
            await loadMembers();
        } else {
            renderView();
        }
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

// ---------- Overview ----------
function renderOverview() {
    const data = state.overview;
    if (!data) return setContent(`<div class="grid kpis">${'<div class="card kpi"><div class="skeleton"></div><div class="skeleton" style="height:34px;margin-top:12px"></div></div>'.repeat(5)}</div>${loadingCard()}`);
    if (data.error) {
        return setContent(`${errorBanner(`Could not load this location: ${data.error}`)}<p class="muted">Open <a href="#/locations">Locations</a> to check its settings and secrets.</p>`);
    }
    const c = data.counts;
    const runs = data.recentRuns || [];
    const lastRun = runs.find(run => !String(run.runId).startsWith('webhook:'));
    setContent(`
    ${data.location.dryRun ? '<div class="banner">🧪 Dry run is on for this location — Momence is not changed and emails are not sent.</div>' : ''}
    <div class="grid kpis">
        <div class="card kpi accent clickable" data-go="members"><div class="bar"></div><div class="label">Serving LC-7 now</div><div class="value">${c.active}</div><div class="hint">${c.dueSoon} restore within 24h</div></div>
        <div class="card kpi warn clickable" data-go="at-risk"><div class="bar"></div><div class="label">At risk</div><div class="value">${c.atRisk}</div><div class="hint">1–2 late cancels in window</div></div>
        <div class="card kpi"><div class="bar"></div><div class="label">Blocked this week</div><div class="value">${c.startedThisWeek}</div><div class="hint">last 7 days</div></div>
        <div class="card kpi ok"><div class="bar"></div><div class="label">Restored this week</div><div class="value">${c.restoredThisWeek}</div><div class="hint">P57 back on</div></div>
        <div class="card kpi ${c.failed ? 'bad clickable' : ''}" data-go="members" data-status="FAILED"><div class="bar"></div><div class="label">Needs attention</div><div class="value">${c.failed}</div><div class="hint">failed steps, auto-retried</div></div>
    </div>
    <div class="grid two">
        <div class="card">
            <div class="card-head"><h3>Recent processing</h3><div class="right"><a class="btn sm ghost" href="#/runs">All runs →</a></div></div>
            <div class="table-wrap"><table>
                <thead><tr><th>When</th><th>Type</th><th>Result</th><th>Blocked</th><th>Restored</th><th>Emails</th></tr></thead>
                <tbody>${runs.slice(0, 10).map(run => `
                    <tr><td>${fmtCell(run.startedAt)}</td>
                    <td>${String(run.runId).startsWith('webhook:') ? '<span class="pill info plain">Webhook</span>' : '<span class="pill plain">Scheduled</span>'}</td>
                    <td>${run.status === 'FAILED' || Number(run.failedCount) > 0 ? `<span class="pill bad">${run.status === 'FAILED' ? 'Failed' : `${esc(run.failedCount)} issue(s)`}</span>` : '<span class="pill ok">OK</span>'}
                        <div class="small muted" style="max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(run.message)}">${esc(String(run.message || '').replace(/^Webhook \S+ /, ''))}</div></td>
                    <td>${esc(run.lc7Assigned || 0)}</td><td>${esc(run.p57Assigned || 0)}</td><td>${esc(run.emailsSent || 0)}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">No runs yet.</div></td></tr>'}
                </tbody></table></div>
        </div>
        <div class="card">
            <div class="card-head"><h3>Live activity</h3><div class="right"><a class="btn sm ghost" href="#/activity">Open console →</a></div></div>
            <div class="feed" id="feed">${feedHtml()}</div>
        </div>
    </div>
    <div class="card">
        <div class="card-head"><h3>How this location runs</h3></div>
        <div class="card-body small">
            <dl class="kv">
                <dt>Last scheduled run</dt><dd>${lastRun ? `${esc(fmt(parseSheetDate(lastRun.startedAt)))} · ${esc(rel(parseSheetDate(lastRun.startedAt)))}` : '—'}</dd>
                <dt>Real-time webhooks</dt><dd>${data.location.secrets.find(s => s.name.endsWith('MOMENCE_WEBHOOK_SECRET'))?.set ? '<span class="pill ok">On</span>' : '<span class="pill warn">Off — hourly runs only</span>'} <span class="mono muted">${esc(data.location.webhookUrl)}</span></dd>
                <dt>Momence tags</dt><dd>LC-7 <span class="mono">${esc(data.location.lc7TagId)}</span> · P57 <span class="mono">${esc(data.location.p57TagId)}</span></dd>
                <dt>Emails logged</dt><dd>${data.emailStats.sent} sent · ${data.emailStats.failed} failed attempts</dd>
                <dt>Data refreshed</dt><dd>${esc(rel(new Date(data.loadedAt)))}</dd>
            </dl>
        </div>
    </div>`);
    $$('[data-go]').forEach(el => el.addEventListener('click', () => {
        if (el.dataset.status) state.members.status = el.dataset.status;
        location.hash = `#/${el.dataset.go}`;
    }));
}

function feedHtml() {
    const lines = state.lines.filter(line => !line.location || line.location === state.location).slice(-14).reverse();
    if (!lines.length) return '<div class="empty small">Waiting for activity…</div>';
    return lines.map(line => `<div class="feed-item"><div class="when">${esc(new Date(line.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }))}</div><div class="${line.level === 'error' ? 'pill bad plain' : ''}" style="${line.level === 'error' ? '' : 'flex:1'}">${esc(line.message.slice(0, 220))}</div></div>`).join('');
}
function appendFeedLine() {
    const feed = $('#feed');
    if (feed) feed.innerHTML = feedHtml();
}

// ---------- Members ----------
async function loadMembers() {
    const { status, q } = state.members;
    state.members.loading = true;
    renderMembers();
    try {
        const data = await api(L(`/members?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`));
        state.members.rows = data.rows;
        state.members.loadedAt = data.loadedAt;
    } finally {
        state.members.loading = false;
        renderMembers();
    }
}

function renderMembers() {
    const m = state.members;
    const filters = [
        ['active', 'Active'], ['WAITING_7_DAYS', 'Serving LC-7'], ['FAILED', 'Needs attention'],
        ['P57_TAG_ASSIGNED', 'Restored'], ['all', 'All']
    ];
    let el = $('#members-table');
    if (!el) {
        setContent(`
        <div class="toolbar">
            <div class="chips">${filters.map(([id, label]) => `<button class="chip ${m.status === id ? 'active' : ''}" data-status="${id}">${label}</button>`).join('')}</div>
            <div class="search" style="margin-left:auto"><span class="muted">⌕</span><input id="member-search" placeholder="Search name, email or member ID" value="${esc(m.q)}"></div>
        </div>
        <div class="card" id="members-table"></div>`);
        $$('.chip[data-status]').forEach(chip => chip.addEventListener('click', () => {
            state.members.status = chip.dataset.status;
            $$('.chip[data-status]').forEach(c => c.classList.toggle('active', c === chip));
            loadMembers();
        }));
        let timer;
        $('#member-search').addEventListener('input', event => {
            clearTimeout(timer);
            timer = setTimeout(() => { state.members.q = event.target.value; loadMembers(); }, 300);
        });
        el = $('#members-table');
    }
    if (m.loading && !m.rows.length) { el.innerHTML = loadingCard(6); return; }
    if (!m.rows.length) {
        el.innerHTML = `<div class="empty"><div class="big">No members here</div>${m.status === 'active' ? 'Nobody is on LC-7 right now.' : 'Try a different filter.'}</div>`;
        return;
    }
    el.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Member</th><th>Status</th><th>Blocked</th><th>Restores</th><th>Progress</th><th>Reason</th></tr></thead>
        <tbody>${m.rows.map(cycle => {
            const ends = parseSheetDate(cycle.p57EligibleAt);
            const serving = cycle.status === 'WAITING_7_DAYS';
            return `<tr class="clickable" data-cycle="${esc(cycle.cycleId)}">
                <td><div class="member-cell">${avatar(cycle.memberName, cycle.memberId)}<div><div class="member-name">${esc(cycle.memberName || `Member ${cycle.memberId}`)}</div><div class="member-sub">${esc(cycle.memberEmail || '')} · #${esc(cycle.memberId)}</div></div></div></td>
                <td>${statusPill(cycle.status)}${cycle.lastError ? `<div class="small" style="color:var(--bad);max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(cycle.lastError)}">${esc(cycle.lastError)}</div>` : ''}</td>
                <td>${fmtCell(cycle.lc7TagAssignedAt || cycle.latestLateCancellationAt)}</td>
                <td>${fmtCell(cycle.p57EligibleAt)}${serving && ends ? `<div class="small muted">${esc(rel(ends))}</div>` : ''}</td>
                <td>${serving ? `<div class="progress"><span style="width:${blockProgress(cycle).toFixed(0)}%"></span></div>` : '<span class="muted">—</span>'}</td>
                <td class="small muted" style="max-width:280px"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(cycle.assignmentReason)}">${esc(cycle.assignmentReason || '')}</div></td>
            </tr>`;
        }).join('')}</tbody></table></div>`;
    $$('tr[data-cycle]', el).forEach(row => row.addEventListener('click', () => {
        const cycle = state.members.rows.find(item => item.cycleId === row.dataset.cycle);
        if (cycle) openCycleDrawer(cycle);
    }));
}

function closeOverlay() {
    $$('.scrim, .drawer, .modal').forEach(el => el.remove());
}
function overlay(html, cls) {
    closeOverlay();
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.addEventListener('click', closeOverlay);
    const panel = document.createElement('div');
    panel.className = cls;
    panel.innerHTML = html;
    document.body.append(scrim, panel);
    $$('[data-close]', panel).forEach(btn => btn.addEventListener('click', closeOverlay));
    return panel;
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeOverlay(); });

function toLocalInput(date) {
    const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
}

function openCycleDrawer(cycle) {
    const serving = cycle.status === 'WAITING_7_DAYS';
    const canEnd = !['P57_TAG_ASSIGNED'].includes(cycle.status);
    const ends = parseSheetDate(cycle.p57EligibleAt);
    const steps = [
        { t: 'Late cancellation threshold reached', d: cycle.latestLateCancellationAt, done: true },
        { t: 'LC-7 tag added in Momence', d: cycle.lc7TagAssignedAt, done: Boolean(cycle.lc7TagAssignedAt) },
        { t: `Future bookings cancelled${cycle.futureBookingsCancelledCount !== '' ? ` (${cycle.futureBookingsCancelledCount || 0})` : ''}`, d: '', done: ['WAITING_7_DAYS', 'P57_TAG_ASSIGNED'].includes(cycle.status) },
        { t: 'LC-7 removed, P57 restored', d: cycle.p57TagAssignedAt || cycle.p57EligibleAt, done: Boolean(cycle.p57TagAssignedAt), now: serving }
    ];
    const panel = overlay(`
        <div class="drawer-head">${avatar(cycle.memberName, cycle.memberId)}
            <div><h2>${esc(cycle.memberName || `Member ${cycle.memberId}`)}</h2><div class="muted small">${esc(cycle.memberEmail || '')} · #${esc(cycle.memberId)}</div><div style="margin-top:8px">${statusPill(cycle.status)}</div></div>
            <button class="close" data-close aria-label="Close">×</button></div>
        <div class="drawer-body">
            ${cycle.lastError ? `<div class="form-error">${esc(cycle.lastError)}</div>` : ''}
            <div class="section-title" style="margin-top:0">Timeline</div>
            <div class="timeline">${steps.map(step => `<div class="tl-item ${step.done ? 'done' : ''} ${step.now ? 'now' : ''}"><div class="t">${esc(step.t)}</div><div class="d">${step.d ? esc(fmt(parseSheetDate(step.d))) : ''}${step.now && ends ? ` · ${esc(rel(ends))}` : ''}</div></div>`).join('')}</div>
            <div class="section-title">Details</div>
            <dl class="kv">
                <dt>Reason</dt><dd>${esc(cycle.assignmentReason || '—')}</dd>
                <dt>Last action</dt><dd>${esc(cycle.actionComment || '—')}</dd>
                <dt>Retries</dt><dd>${esc(cycle.retryCount || 0)}</dd>
                <dt>Updated</dt><dd>${esc(cycle.updatedAt || '—')}</dd>
                <dt>Cycle ID</dt><dd class="mono muted">${esc(cycle.cycleId)}</dd>
            </dl>
            ${serving ? `
            <div class="section-title">Change when the block ends</div>
            <div class="row" style="align-items:end"><div class="field" style="margin:0"><label for="end-date">Restore booking on</label><input id="end-date" type="datetime-local" value="${ends ? toLocalInput(ends) : ''}"></div>
            <button class="btn" id="save-end">Save date</button></div>` : ''}
            ${canEnd ? `
            <div class="section-title">End block now</div>
            <div class="note" style="margin-bottom:10px">Removes the LC-7 tag and adds P57 in Momence straight away. Cancelled bookings are not re-booked.</div>
            <div class="field"><label for="end-note">Note (optional)</label><input id="end-note" placeholder="e.g. Medical emergency, approved by manager"></div>
            <label class="check"><input type="checkbox" id="end-silent"><div><strong>Don't email the member</strong><span>Skip the “booking privileges restored” email.</span></div></label>` : ''}
        </div>
        <div class="drawer-foot">
            ${canEnd ? '<button class="btn accent" id="end-now">End block & restore P57</button>' : ''}
            ${cycle.status === 'FAILED' ? '<button class="btn" id="retry">Retry failed step</button>' : ''}
            <button class="btn ghost" data-close>Close</button>
        </div>`, 'drawer');

    $('#save-end', panel)?.addEventListener('click', async event => {
        const value = $('#end-date', panel).value;
        if (!value) return;
        await withBusy(event.target, async () => {
            await api(L(`/cycles/${encodeURIComponent(cycle.cycleId)}/end-date`), { method: 'POST', body: { endsAt: new Date(value).toISOString() } });
            toast('End date updated.');
            closeOverlay();
            loadMembers();
        });
    });
    $('#end-now', panel)?.addEventListener('click', async event => {
        if (!confirm(`End the LC-7 block for ${cycle.memberName || cycle.memberId} now?`)) return;
        await withBusy(event.target, async () => {
            const result = await api(L(`/cycles/${encodeURIComponent(cycle.cycleId)}/end`), {
                method: 'POST',
                body: { silent: $('#end-silent', panel).checked, note: $('#end-note', panel).value }
            });
            toast(`Block ended. P57 restored${result.emailsSent ? ' and member emailed' : ''}.`);
            closeOverlay();
            loadMembers();
        });
    });
    $('#retry', panel)?.addEventListener('click', async event => {
        await withBusy(event.target, async () => {
            await api(L(`/cycles/${encodeURIComponent(cycle.cycleId)}/retry`), { method: 'POST' });
            toast('Retry finished — check the status.');
            closeOverlay();
            loadMembers();
        });
    });
}

async function withBusy(button, fn) {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Working…';
    try {
        await fn();
    } catch (error) {
        if (error.message !== 'Signed out') toast(error.message, 'bad');
    } finally {
        button.disabled = false;
        button.innerHTML = original;
    }
}

function openBlockModal() {
    const panel = overlay(`
        <div class="modal-head"><div><h2>Block a member</h2><p>Puts the member on LC-7 now, using the same steps as an automatic trigger.</p></div><button class="close" data-close aria-label="Close">×</button></div>
        <form id="block-form">
        <div class="modal-body">
            <div id="block-error"></div>
            <div class="row" style="align-items:end">
                <div class="field"><label for="b-id">Momence member ID</label><input id="b-id" inputmode="numeric" required placeholder="e.g. 1565384"></div>
                <div class="field"><button type="button" class="btn" id="b-lookup">Look up</button></div>
            </div>
            <div class="row">
                <div class="field"><label for="b-name">Name</label><input id="b-name" placeholder="Filled in by look-up"></div>
                <div class="field"><label for="b-email">Email</label><input id="b-email" type="email" placeholder="Filled in by look-up"></div>
            </div>
            <div class="row">
                <div class="field"><label for="b-days">Block length</label><select id="b-days">${[1, 2, 3, 5, 7, 10, 14, 21, 30].map(d => `<option value="${d}" ${d === 7 ? 'selected' : ''}>${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></div>
                <div class="field"><label for="b-reason">Reason</label><input id="b-reason" placeholder="e.g. No-shows reported by front desk"></div>
            </div>
            <label class="check"><input type="checkbox" id="b-cancel" checked><div><strong>Cancel their future bookings</strong><span>Same as an automatic LC-7 block. Untick to keep existing bookings.</span></div></label>
            <label class="check"><input type="checkbox" id="b-silent"><div><strong>Don't email the member</strong><span>Skip the “booking privileges paused” and later “restored” emails.</span></div></label>
        </div>
        <div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn accent" type="submit">Block member</button></div>
        </form>`, 'modal');
    $('#b-lookup', panel).addEventListener('click', async event => {
        const id = $('#b-id', panel).value.trim();
        if (!id) return;
        await withBusy(event.target, async () => {
            const member = await api(L(`/member-lookup?memberId=${encodeURIComponent(id)}`));
            $('#b-name', panel).value = member.name;
            $('#b-email', panel).value = member.email;
            if (!member.name) toast('Member found but has no name on file.', 'bad');
        });
    });
    $('#block-form', panel).addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('button[type=submit]', panel);
        $('#block-error', panel).innerHTML = '';
        await withBusy(button, async () => {
            try {
                const result = await api(L('/block'), {
                    method: 'POST',
                    body: {
                        memberId: $('#b-id', panel).value.trim(),
                        memberName: $('#b-name', panel).value.trim(),
                        memberEmail: $('#b-email', panel).value.trim(),
                        days: Number($('#b-days', panel).value),
                        reason: $('#b-reason', panel).value.trim(),
                        cancelBookings: $('#b-cancel', panel).checked,
                        silent: $('#b-silent', panel).checked
                    }
                });
                toast(`Member blocked until ${result.endsAt}. ${result.bookingsCancelled} booking(s) cancelled.`);
                closeOverlay();
                if (state.view === 'members') loadMembers(); else loadView(true);
            } catch (error) {
                $('#block-error', panel).innerHTML = `<div class="form-error">${esc(error.message)}</div>`;
                throw error;
            }
        });
    });
}

// ---------- At risk ----------
async function renderAtRisk() {
    setContent(loadingCard(6));
    try {
        const data = await api(L('/at-risk'));
        if (state.view !== 'at-risk') return;
        setContent(`
        <div class="note">Members on an unlimited membership with 1–2 late cancellations in the current 7-day window. One or two more late cancellations will start LC-7. Updated by each scheduled run.</div>
        <div class="card">${data.rows.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Member</th><th>Late cancels</th><th>Latest</th><th>Window clears</th><th>Membership</th></tr></thead>
            <tbody>${data.rows.map(row => `<tr>
                <td><div class="member-cell">${avatar(row.memberName, row.memberId)}<div><div class="member-name">${esc(row.memberName || `Member ${row.memberId}`)}</div><div class="member-sub">${esc(row.memberEmail || '')} · #${esc(row.memberId)}</div></div></div></td>
                <td><span class="pill ${Number(row.cancellationsInWindow) >= 2 ? 'bad' : 'warn'}">${esc(row.cancellationsInWindow)} of 3</span></td>
                <td>${fmtCell(row.latestCancellationAt)}</td>
                <td>${fmtCell(row.windowExpiresAt)}<div class="small muted">${esc(rel(parseSheetDate(row.windowExpiresAt)))}</div></td>
                <td class="small">${esc(row.membershipName || '')}</td></tr>`).join('')}</tbody></table></div>`
            : '<div class="empty"><div class="big">No one is at risk</div>Nobody has late cancellations in the current window.</div>'}</div>`);
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

// ---------- Live activity ----------
function lineHtml(line, isNew = false) {
    const time = new Date(line.at).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
    return `<div class="line ${esc(line.level)} ${isNew ? 'new' : ''}"><span class="ts">${esc(time)}</span><span class="src">${esc(line.source || line.location || 'system')}</span><span class="msg">${esc(line.message)}</span></div>`;
}
function visibleLine(line) {
    if (line.location && line.location !== state.location) return false;
    if (state.live.level === 'issues') return line.level === 'warn' || line.level === 'error';
    return true;
}
function renderActivity() {
    setContent(`
    <div class="toolbar">
        <div class="chips">
            <button class="chip ${state.live.level === 'all' ? 'active' : ''}" data-level="all">Everything</button>
            <button class="chip ${state.live.level === 'issues' ? 'active' : ''}" data-level="issues">Warnings & errors</button>
        </div>
        <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn sm" id="pause">${state.live.paused ? '▶ Resume' : '❚❚ Pause'}</button>
            <button class="btn sm" id="clear">Clear view</button>
        </div>
    </div>
    <div class="console" id="console"></div>
    <div class="small muted">Streams the server log in real time: scheduled runs, webhooks and dashboard actions for this location. Shows the last ~1,500 lines since the server started.</div>`);
    $$('[data-level]').forEach(chip => chip.addEventListener('click', () => { state.live.level = chip.dataset.level; renderActivity(); }));
    $('#pause').addEventListener('click', () => { state.live.paused = !state.live.paused; renderActivity(); });
    $('#clear').addEventListener('click', () => { state.lines = []; renderConsole(); });
    renderConsole();
}
function renderConsole() {
    const el = $('#console');
    if (!el) return;
    const lines = state.lines.filter(visibleLine);
    el.innerHTML = lines.length ? lines.map(line => lineHtml(line)).join('') : '<div class="console-empty">No log lines yet. Click “Run now” to watch a run live.</div>';
    el.scrollTop = el.scrollHeight;
}
function appendConsoleLine(line) {
    const el = $('#console');
    if (!el || !visibleLine(line)) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    $('.console-empty', el)?.remove();
    el.insertAdjacentHTML('beforeend', lineHtml(line, true));
    if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---------- Runs & emails ----------
async function renderRuns() {
    setContent(loadingCard(8));
    try {
        const data = await api(L('/logs/runs'));
        if (state.view !== 'runs') return;
        setContent(`<div class="card"><div class="table-wrap"><table>
            <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Fetched</th><th>New</th><th>Blocked</th><th>Bookings</th><th>Restored</th><th>Emails</th><th>Details</th></tr></thead>
            <tbody>${data.rows.map(run => `<tr>
                <td>${fmtCell(run.startedAt)}</td>
                <td>${String(run.runId).startsWith('webhook:') ? '<span class="pill info plain">Webhook</span>' : '<span class="pill plain">Run</span>'}</td>
                <td>${run.status === 'FAILED' ? '<span class="pill bad">Failed</span>' : Number(run.failedCount) > 0 ? `<span class="pill warn">${esc(run.failedCount)} issue(s)</span>` : '<span class="pill ok">OK</span>'}</td>
                <td>${esc(run.rawRecordsFetched)}</td><td>${esc(run.cyclesCreated)}</td><td>${esc(run.lc7Assigned)}</td><td>${esc(run.bookingsCancelled)}</td><td>${esc(run.p57Assigned)}</td>
                <td>${esc(run.emailsSent)}${Number(run.emailsFailed) ? ` <span class="pill bad plain">${esc(run.emailsFailed)} failed</span>` : ''}</td>
                <td class="small muted" style="max-width:360px"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(run.message)}">${esc(run.message || (run.failedMemberIds ? `Failed members: ${run.failedMemberIds}` : ''))}</div></td>
            </tr>`).join('') || '<tr><td colspan="10"><div class="empty">No runs logged yet.</div></td></tr>'}</tbody></table></div></div>`);
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

async function renderEmails() {
    setContent(loadingCard(8));
    try {
        const data = await api(L('/logs/emails'));
        if (state.view !== 'emails') return;
        setContent(`<div class="card"><div class="table-wrap"><table>
            <thead><tr><th>Sent</th><th>Member</th><th>Email</th><th>Status</th><th>Error</th></tr></thead>
            <tbody>${data.rows.map(row => `<tr>
                <td>${fmtCell(row.sentAt)}</td>
                <td><div class="member-name">#${esc(row.memberId)}</div><div class="member-sub">${esc(row.memberEmail)}</div></td>
                <td><span class="pill plain ${row.template === 'A' ? 'accent' : 'ok'}">${row.template === 'A' ? 'Paused (A)' : 'Restored (B)'}</span></td>
                <td>${row.status === 'SENT' ? '<span class="pill ok">Sent</span>' : row.status === 'FAILED' ? '<span class="pill bad">Failed</span>' : `<span class="pill">${esc(row.status)}</span>`}</td>
                <td class="small muted">${esc(row.error || '')}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No emails logged yet.</div></td></tr>'}</tbody></table></div></div>`);
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

// ---------- Locations ----------
async function reloadLocations() {
    const data = await api('/api/locations');
    state.locations = data.locations;
}

async function renderLocations() {
    setContent(loadingCard(4));
    try {
        await reloadLocations();
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
        return;
    }
    if (state.view !== 'locations') return;
    setContent(`
    <div class="toolbar"><div class="muted">Each location runs the same LC-7 rules against its own Momence studio, tags and Google Sheet.</div>
        <button class="btn primary" style="margin-left:auto" id="add-loc">＋ Add location</button></div>
    <div class="loc-grid">${state.locations.map(loc => `
        <div class="card loc-card">
            <div class="card-body">
                <div class="loc-title"><h3>${esc(loc.name)}</h3>
                    ${loc.isDefault ? '<span class="pill plain">Primary</span>' : ''}
                    ${loc.enabled === false ? '<span class="pill warn">Paused</span>' : loc.ready ? '<span class="pill ok">Ready</span>' : '<span class="pill bad">Setup needed</span>'}
                    ${loc.dryRun ? '<span class="pill info plain">Dry run</span>' : ''}
                    ${state.running[loc.id] ? '<span class="pill accent">Running</span>' : ''}</div>
                <dl class="kv small">
                    <dt>Momence host</dt><dd class="mono">${esc(loc.hostId)}</dd>
                    <dt>Tags</dt><dd>LC-7 <span class="mono">${esc(loc.lc7TagId)}</span> · P57 <span class="mono">${esc(loc.p57TagId)}</span></dd>
                    <dt>Google Sheet</dt><dd>${loc.sheetId ? `<a href="https://docs.google.com/spreadsheets/d/${esc(loc.sheetId)}" target="_blank" rel="noopener">Open sheet ↗</a>` : '<span class="muted">—</span>'}</dd>
                    <dt>Env prefix</dt><dd class="mono">${esc(loc.envPrefix || '(none — primary)')}</dd>
                </dl>
                <div><div class="section-title" style="margin-top:0">Webhook URL for Momence</div>
                    <div class="copy-row"><code>${esc(loc.webhookUrl)}</code><button class="btn sm" data-copy="${esc(loc.webhookUrl)}">Copy</button></div></div>
                <div><div class="section-title" style="margin-top:4px">Railway secrets</div>
                    <div class="secret-list">${loc.secrets.map(secret => `<div><span class="tick ${secret.set ? 'yes' : secret.required ? 'no' : 'opt'}">${secret.set ? '✓' : secret.required ? '✕' : '·'}</span><span class="mono">${esc(secret.name)}</span>${secret.inherited ? '<span class="muted small">(shared)</span>' : ''}${!secret.required ? '<span class="muted small">optional</span>' : ''}</div>`).join('')}</div></div>
                <div id="check-${esc(loc.id)}"></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn sm" data-check="${esc(loc.id)}">Test connection</button>
                    ${loc.isDefault ? '' : `<button class="btn sm" data-edit="${esc(loc.id)}">Edit</button><button class="btn sm" data-toggle="${esc(loc.id)}">${loc.enabled === false ? 'Resume' : 'Pause'}</button><button class="btn sm danger" data-remove="${esc(loc.id)}">Remove</button>`}
                    <button class="btn sm ghost" data-open="${esc(loc.id)}" style="margin-left:auto">Open →</button>
                </div>
            </div>
        </div>`).join('')}</div>`);
    $('#add-loc').addEventListener('click', () => openLocationModal());
    $$('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
        toast('Webhook URL copied.');
    }));
    $$('[data-edit]').forEach(btn => btn.addEventListener('click', () => openLocationModal(state.locations.find(loc => loc.id === btn.dataset.edit))));
    $$('[data-open]').forEach(btn => btn.addEventListener('click', () => {
        state.location = btn.dataset.open;
        localStorage.setItem('lc7.location', state.location);
        state.overview = null;
        connectLive();
        location.hash = '#/overview';
    }));
    $$('[data-toggle]').forEach(btn => btn.addEventListener('click', async () => {
        const loc = state.locations.find(item => item.id === btn.dataset.toggle);
        await withBusy(btn, async () => {
            await api(`/api/locations/${encodeURIComponent(loc.id)}`, { method: 'PUT', body: { enabled: loc.enabled === false } });
            toast(loc.enabled === false ? 'Location resumed.' : 'Location paused — scheduled runs skip it.');
            renderLocations();
        });
    }));
    $$('[data-remove]').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm('Remove this location? Its Google Sheet and Momence data are not touched.')) return;
        await withBusy(btn, async () => {
            await api(`/api/locations/${encodeURIComponent(btn.dataset.remove)}`, { method: 'DELETE' });
            if (state.location === btn.dataset.remove) state.location = 'default';
            toast('Location removed.');
            renderLocations();
        });
    }));
    $$('[data-check]').forEach(btn => btn.addEventListener('click', async () => {
        const target = $(`#check-${CSS.escape(btn.dataset.check)}`);
        await withBusy(btn, async () => {
            const result = await api(`/api/locations/${encodeURIComponent(btn.dataset.check)}/check`, { method: 'POST' });
            target.innerHTML = `<div class="check-list">${result.checks.map(check => `<div><span class="tick ${check.ok ? 'yes' : 'no'}">${check.ok ? '✓' : '✕'}</span><div><strong>${esc(check.name)}</strong>${check.detail ? `<div class="small muted">${esc(check.detail)}</div>` : ''}</div></div>`).join('')}</div>`;
        });
    }));
}

function openLocationModal(existing = null) {
    const loc = existing || { currency: 'inr', enabled: true };
    const editing = Boolean(existing);
    const field = (id, label, help = '', attrs = '') => `<div class="field"><label for="f-${id}">${label}</label><input id="f-${id}" value="${esc(loc[id] ?? '')}" ${attrs}>${help ? `<div class="help">${help}</div>` : ''}</div>`;
    const panel = overlay(`
        <div class="modal-head"><div><h2>${editing ? `Edit ${esc(loc.name)}` : 'Add a location'}</h2><p>Same LC-7 rules, applied to another Momence studio.</p></div><button class="close" data-close aria-label="Close">×</button></div>
        <form id="loc-form"><div class="modal-body">
            <div id="loc-error"></div>
            <div class="section-title" style="margin-top:0">Basics</div>
            <div class="row">${field('name', 'Location name', 'Shown in the dashboard, e.g. “Bengaluru – Indiranagar”.', 'required')}${field('id', 'Short ID', 'Lowercase, used in the webhook URL, e.g. blr. Cannot be changed later.', editing ? 'disabled' : 'required pattern="[a-z0-9][a-z0-9-]{1,30}"')}</div>
            <div class="section-title">Momence</div>
            <div class="row three">${field('hostId', 'Host ID', 'From Momence URLs: /host/<b>12345</b>/…', 'required inputmode="numeric"')}${field('lc7TagId', 'LC-7 tag ID', 'Tag that blocks booking.', 'required inputmode="numeric"')}${field('p57TagId', 'P57 tag ID', 'Tag that allows booking.', 'required inputmode="numeric"')}</div>
            <div class="row">${field('currency', 'Currency', 'Used for booking refunds, e.g. inr.')}${field('envPrefix', 'Secrets prefix', 'Railway variables for this location start with this, e.g. BLR_ → BLR_MOMENCE_ACCESS_TOKEN.', 'required')}</div>
            <div class="section-title">Google Sheet</div>
            ${field('sheetId', 'Sheet ID', 'Create an empty Google Sheet (same Google account), copy the ID from its URL. Tabs are created automatically.', 'required')}
            <div class="section-title">Emails (optional)</div>
            <div class="row">${field('mailFrom', 'From address', 'Leave empty to use the primary location’s.')}${field('mailFromName', 'From name')}</div>
            <div class="row">${field('mailReplyTo', 'Reply-to')}${field('signatureName', 'Signature name', 'e.g. Team Physique 57 Bengaluru')}</div>
            <div class="row">${field('templateAUuid', 'Template A UUID', '“Booking paused” Mailtrap template.')}${field('templateBUuid', 'Template B UUID', '“Booking restored” Mailtrap template.')}</div>
            <label class="check"><input type="checkbox" id="f-dryRun" ${loc.dryRun ? 'checked' : ''}><div><strong>Dry run</strong><span>Detect and log everything, but don't change Momence or send emails. Recommended for the first day.</span></div></label>
            <label class="check"><input type="checkbox" id="f-enabled" ${loc.enabled !== false ? 'checked' : ''}><div><strong>Enabled</strong><span>Include this location in hourly runs.</span></div></label>
            <div class="note">After saving: add the secrets shown on the location card in Railway (<b>${esc(loc.envPrefix || 'PREFIX_')}MOMENCE_ACCESS_TOKEN</b>, <b>…MOMENCE_ALL_COOKIES</b>, optional <b>…MOMENCE_WEBHOOK_SECRET</b> and v2 API login), then click “Test connection”.</div>
        </div>
        <div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Add location'}</button></div></form>`, 'modal wide');
    $('#loc-form', panel).addEventListener('submit', async event => {
        event.preventDefault();
        const body = {};
        for (const key of ['name', 'id', 'hostId', 'lc7TagId', 'p57TagId', 'currency', 'envPrefix', 'sheetId', 'mailFrom', 'mailFromName', 'mailReplyTo', 'signatureName', 'templateAUuid', 'templateBUuid']) {
            const input = $(`#f-${key}`, panel);
            if (input && !input.disabled) body[key] = input.value.trim();
        }
        body.dryRun = $('#f-dryRun', panel).checked;
        body.enabled = $('#f-enabled', panel).checked;
        const button = $('button[type=submit]', panel);
        await withBusy(button, async () => {
            try {
                if (editing) await api(`/api/locations/${encodeURIComponent(loc.id)}`, { method: 'PUT', body });
                else await api('/api/locations', { method: 'POST', body });
                toast(editing ? 'Location saved.' : 'Location added. Now add its secrets in Railway.');
                closeOverlay();
                renderLocations();
            } catch (error) {
                $('#loc-error', panel).innerHTML = `<div class="form-error">${esc(error.message)}</div>`;
                throw error;
            }
        });
    });
}

// ---------- Actions ----------
async function runNow() {
    const button = $('#run-now');
    button.disabled = true;
    try {
        await api(L('/run'), { method: 'POST' });
        state.running[state.location] = true;
        updateLiveBits();
        toast('Run started — follow it in Live activity.');
    } catch (error) {
        if (error.message !== 'Signed out') toast(error.message, 'bad');
        button.disabled = false;
    }
}

// ---------- Routing & boot ----------
function route() {
    const view = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    state.view = NAV.some(item => item.id === view) ? view : 'overview';
    if (!state.session?.authenticated) return;
    closeOverlay();
    render();
    loadView();
}
window.addEventListener('hashchange', route);

async function boot() {
    state.session = await api('/api/session').catch(() => ({ configured: false, authenticated: false }));
    if (!state.session.authenticated) return render();
    try {
        await reloadLocations();
    } catch (error) {
        state.locations = [{ id: 'default', name: 'Primary location' }];
        toast(`Could not load locations: ${error.message}`, 'bad');
    }
    if (!state.locations.some(loc => loc.id === state.location)) state.location = 'default';
    connectLive();
    route();
}

boot();
