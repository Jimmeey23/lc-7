const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_ENV = {
    MOMENCE_ACCESS_TOKEN: 'base-token',
    MOMENCE_ALL_COOKIES: 'base-cookies',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    GOOGLE_REFRESH_TOKEN: 'grefresh',
    LC7_LIFECYCLE_SHEET_ID: 'base-sheet',
    MAILTRAP_API_TOKEN: 'mail-token'
};
Object.assign(process.env, BASE_ENV);

const { getConfig, secretStatus } = require('../src/config');
const { normaliseLocation, validateLocation } = require('../src/locations');
const { createAuth } = require('../src/auth');
const { createAppServer } = require('../src/app-server');
const { install, withLogContext, recent } = require('../src/log-bus');

const blr = {
    id: 'blr', name: 'Bengaluru', hostId: '999', lc7TagId: '11', p57TagId: '22',
    sheetId: 'blr-sheet-id-abcdefghijklmnop', envPrefix: 'BLR_', currency: 'inr'
};

test('default config is unchanged without a location', () => {
    const config = getConfig();
    assert.equal(config.locationId, 'default');
    assert.equal(config.accessToken, 'base-token');
    assert.equal(config.sheetId, 'base-sheet');
    assert.equal(config.webhook.path, '/webhooks/momence');
});

test('location config uses its own tags, sheet and prefixed secrets', () => {
    assert.throws(() => getConfig(blr), /BLR_MOMENCE_ACCESS_TOKEN/);
    process.env.BLR_MOMENCE_ACCESS_TOKEN = 'blr-token';
    process.env.BLR_MOMENCE_ALL_COOKIES = 'blr-cookies';
    try {
        const config = getConfig(blr);
        assert.equal(config.hostId, 999);
        assert.equal(config.lc7TagId, 11);
        assert.equal(config.p57TagId, 22);
        assert.equal(config.sheetId, blr.sheetId);
        assert.equal(config.accessToken, 'blr-token');
        assert.equal(config.mail.apiToken, 'mail-token', 'Mailtrap token is shared');
        assert.equal(config.webhook.secret, '', 'webhook secret never falls back to primary');
        assert.equal(config.webhook.path, '/webhooks/momence/blr');
        const status = secretStatus(blr);
        assert.ok(status.find(item => item.name === 'BLR_MOMENCE_ACCESS_TOKEN').set);
        assert.ok(status.find(item => item.name === 'BLR_MAILTRAP_API_TOKEN').inherited);
    } finally {
        delete process.env.BLR_MOMENCE_ACCESS_TOKEN;
        delete process.env.BLR_MOMENCE_ALL_COOKIES;
    }
});

test('location validation', () => {
    assert.deepEqual(validateLocation(normaliseLocation(blr)), []);
    const bad = validateLocation(normaliseLocation({ ...blr, id: 'Bad ID', hostId: 'x', envPrefix: '' }));
    assert.ok(bad.length >= 3);
    assert.equal(normaliseLocation({ ...blr, envPrefix: 'blr' }).envPrefix, 'BLR_');
    assert.ok(validateLocation(normaliseLocation(blr), ['blr']).some(error => error.includes('already exists')));
});

test('auth: no password locks the dashboard; correct password issues a session', () => {
    const locked = createAuth({ password: '' });
    assert.equal(locked.login({ headers: {}, socket: {} }, 'x').status, 503);

    const auth = createAuth({ password: 'pw' });
    const req = { headers: {}, socket: { remoteAddress: '1.1.1.1' } };
    assert.equal(auth.login(req, 'nope').status, 401);
    const ok = auth.login(req, 'pw');
    assert.ok(ok.ok);
    const cookie = ok.cookie.split(';')[0];
    assert.ok(auth.isAuthenticated({ headers: { cookie } }));
    assert.ok(!auth.isAuthenticated({ headers: { cookie: `${cookie}x` } }));
});

test('log bus tags lines with the active location', async () => {
    install();
    await withLogContext({ location: 'blr', source: 'test' }, async () => {
        console.log('hello from blr');
    });
    const line = recent({ location: 'blr' }).find(item => item.message === 'hello from blr');
    assert.equal(line.location, 'blr');
    assert.ok(!recent({ location: 'default' }).some(item => item.message === 'hello from blr'));
});

test('API requires sign-in, a request header for writes, and routes actions', async () => {
    const calls = [];
    const runtime = {
        state: new Map(),
        locationState: () => ({ running: false }),
        overview: async id => ({ location: { id }, counts: {} }),
        endBlock: async (id, cycleId, body) => { calls.push(['end', id, cycleId, body]); return { ok: true }; },
        blockMember: async (id, body) => { calls.push(['block', id, body]); return { ok: true }; },
        runLocation: async id => { calls.push(['run', id]); },
        context: async () => { throw Object.assign(new Error('Unknown location: x'), { statusCode: 404 }); },
        invalidate: () => {}
    };
    const registry = { list: async () => [{ id: 'default', name: 'Primary', isDefault: true }] };
    const auth = createAuth({ password: 'pw' });
    const server = createAppServer({ runtime, registry, auth });
    await new Promise(resolve => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${base}/api/l/default/overview`)).status, 401);
        const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];

        const overview = await fetch(`${base}/api/l/default/overview`, { headers: { cookie } });
        assert.equal(overview.status, 200);

        const noHeader = await fetch(`${base}/api/l/default/cycles/c1/end`, { method: 'POST', headers: { cookie }, body: '{}' });
        assert.equal(noHeader.status, 403, 'writes need the X-LC7-Request header');

        const headers = { cookie, 'X-LC7-Request': '1' };
        assert.equal((await fetch(`${base}/api/l/default/cycles/c1/end`, { method: 'POST', headers, body: JSON.stringify({ silent: true }) })).status, 200);
        assert.equal((await fetch(`${base}/api/l/default/block`, { method: 'POST', headers, body: JSON.stringify({ memberId: 5 }) })).status, 200);
        assert.equal((await fetch(`${base}/api/l/default/run`, { method: 'POST', headers })).status, 202);
        assert.deepEqual(calls.map(call => call[0]), ['end', 'block', 'run']);
        assert.deepEqual(calls[0].slice(1), ['default', 'c1', { silent: true }]);

        const page = await fetch(`${base}/`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /LC-7 Control Room/);
        assert.equal((await fetch(`${base}/webhooks/momence/x`, { method: 'POST', body: '{}' })).status, 404);
        assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally {
        server.close();
    }
});
