const fs = require('fs');
const http = require('http');
const path = require('path');
const { createSheetsStore } = require('./sheets-store');
const { bus, recent } = require('./log-bus');
const { describeLocation } = require('./locations');
const { createWebhookQueue } = require('./webhook-server');
const { isLateCancellationEvent, verifyWebhook } = require('./webhook');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readJson(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
    }
}

function createAppServer({ runtime, registry, auth, webhookPath = '/webhooks/momence', enforceSignature = false }) {
    const queues = new Map();

    function queueFor(locationId) {
        if (!queues.has(locationId)) {
            queues.set(locationId, createWebhookQueue({
                locationId,
                createContext: async () => {
                    const ctx = await runtime.context(locationId);
                    return { ...ctx, store: await createSheetsStore(ctx.config) };
                },
                onProcessed: () => runtime.invalidate(locationId)
            }));
        }
        return queues.get(locationId);
    }

    function send(res, status, body, headers = {}) {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
        res.end(JSON.stringify(body));
    }

    function serveStatic(res, pathname) {
        const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolved = path.normalize(path.join(PUBLIC_DIR, file));
        if (!resolved.startsWith(PUBLIC_DIR)) return false;
        let target = resolved;
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
            if (path.extname(file)) return false;
            target = path.join(PUBLIC_DIR, 'index.html'); // client-side routes
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
            'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
            ...SECURITY_HEADERS
        });
        fs.createReadStream(target).pipe(res);
        return true;
    }

    async function handleWebhook(req, res, locationId) {
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        let ctx;
        try {
            ctx = await runtime.context(locationId);
        } catch (error) {
            return send(res, error.statusCode === 404 ? 404 : 503, { error: error.message });
        }
        const rawBody = await readBody(req);
        const verified = verifyWebhook({
            headers: req.headers,
            rawBody,
            secret: ctx.config.webhook.secret,
            enforceSignature: ctx.config.webhook.enforceSignature || enforceSignature
        });
        if (!verified.ok) {
            console.warn(`Webhook rejected for ${locationId} (${verified.status}): ${verified.reason}`);
            return send(res, verified.status, { error: verified.reason });
        }
        if (!isLateCancellationEvent(verified)) return send(res, 200, { ok: true, ignored: true, event: verified.event });
        const accepted = queueFor(locationId).enqueue(verified);
        return send(res, 200, { ok: true, queued: accepted, duplicate: !accepted });
    }

    function handleLive(req, res, url) {
        const location = url.searchParams.get('location') || '';
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...SECURITY_HEADERS
        });
        const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        write('hello', { lines: recent({ location, limit: 400 }), state: Object.fromEntries(runtime.state) });
        const onLine = line => {
            if (!location || !line.location || line.location === location) write('line', line);
        };
        const onEvent = event => write(event.type, event.data);
        bus.on('line', onLine);
        bus.on('event', onEvent);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(ping);
            bus.off('line', onLine);
            bus.off('event', onEvent);
        });
    }

    async function handleApi(req, res, url) {
        const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
        const method = req.method;

        if (parts[0] === 'session' && method === 'GET') {
            return send(res, 200, { configured: auth.configured, authenticated: auth.isAuthenticated(req) });
        }
        if (parts[0] === 'login' && method === 'POST') {
            const body = await readJson(req);
            const result = auth.login(req, body.password);
            if (!result.ok) return send(res, result.status, { error: result.error });
            return send(res, 200, { ok: true }, { 'Set-Cookie': result.cookie });
        }
        if (parts[0] === 'logout' && method === 'POST') {
            return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logoutCookie(req) });
        }

        if (!auth.isAuthenticated(req)) return send(res, 401, { error: 'Not signed in' });
        // CSRF guard on top of SameSite=Strict: mutations must come from our own JS.
        if (method !== 'GET' && req.headers['x-lc7-request'] !== '1') return send(res, 403, { error: 'Missing request header' });

        if (parts[0] === 'live') return handleLive(req, res, url);

        if (parts[0] === 'locations') {
            const id = parts[1];
            if (!id && method === 'GET') {
                const list = await registry.list();
                return send(res, 200, {
                    locations: list.map(location => ({ ...describeLocation(location), state: runtime.locationState(location.id) }))
                });
            }
            if (!id && method === 'POST') {
                const location = await registry.create(await readJson(req));
                console.log(`📍 Location added from dashboard: ${location.id} (${location.name})`);
                return send(res, 201, { location: describeLocation(location) });
            }
            if (id && parts[2] === 'check' && method === 'POST') return send(res, 200, await runtime.checkLocation(id));
            if (id && method === 'PUT') {
                const location = await registry.update(id, await readJson(req));
                console.log(`📍 Location updated from dashboard: ${id}`);
                return send(res, 200, { location: describeLocation(location) });
            }
            if (id && method === 'DELETE') {
                await registry.remove(id);
                console.log(`📍 Location removed from dashboard: ${id}`);
                return send(res, 200, { ok: true });
            }
        }

        if (parts[0] === 'l' && parts[1]) {
            const id = parts[1];
            const action = parts[2];
            if (action === 'overview' && method === 'GET') return send(res, 200, await runtime.overview(id));
            if (action === 'members' && method === 'GET') {
                return send(res, 200, await runtime.members(id, {
                    status: url.searchParams.get('status') || 'active',
                    q: url.searchParams.get('q') || ''
                }));
            }
            if (action === 'at-risk' && method === 'GET') return send(res, 200, await runtime.atRisk(id));
            if (action === 'logs' && method === 'GET') return send(res, 200, await runtime.logs(id, parts[3]));
            if (action === 'member-lookup' && method === 'GET') return send(res, 200, await runtime.lookupMember(id, url.searchParams.get('memberId')));
            if (action === 'refresh' && method === 'POST') {
                runtime.invalidate(id);
                return send(res, 200, { ok: true });
            }
            if (action === 'run' && method === 'POST') {
                if (runtime.locationState(id).running) return send(res, 409, { error: 'A run is already in progress.' });
                runtime.runLocation(id, 'dashboard').catch(error => console.error(`Dashboard run failed for ${id}: ${error.message}`));
                return send(res, 202, { ok: true, started: true });
            }
            if (action === 'block' && method === 'POST') return send(res, 200, await runtime.blockMember(id, await readJson(req)));
            if (action === 'cycles' && parts[3] && method === 'POST') {
                const cycleId = parts[3];
                const body = await readJson(req);
                if (parts[4] === 'end') return send(res, 200, await runtime.endBlock(id, cycleId, body));
                if (parts[4] === 'end-date') return send(res, 200, await runtime.changeEndDate(id, cycleId, body.endsAt));
                if (parts[4] === 'retry') return send(res, 200, await runtime.retryCycle(id, cycleId));
            }
        }

        return send(res, 404, { error: 'Not found' });
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const { pathname } = url;
            if (pathname === '/health') return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
            if (pathname === webhookPath) return await handleWebhook(req, res, 'default');
            if (pathname.startsWith(`${webhookPath}/`)) return await handleWebhook(req, res, pathname.slice(webhookPath.length + 1));
            if (pathname.startsWith('/api/')) return await handleApi(req, res, url);
            if (req.method === 'GET' && serveStatic(res, pathname)) return;
            return send(res, 404, { error: 'Not found' });
        } catch (error) {
            const status = error.statusCode || error.response?.status && 502 || 500;
            if (status >= 500) console.error(`App server error: ${error.stack || error.message}`);
            if (!res.headersSent) send(res, status, { error: error.statusCode ? error.message : `Server error: ${error.message}` });
            else res.end();
        }
    });
    server.webhookQueues = queues;
    return server;
}

module.exports = { createAppServer };
