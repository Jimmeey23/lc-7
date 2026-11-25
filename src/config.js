require('dotenv').config();

// Location-specific values. Defaults are the original Mumbai/P57 deployment, so an
// unchanged .env behaves exactly as before. To replicate for another city/location,
// deploy a separate instance with its own .env (see .env.example / README).
function envNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
    return value;
}

const LOCATION_NAME = process.env.LOCATION_NAME || 'default';
const HOST_ID = envNumber('MOMENCE_HOST_ID', 13752);
const LC7_TAG_ID = envNumber('LC7_TAG_ID', 164561);
const P57_TAG_ID = envNumber('P57_TAG_ID', 164581);
const MOMENCE_CURRENCY = process.env.MOMENCE_CURRENCY || 'inr';
const MAX_AUTO_RETRIES = envNumber('MAX_AUTO_RETRIES', 5);
const LIFECYCLE_STATUSES = {
    DETECTED: 'DETECTED',
    LC7_TAG_ASSIGNED: 'LC7_TAG_ASSIGNED',
    FUTURE_BOOKINGS_CANCELLED: 'FUTURE_BOOKINGS_CANCELLED',
    WAITING_7_DAYS: 'WAITING_7_DAYS',
    P57_TAG_ASSIGNED: 'P57_TAG_ASSIGNED',
    OVERRIDE: 'OVERRIDE',
    FAILED: 'FAILED',
    RETRY_PENDING: 'RETRY_PENDING'
};

// Secrets that may differ per location. A location with envPrefix "BLR_" reads
// BLR_MOMENCE_ACCESS_TOKEN etc. Momence and webhook secrets never fall back to the
// default location's values (that would act on the wrong studio); shared accounts
// (Google, Mailtrap) do.
const LOCATION_SECRET_KEYS = [
    { key: 'MOMENCE_ACCESS_TOKEN', required: true, fallback: false },
    { key: 'MOMENCE_ALL_COOKIES', required: true, fallback: false },
    { key: 'MOMENCE_WEBHOOK_SECRET', required: false, fallback: false },
    { key: 'MOMENCE_API_CLIENT_ID', required: false, fallback: false },
    { key: 'MOMENCE_API_CLIENT_SECRET', required: false, fallback: false },
    { key: 'MOMENCE_API_USERNAME', required: false, fallback: false },
    { key: 'MOMENCE_API_PASSWORD', required: false, fallback: false },
    { key: 'MOMENCE_V2_ACCESS_TOKEN', required: false, fallback: false },
    { key: 'MAILTRAP_API_TOKEN', required: true, fallback: true }
];

function locationEnv(prefix, key, fallback) {
    if (!prefix) return process.env[key];
    const own = process.env[`${prefix}${key}`];
    if (own) return own;
    return fallback ? process.env[key] : undefined;
}

function secretStatus(location = {}) {
    const prefix = location.envPrefix || '';
    return LOCATION_SECRET_KEYS.map(({ key, required, fallback }) => ({
        name: `${prefix}${key}`,
        required,
        set: Boolean(locationEnv(prefix, key, fallback)),
        inherited: Boolean(prefix && !process.env[`${prefix}${key}`] && fallback && process.env[key])
    }));
}

function pick(value, fallback) {
    return value === undefined || value === null || value === '' ? fallback : value;
}

// location: optional object from the Locations tab. Without it, the default
// (env-only) location is returned exactly as before.
function getConfig(location = null) {
    const loc = location || {};
    const prefix = loc.envPrefix || '';
    const env = (key, fallback = false) => locationEnv(prefix, key, fallback);
    const config = {
        locationId: loc.id || 'default',
        locationName: pick(loc.name, LOCATION_NAME),
        hostId: Number(pick(loc.hostId, HOST_ID)),
        currency: pick(loc.currency, MOMENCE_CURRENCY),
        lc7TagId: Number(pick(loc.lc7TagId, LC7_TAG_ID)),
        p57TagId: Number(pick(loc.p57TagId, P57_TAG_ID)),
        accessToken: env('MOMENCE_ACCESS_TOKEN'),
        allCookies: env('MOMENCE_ALL_COOKIES'),
        googleClientId: process.env.GOOGLE_CLIENT_ID,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
        googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        sheetId: pick(loc.sheetId, process.env.LC7_LIFECYCLE_SHEET_ID),
        mail: {
            apiUrl: process.env.MAILTRAP_API_URL || 'https://send.api.mailtrap.io/api/send',
            apiToken: env('MAILTRAP_API_TOKEN', true),
            from: pick(loc.mailFrom, process.env.MAIL_FROM || 'hello@physique57india.com'),
            fromName: pick(loc.mailFromName, process.env.MAIL_FROM_NAME || 'Mailtrap Test'),
            replyTo: pick(loc.mailReplyTo, process.env.MAIL_REPLY_TO || 'latecancellations@physique57india.com'),
            templateAUuid: loc.templateAUuid || '',
            templateBUuid: loc.templateBUuid || '',
            signatureName: loc.signatureName || ''
        },
        dryRun: process.env.DRY_RUN === 'true' || String(loc.dryRun).toLowerCase() === 'true',
        testMemberId: process.env.TEST_MEMBER_ID ? Number(process.env.TEST_MEMBER_ID) : null,
        cronSchedule: process.env.CRON_SCHEDULE || '0 * * * *',
        reportPollAttempts: Number(process.env.REPORT_POLL_ATTEMPTS) || 40,
        reportPollIntervalMs: Number(process.env.REPORT_POLL_INTERVAL_MS) || 3000,
        reportLookbackDays: Number(process.env.REPORT_LOOKBACK_DAYS) || 30,
        momenceRateLimitMs: Number(process.env.MOMENCE_RATE_LIMIT_MS) || 200,
        emailDedupMigratedAt: process.env.EMAIL_DEDUP_MIGRATED_AT || null,
        // Momence public API v2 (used by the webhook flow). Either OAuth password-grant
        // credentials, or a ready access token. Falls back to MOMENCE_ACCESS_TOKEN.
        momenceV2: {
            clientId: env('MOMENCE_API_CLIENT_ID') || '',
            clientSecret: env('MOMENCE_API_CLIENT_SECRET') || '',
            username: env('MOMENCE_API_USERNAME') || '',
            password: env('MOMENCE_API_PASSWORD') || '',
            staticToken: env('MOMENCE_V2_ACCESS_TOKEN') || env('MOMENCE_ACCESS_TOKEN') || ''
        },
        webhook: {
            secret: env('MOMENCE_WEBHOOK_SECRET') || '',
            enforceSignature: process.env.MOMENCE_WEBHOOK_ENFORCE_SIGNATURE === 'true',
            path: loc.id && loc.id !== 'default'
                ? `${process.env.WEBHOOK_PATH || '/webhooks/momence'}/${loc.id}`
                : process.env.WEBHOOK_PATH || '/webhooks/momence',
            port: Number(process.env.PORT) || 3000
        }
    };

    const missing = [];
    for (const [key, value] of Object.entries({
        [`${prefix}MOMENCE_ACCESS_TOKEN`]: config.accessToken,
        [`${prefix}MOMENCE_ALL_COOKIES`]: config.allCookies,
        GOOGLE_CLIENT_ID: config.googleClientId,
        GOOGLE_CLIENT_SECRET: config.googleClientSecret,
        GOOGLE_REFRESH_TOKEN: config.googleRefreshToken,
        [prefix ? 'sheetId (location setting)' : 'LC7_LIFECYCLE_SHEET_ID']: config.sheetId,
        [`${prefix}MAILTRAP_API_TOKEN`]: config.mail.apiToken
    })) {
        if (!value) missing.push(key);
    }

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables${prefix ? ` for location ${config.locationId}` : ''}: ${missing.join(', ')}`);
    }

    return config;
}

module.exports = {
    HOST_ID,
    LC7_TAG_ID,
    LOCATION_NAME,
    MOMENCE_CURRENCY,
    MAX_AUTO_RETRIES,
    P57_TAG_ID,
    LIFECYCLE_STATUSES,
    LOCATION_SECRET_KEYS,
    getConfig,
    secretStatus
};
