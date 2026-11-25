const crypto = require('crypto');

// Single shared admin password (ADMIN_PASSWORD) with signed, expiring session
// cookies. No password configured → the dashboard stays locked.
const COOKIE = 'lc7_session';
const SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS) || 12;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function createAuth({ password = process.env.ADMIN_PASSWORD || '', secret = process.env.SESSION_SECRET || '' } = {}) {
    const key = crypto.createHash('sha256').update(`${secret}|${password}|lc7-dashboard`).digest();
    const attempts = new Map();

    function sign(value) {
        return crypto.createHmac('sha256', key).update(value).digest('base64url');
    }

    function safeEqual(a, b) {
        const left = Buffer.from(String(a));
        const right = Buffer.from(String(b));
        return left.length === right.length && crypto.timingSafeEqual(left, right);
    }

    function parseCookies(header = '') {
        const out = {};
        for (const part of header.split(';')) {
            const index = part.indexOf('=');
            if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
        }
        return out;
    }

    function isAuthenticated(req) {
        if (!password) return false;
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (!token) return false;
        const [expires, signature] = token.split('.');
        if (!expires || !signature || !safeEqual(signature, sign(expires))) return false;
        return Number(expires) > Date.now();
    }

    function clientIp(req) {
        return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    }

    // Returns { ok, cookie } or { ok:false, status, error }.
    function login(req, attempt) {
        if (!password) return { ok: false, status: 503, error: 'ADMIN_PASSWORD is not set on the server. Add it in Railway variables to enable the dashboard.' };
        const ip = clientIp(req);
        const now = Date.now();
        const recent = (attempts.get(ip) || []).filter(at => now - at < ATTEMPT_WINDOW_MS);
        if (recent.length >= MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
        const given = crypto.createHash('sha256').update(String(attempt || '')).digest();
        const expected = crypto.createHash('sha256').update(password).digest();
        if (!crypto.timingSafeEqual(given, expected)) {
            recent.push(now);
            attempts.set(ip, recent);
            return { ok: false, status: 401, error: 'Incorrect password.' };
        }
        attempts.delete(ip);
        const expires = String(now + SESSION_HOURS * 3600 * 1000);
        return { ok: true, cookie: sessionCookie(`${expires}.${sign(expires)}`, SESSION_HOURS * 3600, req) };
    }

    function sessionCookie(value, maxAge, req) {
        const secure = req && (req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production') ? '; Secure' : '';
        return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
    }

    function logoutCookie(req) {
        return sessionCookie('', 0, req);
    }

    return { configured: Boolean(password), isAuthenticated, login, logoutCookie };
}

module.exports = { createAuth };
