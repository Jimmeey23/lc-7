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

function getConfig() {
    const config = {
        locationName: LOCATION_NAME,
        hostId: HOST_ID,
        currency: MOMENCE_CURRENCY,
        lc7TagId: LC7_TAG_ID,
        p57TagId: P57_TAG_ID,
        accessToken: process.env.MOMENCE_ACCESS_TOKEN,
        allCookies: process.env.MOMENCE_ALL_COOKIES,
        googleClientId: process.env.GOOGLE_CLIENT_ID,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
        googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        sheetId: process.env.LC7_LIFECYCLE_SHEET_ID,
        mail: {
            apiUrl: process.env.MAILTRAP_API_URL || 'https://send.api.mailtrap.io/api/send',
            apiToken: process.env.MAILTRAP_API_TOKEN,
            from: process.env.MAIL_FROM || 'hello@physique57india.com',
            fromName: process.env.MAIL_FROM_NAME || 'Mailtrap Test',
            replyTo: process.env.MAIL_REPLY_TO || 'latecancellations@physique57india.com'
        },
        dryRun: process.env.DRY_RUN === 'true',
        testMemberId: process.env.TEST_MEMBER_ID ? Number(process.env.TEST_MEMBER_ID) : null,
        cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',
        reportPollAttempts: Number(process.env.REPORT_POLL_ATTEMPTS) || 40,
        reportPollIntervalMs: Number(process.env.REPORT_POLL_INTERVAL_MS) || 3000,
        reportLookbackDays: Number(process.env.REPORT_LOOKBACK_DAYS) || 30,
        momenceRateLimitMs: Number(process.env.MOMENCE_RATE_LIMIT_MS) || 200,
        emailDedupMigratedAt: process.env.EMAIL_DEDUP_MIGRATED_AT || null
    };

    const missing = [];
    for (const [key, value] of Object.entries({
        MOMENCE_ACCESS_TOKEN: config.accessToken,
        MOMENCE_ALL_COOKIES: config.allCookies,
        GOOGLE_CLIENT_ID: config.googleClientId,
        GOOGLE_CLIENT_SECRET: config.googleClientSecret,
        GOOGLE_REFRESH_TOKEN: config.googleRefreshToken,
        LC7_LIFECYCLE_SHEET_ID: config.sheetId,
        MAILTRAP_API_TOKEN: config.mail.apiToken
    })) {
        if (!value) missing.push(key);
    }

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
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
    getConfig
};
