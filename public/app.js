// LC-7 Control Room — vanilla JS single-page app. Every value from the server is
// escaped with esc() before it is put into the page.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------- Icons (inline SVG, stroke = currentColor) ----------
const ICON_PATHS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.7c1.9.7 3.1 2.5 3.5 5.3"/>',
    alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'
};
const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

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

// Plain-language status names.
const STATUS = {
    DETECTED: { label: 'Starting', tone: 'info', help: 'Threshold reached; the pause is being applied.' },
    LC7_TAG_ASSIGNED: { label: 'Starting', tone: 'info', help: 'LC-7 tag added; cancelling future bookings.' },
    FUTURE_BOOKINGS_CANCELLED: { label: 'Starting', tone: 'info', help: 'Bookings cancelled.' },
    WAITING_7_DAYS: { label: 'Booking paused', tone: 'brand', help: 'Cannot book until the restore date.' },
    P57_TAG_ASSIGNED: { label: 'Restored', tone: 'ok', help: 'Can book again.' },
    OVERRIDE: { label: 'Ending early', tone: 'warn', help: 'Will be restored on the next check.' },
    FAILED: { label: 'Needs attention', tone: 'bad', help: 'A step failed; it is retried automatically.' },
    RETRY_PENDING: { label: 'Retrying', tone: 'warn', help: 'Waiting for the next automatic retry.' }
};

const NAV = [
    { group: 'Members', items: [
        { id: 'overview', label: 'Overview', icon: 'home', title: 'Overview', sub: 'What is happening at this location right now.' },
        { id: 'members', label: 'Paused members', icon: 'users', title: 'Members', sub: 'Everyone whose booking is paused, plus history. Click a member to end a pause early or change its end date.' },
        { id: 'at-risk', label: 'At risk', icon: 'alert', title: 'At risk', sub: 'Members one or two late cancellations away from a pause.' }
    ] },
    { group: 'Activity', items: [
        { id: 'activity', label: 'Live activity', icon: 'pulse', title: 'Live activity', sub: 'Everything the system does, as it happens.' },
        { id: 'runs', label: 'Run history', icon: 'history', title: 'Run history', sub: 'Each hourly check and each real-time cancellation, with what it did.' },
        { id: 'emails', label: 'Emails', icon: 'mail', title: 'Emails', sub: 'Pause and restore emails sent to members.' }
    ] },
    { group: 'Settings', items: [
        { id: 'locations', label: 'Locations', icon: 'pin', title: 'Locations', sub: 'Studios and cities that use these rules. Add a new one in a few steps.' }
    ] }
];
const PAGES = NAV.flatMap(group => group.items);

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-LC7-Request': '1' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty body */ }
    if (response.status === 401 && path !== '/api/login') {
        state.session = { ...(state.session || {}), authenticated: false };
        render();
        throw new Error('Signed out');
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}
const L = path => `/api/l/${encodeURIComponent(state.location)}${path}`;

// ---------- Formatting ----------
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
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    let text;
    if (abs >= 86400000) text = plural(Math.round(abs / 86400000), 'day');
    else if (abs >= 3600000) text = plural(Math.round(abs / 3600000), 'hour');
    else if (abs >= 60000) text = plural(Math.round(abs / 60000), 'minute');
    else return diff > 0 ? 'in a moment' : 'just now';
    return diff > 0 ? `in ${text}` : `${text} ago`;
}
function fmt(date, withYear = false) {
    if (!date) return '—';
    return date.toLocaleString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function fmtCell(value) {
    const date = parseSheetDate(value);
    return date ? `<span class="date" title="${esc(value)} IST">${esc(fmt(date))}</span>` : '<span class="muted">—</span>';
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
    const h = hue(id || name);
    return `<div class="avatar" style="background:hsl(${h} 55% 93%);color:hsl(${h} 45% 32%)">${esc(initials(name))}</div>`;
}
function statusPill(status) {
    const info = STATUS[status] || { label: status || 'Unknown', tone: '' };
    return `<span class="pill dot ${info.tone}" title="${esc(info.help || '')}">${esc(info.label)}</span>`;
}
function memberCell(name, id, email) {
    return `<div class="member-cell">${avatar(name, id)}<div><div class="member-name">${esc(name || `Member #${id}`)}</div><div class="member-sub">${esc(email || '')}${email ? ' · ' : ''}#${esc(id)}</div></div></div>`;
}
function toast(message, tone = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.innerHTML = `${icon(tone === 'bad' ? 'alert' : 'check', 15)}<span>${esc(message)}</span>`;
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

// Turn a RunLog row into a sentence a studio manager understands.
function describeRun(run) {
    const isWebhook = String(run.runId).startsWith('webhook:');
    const msg = String(run.message || '');
    if (run.status === 'FAILED') return { tone: 'bad', text: isWebhook ? 'Could not process a cancellation' : 'Hourly check failed', sub: 'The next hourly check will catch up. See Live activity for details.' };
    if (isWebhook) {
        const member = msg.match(/member (\d+)/)?.[1];
        const who = member ? `Member #${member}` : 'A member';
        const outcome = msg.split(': ').pop();
        if (/LC7_TRIGGERED/.test(outcome)) return { tone: 'brand', text: `${who} paused`, sub: '3rd late cancellation in 7 days — booking paused, member emailed.' };
        if (/WAITING_PERIOD_RESET/.test(outcome)) return { tone: 'brand', text: `${who}'s pause extended`, sub: 'Late-cancelled again while paused; restore date moved.' };
        if (/ALREADY_IN_LC7/.test(outcome)) return { tone: '', text: `${who} late-cancelled`, sub: 'Already paused; no change.' };
        if (/BELOW_THRESHOLD/.test(outcome)) {
            const n = outcome.match(/\((\d+)/)?.[1];
            return { tone: n === '2' ? 'warn' : '', text: `${who} late-cancelled`, sub: n ? `${n} of 3 in the last 7 days — no pause yet.` : 'Below the limit — no pause yet.' };
        }
        if (/NOT_UNLIMITED/.test(outcome)) return { tone: '', text: `${who} late-cancelled`, sub: 'Not on an unlimited membership — rule does not apply.' };
        if (/MEMBERSHIP_UNKNOWN/.test(outcome)) return { tone: 'warn', text: `${who} late-cancelled`, sub: 'Membership not known yet — the hourly check will decide.' };
        return { tone: '', text: `${who} late-cancelled`, sub: outcome };
    }
    const parts = [];
    if (Number(run.lc7Assigned)) parts.push(`${run.lc7Assigned} paused`);
    if (Number(run.p57Assigned)) parts.push(`${run.p57Assigned} restored`);
    if (Number(run.emailsSent)) parts.push(`${run.emailsSent} email${Number(run.emailsSent) === 1 ? '' : 's'} sent`);
    const issues = Number(run.failedCount) > 0 ? `${run.failedCount} step(s) need attention` : '';
    return {
        tone: issues ? 'warn' : parts.length ? 'ok' : '',
        text: 'Hourly check',
        sub: [parts.length ? parts.join(' · ') : 'Nothing to change', issues].filter(Boolean).join(' · ')
    };
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
        refreshFeed();
        if (state.view === 'activity') renderConsole();
    });
    source.addEventListener('line', event => {
        const line = JSON.parse(event.data);
        state.lines.push(line);
        if (state.lines.length > 1500) state.lines.splice(0, state.lines.length - 1500);
        if (!state.live.paused) appendConsoleLine(line);
        refreshFeed();
    });
    source.addEventListener('run', event => {
        const data = JSON.parse(event.data);
        state.running[data.location] = data.running;
        updateLiveBits();
        if (!data.running && data.location === state.location) {
            toast(data.status === 'FAILED' ? 'Check finished with an error — see Live activity.' : 'Check complete.', data.status === 'FAILED' ? 'bad' : 'ok');
            softRefresh();
        }
    });
    source.addEventListener('changed', event => {
        if (JSON.parse(event.data).location === state.location) scheduleSoftRefresh();
    });
    source.onerror = () => { state.live.connected = false; updateLiveBits(); };
    source.onopen = () => { state.live.connected = true; updateLiveBits(); };
}

let refreshTimer = null;
function scheduleSoftRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(softRefresh, 1200);
}
function softRefresh() {
    if (['overview', 'members', 'at-risk', 'runs', 'emails'].includes(state.view) && !$('.drawer, .modal')) loadView(true);
}

function updateLiveBits() {
    const running = state.running[state.location];
    const dot = $('#live-dot');
    if (dot) dot.className = `live-dot ${running ? 'busy' : state.live.connected ? 'on' : ''}`;
    const label = $('#live-label');
    if (label) label.textContent = running ? 'Checking now…' : state.live.connected ? 'Live' : 'Reconnecting…';
    const runBtn = $('#run-now');
    if (runBtn) {
        runBtn.disabled = Boolean(running);
        runBtn.innerHTML = running ? '<span class="spinner"></span> Checking…' : `${icon('refresh', 15)} Check now`;
    }
}

// ---------- Overlays ----------
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
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = html;
    document.body.append(scrim, panel);
    $$('[data-close]', panel).forEach(btn => btn.addEventListener('click', closeOverlay));
    if (cls.startsWith('modal')) setTimeout(() => $('input:not([type=checkbox]):not([disabled]), select', panel)?.focus(), 50);
    return panel;
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeOverlay(); });

// In-app confirmation (replaces the browser's confirm()).
function confirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'primary' }) {
    return new Promise(resolve => {
        const panel = overlay(`
            <div class="modal-head"><div><h2>${esc(title)}</h2></div><button class="close" data-close aria-label="Close">${icon('x', 15)}</button></div>
            <div class="modal-body">${body}</div>
            <div class="modal-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn ${tone}" id="confirm-yes">${esc(confirmLabel)}</button></div>`, 'modal narrow');
        $$('[data-close]', panel).forEach(btn => btn.addEventListener('click', () => resolve(false)));
        $('.scrim').addEventListener('click', () => resolve(false));
        $('#confirm-yes', panel).addEventListener('click', () => { closeOverlay(); resolve(true); });
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
        if (button.isConnected) {
            button.disabled = false;
            button.innerHTML = original;
        }
    }
}

// ---------- Rendering ----------
function render() {
    const app = $('#app');
    if (!state.session) {
        app.innerHTML = '<div class="login"><span class="spinner"></span></div>';
        return;
    }
    if (!state.session.authenticated) return renderLogin(app);
    renderShell(app);
}

function renderLogin(app) {
    app.innerHTML = `
    <div class="login">
        <form class="login-card" id="login-form">
            <div class="brand" style="padding:0"><div class="brand-mark">7</div><div><div class="brand-name">LC-7 Control Room</div><div class="brand-sub">Late-cancellation rules</div></div></div>
            <h2>Welcome back</h2>
            <p>Sign in with the admin password.</p>
            ${state.session.configured ? '' : '<div class="form-error">Sign-in is not set up yet. Add an <b>ADMIN_PASSWORD</b> variable in Railway, then reload this page.</div>'}
            <div id="login-error"></div>
            <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required autofocus></div>
            <button class="btn primary block" type="submit" ${state.session.configured ? '' : 'disabled'}>Sign in</button>
            <div class="login-points">
                <div>${icon('check', 14)} See who is paused and when they can book again</div>
                <div>${icon('check', 14)} End a pause early or pause someone manually</div>
                <div>${icon('check', 14)} Watch late cancellations arrive live</div>
            </div>
        </form>
    </div>`;
    $('#login-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('#login-form button[type=submit]');
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
    const page = PAGES.find(item => item.id === state.view) || PAGES[0];
    const counts = state.overview?.counts || {};
    const badge = { members: counts.active, 'at-risk': counts.atRisk };
    app.innerHTML = `
    <div class="shell">
        <aside class="side">
            <div class="brand"><div class="brand-mark">7</div><div><div class="brand-name">LC-7 Control Room</div><div class="brand-sub">Late-cancellation rules</div></div></div>
            <div class="loc-switch">
                <label for="loc-select">Location</label>
                <select id="loc-select">${state.locations.map(item => `<option value="${esc(item.id)}" ${item.id === state.location ? 'selected' : ''}>${esc(item.name)}${item.enabled === false ? ' (paused)' : ''}</option>`).join('')}</select>
            </div>
            ${NAV.map(group => `
            <nav class="nav-group" aria-label="${esc(group.group)}">
                <div class="nav-label">${esc(group.group)}</div>
                ${group.items.map(item => `<a href="#/${item.id}" class="${state.view === item.id ? 'active' : ''}">${icon(item.icon, 17)}${esc(item.label)}${badge[item.id] ? `<span class="count">${badge[item.id]}</span>` : ''}</a>`).join('')}
            </nav>`).join('')}
            <div class="side-foot">
                <div class="rule-card"><strong>The rule</strong>3 late cancellations within 7 days on an unlimited membership pause booking for 7 days. Booking is restored automatically.</div>
                <button class="btn ghost" id="logout" style="justify-content:flex-start">${icon('logout', 15)} Sign out</button>
            </div>
        </aside>
        <main class="main">
            <header class="top">
                <div>
                    <h1>${esc(page.title)}${state.locations.length > 1 ? ` <span class="muted" style="font-weight:500">· ${esc(loc.name)}</span>` : ''}</h1>
                    <div class="sub">${esc(page.sub)}</div>
                </div>
                <div class="top-actions">
                    <span class="status-chip" title="Real-time connection to the server"><span id="live-dot" class="live-dot"></span><span id="live-label">Connecting…</span></span>
                    <button class="btn" id="block-btn">${icon('block', 15)} Pause a member</button>
                    <button class="btn primary" id="run-now" title="Run the hourly check now">${icon('refresh', 15)} Check now</button>
                </div>
            </header>
            <section class="content" id="content"></section>
        </main>
    </div>`;
    $('#loc-select').addEventListener('change', event => switchLocation(event.target.value));
    $('#logout').addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        if (state.source) state.source.close();
        state.session = { ...state.session, authenticated: false };
        render();
    });
    $('#run-now').addEventListener('click', runNow);
    $('#block-btn').addEventListener('click', () => openBlockModal());
    updateLiveBits();
    renderView();
}

function switchLocation(id) {
    state.location = id;
    localStorage.setItem('lc7.location', id);
    state.overview = null;
    state.members.rows = [];
    connectLive();
    render();
    loadView();
}

function setContent(html) {
    const el = $('#content');
    if (el) el.innerHTML = html;
    return el;
}
function loadingCard(rows = 5) {
    return `<div class="card"><div class="card-body">${Array.from({ length: rows }, () => '<div class="skeleton" style="margin:14px 0"></div>').join('')}</div></div>`;
}
function errorBanner(message) {
    return `<div class="banner bad">${icon('alert', 18)}<div><strong>Something went wrong</strong>${esc(message)}</div></div>`;
}
function emptyState(iconName, title, text) {
    return `<div class="empty"><div class="empty-icon">${icon(iconName, 22)}</div><div class="big">${esc(title)}</div><div>${esc(text)}</div></div>`;
}

function renderView() {
    const views = { overview: renderOverview, members: renderMembers, 'at-risk': renderAtRisk, activity: renderActivity, runs: renderRuns, emails: renderEmails, locations: renderLocations };
    (views[state.view] || renderOverview)();
}

async function loadView(soft = false) {
    try {
        if (state.view === 'overview') {
            state.overview = await api(L('/overview'));
            if (soft) renderOverview(); else render();
        } else if (state.view === 'members') {
            await loadMembers();
        } else if (soft) {
            renderView();
        }
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

// ---------- Overview ----------
function outcomeRow(run, extra = '') {
    const d = describeRun(run);
    return `<div class="outcome"><span class="pill dot ${d.tone}" style="padding:3px 6px" aria-hidden="true"></span><div><div class="outcome-text"><strong>${esc(d.text)}</strong></div><div class="outcome-sub">${esc(d.sub)}</div>${extra}</div></div>`;
}

function renderOverview() {
    const data = state.overview;
    if (!data) return setContent(`<div class="grid kpis">${'<div class="kpi"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="height:30px;margin-top:14px;width:40%"></div></div>'.repeat(4)}</div>${loadingCard()}`);
    if (data.error) {
        return setContent(`${errorBanner(`This location could not be loaded: ${data.error}`)}<div><a class="btn" href="#/locations">${icon('pin', 15)} Check location settings</a></div>`);
    }
    const c = data.counts;
    const runs = data.recentRuns || [];
    const webhookOn = data.location.secrets?.find(s => s.name.endsWith('MOMENCE_WEBHOOK_SECRET'))?.set;
    setContent(`
    ${data.location.dryRun ? `<div class="banner">${icon('info', 18)}<div><strong>Test mode is on</strong>Pauses are detected and logged, but Momence is not changed and no emails are sent.</div></div>` : ''}
    ${c.failed ? `<div class="banner bad">${icon('alert', 18)}<div><strong>${c.failed} member${c.failed === 1 ? '' : 's'} need${c.failed === 1 ? 's' : ''} attention</strong>A step (tag update or booking cancellation) failed. It retries automatically every hour, or you can retry it yourself.</div><button class="btn sm" data-go="members" data-status="FAILED">Review ${icon('arrow', 14)}</button></div>` : ''}
    <div class="grid kpis">
        <button class="kpi brand" data-go="members" data-status="active"><div class="kpi-top"><div class="kpi-icon">${icon('block', 16)}</div><div class="label">Paused right now</div></div><div class="value">${c.active}</div><div class="hint">${c.dueSoon ? `${c.dueSoon} can book again within 24 hours` : 'Cannot book until restored'}</div></button>
        <button class="kpi warn" data-go="at-risk"><div class="kpi-top"><div class="kpi-icon">${icon('alert', 16)}</div><div class="label">At risk</div></div><div class="value">${c.atRisk}</div><div class="hint">1–2 late cancellations this week</div></button>
        <div class="kpi"><div class="kpi-top"><div class="kpi-icon">${icon('calendar', 16)}</div><div class="label">Paused this week</div></div><div class="value">${c.startedThisWeek}</div><div class="hint">In the last 7 days</div></div>
        <div class="kpi ok"><div class="kpi-top"><div class="kpi-icon">${icon('unlock', 16)}</div><div class="label">Restored this week</div></div><div class="value">${c.restoredThisWeek}</div><div class="hint">Can book again</div></div>
    </div>
    <div class="card">
        <div class="card-head"><div><h3>How it works</h3><p>Runs automatically. You only need to step in for exceptions.</p></div></div>
        <div class="steps">
            <div class="step"><div class="step-num">1</div><strong>Member late-cancels</strong><span>${webhookOn ? 'Momence tells us instantly.' : 'Picked up by the hourly check (real-time is off).'}</span></div>
            <div class="step"><div class="step-num">2</div><strong>3 in 7 days?</strong><span>Only unlimited memberships count. 1–2 show under “At risk”.</span></div>
            <div class="step"><div class="step-num">3</div><strong>Booking paused 7 days</strong><span>LC-7 tag added, upcoming bookings cancelled, member emailed.</span></div>
            <div class="step"><div class="step-num">4</div><strong>Restored automatically</strong><span>After 7 days the P57 tag returns and the member is emailed.</span></div>
        </div>
    </div>
    <div class="grid two">
        <div class="card">
            <div class="card-head"><div><h3>Recent activity</h3><p>Late cancellations and hourly checks.</p></div><div class="right"><a class="btn sm ghost" href="#/runs">See all ${icon('arrow', 14)}</a></div></div>
            ${runs.length ? `<div class="table-wrap"><table><tbody>${runs.slice(0, 10).map(run => `
                <tr><td style="width:150px">${fmtCell(run.startedAt)}<div class="small muted">${esc(rel(parseSheetDate(run.startedAt)))}</div></td><td>${outcomeRow(run)}</td></tr>`).join('')}</tbody></table></div>`
                : emptyState('history', 'No activity yet', 'The first hourly check will appear here.')}
        </div>
        <div class="card">
            <div class="card-head"><div><h3>Live</h3><p>System log as it happens.</p></div><div class="right"><a class="btn sm ghost" href="#/activity">Open ${icon('arrow', 14)}</a></div></div>
            <div class="feed" id="feed">${feedHtml()}</div>
        </div>
    </div>`);
    $$('[data-go]').forEach(el => el.addEventListener('click', () => {
        if (el.dataset.status) state.members.status = el.dataset.status;
        location.hash = `#/${el.dataset.go}`;
    }));
}

function feedHtml() {
    const lines = state.lines.filter(line => !line.location || line.location === state.location).slice(-15).reverse();
    if (!lines.length) return emptyState('pulse', 'Quiet for now', 'New activity appears here instantly.');
    return lines.map(line => {
        const good = /✅|LC7_TRIGGERED|restored/i.test(line.message);
        const cls = line.level === 'error' ? 'error' : line.level === 'warn' ? 'warn' : good ? 'good' : '';
        const ic = cls === 'error' || cls === 'warn' ? 'alert' : good ? 'check' : 'pulse';
        const time = new Date(line.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
        return `<div class="feed-item ${cls}"><span class="ico">${icon(ic, 12)}</span><div style="flex:1;min-width:0">${esc(line.message.replace(/^[^\w#(]+/u, '').slice(0, 200))}</div><div class="when">${esc(time)}</div></div>`;
    }).join('');
}
function refreshFeed() {
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
    } finally {
        state.members.loading = false;
        renderMembers();
    }
}

function renderMembers() {
    const m = state.members;
    const filters = [['active', 'Paused now'], ['FAILED', 'Needs attention'], ['P57_TAG_ASSIGNED', 'Restored'], ['all', 'Everyone']];
    let el = $('#members-table');
    if (!el) {
        setContent(`
        <div class="toolbar">
            <div class="chips">${filters.map(([id, label]) => `<button class="chip ${m.status === id ? 'active' : ''}" data-status="${id}">${label}</button>`).join('')}</div>
            <label class="search" style="margin-left:auto">${icon('search', 15)}<input id="member-search" placeholder="Search by name, email or member ID" value="${esc(m.q)}" aria-label="Search members"></label>
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
        const text = m.q ? 'No one matches your search.' : m.status === 'active' ? 'Nobody’s booking is paused right now.' : m.status === 'FAILED' ? 'Everything is working — nothing needs attention.' : 'Nothing to show for this filter.';
        el.innerHTML = emptyState(m.status === 'FAILED' ? 'check' : 'users', 'All clear', text);
        return;
    }
    el.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Member</th><th>Status</th><th>Paused on</th><th>Can book again</th><th></th></tr></thead>
        <tbody>${m.rows.map(cycle => {
            const ends = parseSheetDate(cycle.p57EligibleAt);
            const paused = cycle.status === 'WAITING_7_DAYS';
            const restored = cycle.status === 'P57_TAG_ASSIGNED';
            const pct = blockProgress(cycle).toFixed(0);
            const restoreCell = restored
                ? `<div class="time-left"><div class="t">Restored</div><div class="d">${esc(fmt(parseSheetDate(cycle.p57TagAssignedAt || cycle.p57EligibleAt)))}</div></div>`
                : ends ? `<div class="time-left"><div class="t">${esc(rel(ends))}</div><div class="d">${esc(fmt(ends))}</div>${paused ? `<div class="progress" title="${pct}% of the pause done"><span style="width:${pct}%"></span></div>` : ''}</div>` : '<span class="muted">—</span>';
            const note = cycle.lastError
                ? `<div class="small ellipsis" style="color:var(--bad);max-width:240px;margin-top:4px" title="${esc(cycle.lastError)}">${esc(cycle.lastError)}</div>`
                : /Manual/i.test(cycle.assignmentReason) ? '<div class="small muted" style="margin-top:4px">Paused manually</div>' : '';
            return `<tr class="clickable" data-cycle="${esc(cycle.cycleId)}" tabindex="0">
                <td>${memberCell(cycle.memberName, cycle.memberId, cycle.memberEmail)}</td>
                <td>${statusPill(cycle.status)}${note}</td>
                <td>${fmtCell(cycle.lc7TagAssignedAt || cycle.latestLateCancellationAt)}</td>
                <td>${restoreCell}</td>
                <td style="text-align:right"><span class="btn sm row-action">${restored ? 'View' : 'Manage'} ${icon('arrow', 13)}</span></td>
            </tr>`;
        }).join('')}</tbody></table></div>`;
    $$('tr[data-cycle]', el).forEach(row => {
        const open = () => {
            const cycle = state.members.rows.find(item => item.cycleId === row.dataset.cycle);
            if (cycle) openCycleDrawer(cycle);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
    });
}

function toLocalInput(date) {
    const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
}

function openCycleDrawer(cycle) {
    const paused = cycle.status === 'WAITING_7_DAYS';
    const canEnd = cycle.status !== 'P57_TAG_ASSIGNED';
    const ends = parseSheetDate(cycle.p57EligibleAt);
    const restoredAt = parseSheetDate(cycle.p57TagAssignedAt);
    const pct = blockProgress(cycle).toFixed(0);
    const bookings = cycle.futureBookingsCancelledCount;
    const steps = [
        { t: /Manual/i.test(cycle.assignmentReason) ? 'Paused manually' : '3rd late cancellation in 7 days', d: cycle.latestLateCancellationAt, done: true },
        { t: 'Booking paused (LC-7 tag added)', d: cycle.lc7TagAssignedAt, done: Boolean(cycle.lc7TagAssignedAt) },
        { t: `Upcoming bookings cancelled${bookings !== '' && bookings !== undefined ? ` · ${bookings || 0}` : ''}`, d: '', done: ['WAITING_7_DAYS', 'P57_TAG_ASSIGNED'].includes(cycle.status) },
        { t: restoredAt ? 'Booking restored (P57 tag back)' : 'Booking restores automatically', d: cycle.p57TagAssignedAt || cycle.p57EligibleAt, done: Boolean(restoredAt), now: paused }
    ];
    const panel = overlay(`
        <div class="drawer-head">${avatar(cycle.memberName, cycle.memberId)}
            <div style="min-width:0"><h2>${esc(cycle.memberName || `Member #${cycle.memberId}`)}</h2><div class="muted small">${esc(cycle.memberEmail || '')} · #${esc(cycle.memberId)}</div><div style="margin-top:8px">${statusPill(cycle.status)}</div></div>
            <button class="close" data-close aria-label="Close">${icon('x', 15)}</button></div>
        <div class="drawer-body">
            ${cycle.lastError ? `<div class="banner bad" style="margin-bottom:16px">${icon('alert', 18)}<div><strong>A step failed</strong>${esc(cycle.lastError)}</div></div>` : ''}
            ${paused && ends ? `<div class="note" style="margin-bottom:20px"><strong style="color:var(--ink)">Can book again ${esc(rel(ends))}</strong><div class="small">${esc(fmt(ends, true))} IST</div><div class="progress"><span style="width:${pct}%"></span></div></div>` : ''}
            <div class="section-title" style="margin-top:0">Timeline</div>
            <div class="timeline">${steps.map(step => `<div class="tl-item ${step.done ? 'done' : ''} ${step.now ? 'now' : ''}"><div class="t">${esc(step.t)}</div><div class="d">${step.d ? esc(fmt(parseSheetDate(step.d))) : ''}</div></div>`).join('')}</div>
            ${paused || canEnd ? '<div class="section-title">Actions</div>' : ''}
            ${paused ? `
            <div class="action-box">
                <h4>Change the restore date</h4>
                <p>Make the pause shorter or longer. The member is restored automatically at this time.</p>
                <div class="field input-group" style="flex-direction:row;margin:0"><input id="end-date" type="datetime-local" value="${ends ? toLocalInput(ends) : ''}" aria-label="New restore date"><button class="btn" id="save-end">Save date</button></div>
            </div>` : ''}
            ${canEnd ? `
            <div class="action-box">
                <h4>End the pause now</h4>
                <p>Restores booking in Momence immediately. Classes that were cancelled are not re-booked.</p>
                <div class="field" style="margin-bottom:10px"><input id="end-note" placeholder="Reason (optional), e.g. medical emergency" aria-label="Reason"></div>
                <label class="check" style="margin:0"><input type="checkbox" id="end-silent"><div><strong>Don't email the member</strong><span>Skip the “you can book again” email.</span></div></label>
            </div>` : ''}
            <details class="more" style="margin-top:22px"><summary>Technical details</summary><div>
                <dl class="kv">
                    <dt>Reason</dt><dd>${esc(cycle.assignmentReason || '—')}</dd>
                    <dt>Last action</dt><dd>${esc(cycle.actionComment || '—')}</dd>
                    <dt>Retries</dt><dd>${esc(cycle.retryCount || 0)}</dd>
                    <dt>Updated</dt><dd>${esc(cycle.updatedAt || '—')}</dd>
                    <dt>Cycle ID</dt><dd class="mono muted">${esc(cycle.cycleId)}</dd>
                </dl></div></details>
        </div>
        <div class="drawer-foot">
            ${canEnd ? `<button class="btn brand" id="end-now">${icon('unlock', 15)} End pause & restore booking</button>` : ''}
            ${cycle.status === 'FAILED' ? `<button class="btn" id="retry">${icon('refresh', 15)} Retry now</button>` : ''}
            <button class="btn ghost" data-close style="margin-left:auto">Close</button>
        </div>`, 'drawer');

    $('#save-end', panel)?.addEventListener('click', async event => {
        const value = $('#end-date', panel).value;
        if (!value) return;
        await withBusy(event.currentTarget, async () => {
            await api(L(`/cycles/${encodeURIComponent(cycle.cycleId)}/end-date`), { method: 'POST', body: { endsAt: new Date(value).toISOString() } });
            toast('Restore date updated.');
            closeOverlay();
            loadMembers();
        });
    });
    $('#end-now', panel)?.addEventListener('click', async () => {
        const silent = $('#end-silent', panel).checked;
        const note = $('#end-note', panel).value;
        const name = cycle.memberName || `Member #${cycle.memberId}`;
        const ok = await confirmDialog({
            title: 'End this pause now?',
            body: `<p style="margin:0 0 12px">${esc(name)} will be able to book again straight away.</p><div class="summary"><ul><li>LC-7 tag removed and P57 tag added in Momence</li><li>${silent ? 'No email is sent' : '“You can book again” email is sent'}</li><li>Classes that were cancelled are not re-booked</li></ul></div>`,
            confirmLabel: 'End pause',
            tone: 'brand'
        });
        if (!ok) return;
        toast(`Ending ${name}'s pause…`);
        try {
            const result = await api(L(`/cycles/${encodeURIComponent(cycle.cycleId)}/end`), { method: 'POST', body: { silent, note } });
            toast(`Done — ${name} can book again${result.emailsSent ? ' and has been emailed' : ''}.`);
            loadMembers();
        } catch (error) {
            if (error.message !== 'Signed out') toast(error.message, 'bad');
        }
    });
    $('#retry', panel)?.addEventListener('click', async event => {
        await withBusy(event.currentTarget, async () => {
            await api(L(`/cycles/${encodeURIComponent(cycle.cycleId)}/retry`), { method: 'POST' });
            toast('Retried — check the member’s status.');
            closeOverlay();
            loadMembers();
        });
    });
}

function openBlockModal() {
    const panel = overlay(`
        <div class="modal-head"><div><h2>Pause a member's booking</h2><p>For exceptions, e.g. repeated no-shows reported by the front desk.</p></div><button class="close" data-close aria-label="Close">${icon('x', 15)}</button></div>
        <form id="block-form">
        <div class="modal-body">
            <div id="block-error"></div>
            <div class="field"><label for="b-id">Momence member ID</label>
                <div class="input-group"><input id="b-id" inputmode="numeric" required placeholder="e.g. 1565384"><button type="button" class="btn" id="b-lookup">${icon('search', 14)} Find</button></div>
                <div class="help">The number in the member's Momence profile address.</div></div>
            <div class="row">
                <div class="field"><label for="b-name">Name</label><input id="b-name" placeholder="Filled in by Find"></div>
                <div class="field"><label for="b-email">Email</label><input id="b-email" type="email" placeholder="Filled in by Find"></div>
            </div>
            <div class="row">
                <div class="field"><label for="b-days">Pause for</label><select id="b-days">${[1, 2, 3, 5, 7, 10, 14, 21, 30].map(d => `<option value="${d}" ${d === 7 ? 'selected' : ''}>${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></div>
                <div class="field"><label for="b-reason">Reason <span class="muted" style="font-weight:400">(optional)</span></label><input id="b-reason" placeholder="Saved in the member's history"></div>
            </div>
            <label class="check"><input type="checkbox" id="b-cancel" checked><div><strong>Cancel their upcoming bookings</strong><span>Same as an automatic pause. Untick to keep classes already booked.</span></div></label>
            <label class="check"><input type="checkbox" id="b-silent"><div><strong>Don't email the member</strong><span>No “booking paused” or “you can book again” emails.</span></div></label>
            <div class="summary" id="b-summary"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn brand" type="submit">${icon('block', 15)} Pause booking</button></div>
        </form>`, 'modal');
    const summary = () => {
        const days = Number($('#b-days', panel).value);
        const until = new Date(Date.now() + days * 86400000);
        const name = $('#b-name', panel).value.trim() || 'The member';
        $('#b-summary', panel).innerHTML = `<strong>What will happen</strong><ul>
            <li>${esc(name)} cannot book until <b>${esc(fmt(until))}</b></li>
            <li>${$('#b-cancel', panel).checked ? 'Their upcoming bookings are cancelled' : 'Their upcoming bookings are kept'}</li>
            <li>${$('#b-silent', panel).checked ? 'No emails are sent' : 'They get the “booking paused” email now and “you can book again” later'}</li>
            <li>Booking is restored automatically — or end it early from Members</li></ul>`;
    };
    $$('input, select', panel).forEach(input => input.addEventListener('input', summary));
    summary();
    $('#b-lookup', panel).addEventListener('click', async event => {
        const id = $('#b-id', panel).value.trim();
        if (!id) return $('#b-id', panel).focus();
        await withBusy(event.currentTarget, async () => {
            const member = await api(L(`/member-lookup?memberId=${encodeURIComponent(id)}`));
            $('#b-name', panel).value = member.name;
            $('#b-email', panel).value = member.email;
            summary();
            toast(member.name ? `Found ${member.name}.` : 'Member found, but no name on file.', member.name ? 'ok' : 'bad');
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
                toast(`Booking paused until ${result.endsAt}. ${result.bookingsCancelled} booking(s) cancelled.`);
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
        <div class="banner">${icon('info', 18)}<div>These members are on an unlimited membership and have late-cancelled in the last 7 days. At <b>3</b>, booking is paused automatically. Updated every hour.</div></div>
        <div class="card">${data.rows.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Member</th><th>Late cancellations</th><th>Most recent</th><th>Count resets</th><th>Membership</th></tr></thead>
            <tbody>${data.rows.map(row => `<tr>
                <td>${memberCell(row.memberName, row.memberId, row.memberEmail)}</td>
                <td><span class="pill dot ${Number(row.cancellationsInWindow) >= 2 ? 'bad' : 'warn'}">${esc(row.cancellationsInWindow)} of 3</span>${Number(row.cancellationsInWindow) >= 2 ? '<div class="small muted" style="margin-top:4px">One more pauses booking</div>' : ''}</td>
                <td>${fmtCell(row.latestCancellationAt)}</td>
                <td>${fmtCell(row.windowExpiresAt)}<div class="small muted">${esc(rel(parseSheetDate(row.windowExpiresAt)))}</div></td>
                <td class="small">${esc(row.membershipName || '')}</td></tr>`).join('')}</tbody></table></div>`
            : emptyState('check', 'No one is at risk', 'Nobody has late-cancelled in the last 7 days.')}</div>`);
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

// ---------- Live activity ----------
function lineHtml(line, isNew = false) {
    const time = new Date(line.at).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
    const src = { webhook: 'cancellation', schedule: 'hourly', dashboard: 'you', manual: 'you' }[line.source] || line.source || 'system';
    return `<div class="line ${esc(line.level)} ${isNew ? 'new' : ''}"><span class="ts">${esc(time)}</span><span class="src">${esc(src)}</span><span class="msg">${esc(line.message)}</span></div>`;
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
            <button class="chip ${state.live.level === 'issues' ? 'active' : ''}" data-level="issues">Problems only</button>
        </div>
        <div style="margin-left:auto;display:flex;gap:8px">
            <button class="btn sm" id="pause">${state.live.paused ? 'Resume' : 'Pause'}</button>
            <button class="btn sm" id="clear">Clear</button>
        </div>
    </div>
    <div class="console" id="console" role="log" aria-live="polite"></div>
    <div class="small muted">Tip: click <b>Check now</b> to watch an hourly check step by step. Shows the latest ~1,500 lines.</div>`);
    $$('[data-level]').forEach(chip => chip.addEventListener('click', () => { state.live.level = chip.dataset.level; renderActivity(); }));
    $('#pause').addEventListener('click', () => { state.live.paused = !state.live.paused; renderActivity(); });
    $('#clear').addEventListener('click', () => { state.lines = []; renderConsole(); });
    renderConsole();
}
function renderConsole() {
    const el = $('#console');
    if (!el) return;
    const lines = state.lines.filter(visibleLine);
    el.innerHTML = lines.length ? lines.map(line => lineHtml(line)).join('') : '<div class="console-empty">Nothing yet. Activity shows up here the moment it happens.</div>';
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
        setContent(`<div class="card">${data.rows.length ? `<div class="table-wrap"><table>
            <thead><tr><th>When</th><th>What happened</th><th>Paused</th><th>Restored</th><th>Emails</th></tr></thead>
            <tbody>${data.rows.map(run => {
                const details = run.status === 'FAILED' && run.message
                    ? `<details class="more" style="margin-top:6px"><summary>Error details</summary><div class="mono small" style="white-space:pre-wrap;color:var(--bad)">${esc(String(run.message).slice(0, 1200))}</div></details>` : '';
                return `<tr>
                <td style="width:170px">${fmtCell(run.startedAt)}<div class="small muted">${esc(rel(parseSheetDate(run.startedAt)))}</div></td>
                <td>${outcomeRow(run, details)}</td>
                <td>${Number(run.lc7Assigned) ? `<b>${esc(run.lc7Assigned)}</b>` : '<span class="muted">0</span>'}</td>
                <td>${Number(run.p57Assigned) ? `<b>${esc(run.p57Assigned)}</b>` : '<span class="muted">0</span>'}</td>
                <td>${Number(run.emailsSent) ? esc(run.emailsSent) : '<span class="muted">0</span>'}${Number(run.emailsFailed) ? ` <span class="pill bad">${esc(run.emailsFailed)} failed</span>` : ''}</td>
            </tr>`;
            }).join('')}</tbody></table></div>` : emptyState('history', 'No history yet', 'Hourly checks and cancellations will be listed here.')}</div>`);
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

async function renderEmails() {
    setContent(loadingCard(8));
    try {
        const data = await api(L('/logs/emails'));
        if (state.view !== 'emails') return;
        setContent(`<div class="card">${data.rows.length ? `<div class="table-wrap"><table>
            <thead><tr><th>When</th><th>To</th><th>Email</th><th>Result</th></tr></thead>
            <tbody>${data.rows.map(row => `<tr>
                <td style="width:170px">${fmtCell(row.sentAt)}</td>
                <td><div class="member-name">${esc(row.memberEmail || '—')}</div><div class="member-sub">#${esc(row.memberId)}</div></td>
                <td>${row.template === 'A' ? `<span class="pill brand">${icon('block', 12)} Booking paused</span>` : `<span class="pill ok">${icon('unlock', 12)} You can book again</span>`}</td>
                <td>${row.status === 'SENT' ? '<span class="pill dot ok">Sent</span>' : row.status === 'FAILED' ? `<span class="pill dot bad">Failed</span><div class="small muted" style="margin-top:4px">${esc(row.error || '')}</div>` : `<span class="pill">${esc(row.status === 'DRY_RUN' ? 'Test mode — not sent' : row.status)}</span>`}</td></tr>`).join('')}</tbody></table></div>`
            : emptyState('mail', 'No emails yet', 'Pause and restore emails will be listed here.')}</div>`);
    } catch (error) {
        if (error.message !== 'Signed out') setContent(errorBanner(error.message));
    }
}

// ---------- Locations ----------
async function reloadLocations() {
    const data = await api('/api/locations');
    state.locations = data.locations;
}

function locationCard(loc) {
    const missing = loc.secrets.filter(s => s.required && !s.set);
    const webhook = loc.secrets.find(s => s.name.endsWith('MOMENCE_WEBHOOK_SECRET'));
    const status = loc.enabled === false ? '<span class="pill dot warn">Paused</span>' : loc.ready ? '<span class="pill dot ok">Running</span>' : '<span class="pill dot bad">Setup needed</span>';
    return `
    <div class="card loc-card">
        <div class="card-body">
            <div class="loc-title"><h3>${esc(loc.name)}</h3>${loc.isDefault ? '<span class="pill">Primary</span>' : ''}${status}${loc.dryRun ? '<span class="pill info">Test mode</span>' : ''}</div>
            <div class="checklist">
                <div><span class="tick ${missing.length ? 'no' : 'yes'}">${icon(missing.length ? 'x' : 'check', 11)}</span><span>${missing.length ? `Add in Railway: <span class="mono">${esc(missing.map(s => s.name).join(', '))}</span>` : 'Momence and email connected'}</span></div>
                <div><span class="tick ${loc.sheetId ? 'yes' : 'no'}">${icon(loc.sheetId ? 'check' : 'x', 11)}</span><span>${loc.sheetId ? `Google Sheet linked · <a href="https://docs.google.com/spreadsheets/d/${esc(loc.sheetId)}" target="_blank" rel="noopener">open</a>` : 'No Google Sheet'}</span></div>
                <div><span class="tick ${webhook?.set ? 'yes' : 'opt'}">${icon(webhook?.set ? 'bolt' : 'clock', 11)}</span><span>${webhook?.set ? 'Real-time cancellations on' : `Hourly only — add <span class="mono">${esc(webhook?.name || 'MOMENCE_WEBHOOK_SECRET')}</span> for real-time`}</span></div>
            </div>
            <div><div class="small muted" style="margin-bottom:6px">Webhook address — paste into Momence</div>
                <div class="copy-row"><code>${esc(loc.webhookUrl)}</code><button class="btn sm" data-copy="${esc(loc.webhookUrl)}">${icon('copy', 13)} Copy</button></div></div>
            <details class="more"><summary>Settings & all secrets</summary><div>
                <dl class="kv small">
                    <dt>Momence host</dt><dd class="mono">${esc(loc.hostId)}</dd>
                    <dt>LC-7 tag</dt><dd class="mono">${esc(loc.lc7TagId)}</dd>
                    <dt>P57 tag</dt><dd class="mono">${esc(loc.p57TagId)}</dd>
                    <dt>Secrets prefix</dt><dd class="mono">${esc(loc.envPrefix || 'none (primary)')}</dd>
                </dl>
                <div class="checklist" style="margin-top:12px">${loc.secrets.map(secret => `<div><span class="tick ${secret.set ? 'yes' : secret.required ? 'no' : 'opt'}">${icon(secret.set ? 'check' : secret.required ? 'x' : 'plus', 10)}</span><span class="mono">${esc(secret.name)}</span><span class="muted">${secret.inherited ? 'shared with primary' : secret.required ? '' : 'optional'}</span></div>`).join('')}</div>
            </div></details>
            <div id="check-${esc(loc.id)}"></div>
        </div>
        <div class="loc-actions">
            <button class="btn sm" data-check="${esc(loc.id)}">${icon('check', 13)} Test connection</button>
            ${loc.isDefault ? '' : `<button class="btn sm" data-edit="${esc(loc.id)}">Edit</button><button class="btn sm" data-toggle="${esc(loc.id)}">${loc.enabled === false ? 'Resume' : 'Pause'}</button><button class="btn sm ghost danger-text" data-remove="${esc(loc.id)}">Remove</button>`}
            ${loc.id === state.location ? '<span class="pill" style="margin-left:auto">Viewing</span>' : `<button class="btn sm primary" data-open="${esc(loc.id)}" style="margin-left:auto">Open ${icon('arrow', 13)}</button>`}
        </div>
    </div>`;
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
    <div class="toolbar"><div class="muted">Every location uses the same rule with its own Momence studio and Google Sheet.</div>
        <button class="btn primary" style="margin-left:auto" id="add-loc">${icon('plus', 15)} Add location</button></div>
    <div class="loc-grid">${state.locations.map(locationCard).join('')}</div>`);
    $('#add-loc').addEventListener('click', () => openLocationModal());
    $$('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
        toast('Webhook address copied.');
    }));
    $$('[data-edit]').forEach(btn => btn.addEventListener('click', () => openLocationModal(state.locations.find(loc => loc.id === btn.dataset.edit))));
    $$('[data-open]').forEach(btn => btn.addEventListener('click', () => {
        switchLocation(btn.dataset.open);
        location.hash = '#/overview';
    }));
    $$('[data-toggle]').forEach(btn => btn.addEventListener('click', async () => {
        const loc = state.locations.find(item => item.id === btn.dataset.toggle);
        await withBusy(btn, async () => {
            await api(`/api/locations/${encodeURIComponent(loc.id)}`, { method: 'PUT', body: { enabled: loc.enabled === false } });
            toast(loc.enabled === false ? 'Location resumed.' : 'Location paused — hourly checks skip it.');
            renderLocations();
        });
    }));
    $$('[data-remove]').forEach(btn => btn.addEventListener('click', async () => {
        const loc = state.locations.find(item => item.id === btn.dataset.remove);
        const ok = await confirmDialog({
            title: `Remove ${loc.name}?`,
            body: '<p style="margin:0">Hourly checks and webhooks stop for this location. Its Google Sheet, Momence tags and Railway secrets are not touched — you can add it again later.</p>',
            confirmLabel: 'Remove location',
            tone: 'danger'
        });
        if (!ok) return;
        try {
            await api(`/api/locations/${encodeURIComponent(loc.id)}`, { method: 'DELETE' });
            if (state.location === loc.id) state.location = 'default';
            toast('Location removed.');
            renderLocations();
        } catch (error) {
            if (error.message !== 'Signed out') toast(error.message, 'bad');
        }
    }));
    $$('[data-check]').forEach(btn => btn.addEventListener('click', async () => {
        const target = $(`#check-${CSS.escape(btn.dataset.check)}`);
        await withBusy(btn, async () => {
            const result = await api(`/api/locations/${encodeURIComponent(btn.dataset.check)}/check`, { method: 'POST' });
            const allOk = result.checks.every(check => check.ok);
            target.innerHTML = `<div class="banner ${allOk ? 'ok-banner' : 'warn'}">${icon(allOk ? 'check' : 'alert', 18)}<div><strong>${allOk ? 'Everything works' : 'Some checks failed'}</strong>
                <div class="checklist" style="margin-top:6px">${result.checks.map(check => `<div><span class="tick ${check.ok ? 'yes' : 'no'}">${icon(check.ok ? 'check' : 'x', 10)}</span><div>${esc(check.name)}${check.detail ? `<div class="small" style="opacity:.8">${esc(check.detail)}</div>` : ''}</div></div>`).join('')}</div></div></div>`;
        });
    }));
}

function openLocationModal(existing = null) {
    const loc = existing || { currency: 'inr', enabled: true, dryRun: true };
    const editing = Boolean(existing);
    const field = (id, label, help = '', attrs = '') => `<div class="field"><label for="f-${id}">${label}</label><input id="f-${id}" value="${esc(loc[id] ?? '')}" ${attrs}>${help ? `<div class="help">${help}</div>` : ''}</div>`;
    const panel = overlay(`
        <div class="modal-head"><div><h2>${editing ? `Edit ${esc(loc.name)}` : 'Add a location'}</h2><p>${editing ? 'Changes apply from the next check.' : 'Same rule, another studio. Takes about 5 minutes.'}</p></div><button class="close" data-close aria-label="Close">${icon('x', 15)}</button></div>
        <form id="loc-form"><div class="modal-body">
            <div id="loc-error"></div>
            <div class="section-title" style="margin-top:0">1 · Name it</div>
            <div class="row">${field('name', 'Location name', 'e.g. Bengaluru – Indiranagar', 'required')}${field('id', 'Short code', 'Lowercase, e.g. blr. Used in its webhook address; cannot change later.', editing ? 'disabled' : 'required pattern="[a-z0-9][a-z0-9-]{1,30}"')}</div>
            <div class="section-title">2 · Momence studio</div>
            <div class="row three">${field('hostId', 'Host ID', 'In Momence addresses: /host/<b>12345</b>/', 'required inputmode="numeric"')}${field('lc7TagId', 'LC-7 tag ID', 'Tag that pauses booking', 'required inputmode="numeric"')}${field('p57TagId', 'P57 tag ID', 'Tag that allows booking', 'required inputmode="numeric"')}</div>
            <div class="section-title">3 · Google Sheet</div>
            ${field('sheetId', 'Sheet ID', 'Create a blank Google Sheet with the same Google account and paste the long ID from its address. Tabs are added automatically.', 'required')}
            <div class="section-title">4 · Railway secrets</div>
            <div class="row">${field('envPrefix', 'Secrets prefix', 'e.g. BLR_ — this location’s Momence login goes in Railway as BLR_MOMENCE_ACCESS_TOKEN, BLR_MOMENCE_ALL_COOKIES, …', 'required')}${field('currency', 'Currency', 'For booking refunds, e.g. inr')}</div>
            <details class="more"><summary>Email settings (optional)</summary><div>
                <div class="row">${field('mailFrom', 'From address', 'Empty = same as primary')}${field('mailFromName', 'From name')}</div>
                <div class="row">${field('mailReplyTo', 'Reply-to')}${field('signatureName', 'Signature', 'e.g. Team Physique 57 Bengaluru')}</div>
                <div class="row">${field('templateAUuid', '“Booking paused” template ID', 'Mailtrap template UUID')}${field('templateBUuid', '“You can book again” template ID', 'Mailtrap template UUID')}</div>
            </div></details>
            <div class="section-title">5 · Start safely</div>
            <label class="check"><input type="checkbox" id="f-dryRun" ${loc.dryRun ? 'checked' : ''}><div><strong>Test mode</strong><span>Detects and logs pauses without changing Momence or emailing anyone. Recommended for the first day.</span></div></label>
            <label class="check"><input type="checkbox" id="f-enabled" ${loc.enabled !== false ? 'checked' : ''}><div><strong>Include in hourly checks</strong><span>Untick to pause this location.</span></div></label>
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
                toast(editing ? 'Location saved.' : 'Location added. Next: add its secrets in Railway, then Test connection.');
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
        toast('Check started. Open Live activity to follow it.');
    } catch (error) {
        if (error.message !== 'Signed out') toast(error.message, 'bad');
        button.disabled = false;
    }
}

// ---------- Routing & boot ----------
function route() {
    const view = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    state.view = PAGES.some(item => item.id === view) ? view : 'overview';
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
