require('dotenv').config();

const HOST_ID = 13752;
const LC7_TAG_ID = 164561;
const P57_TAG_ID = 164581;
const LIFECYCLE_STATUSES = {
    DETECTED: 'DETECTED',
    LC7_TAG_ASSIGNED: 'LC7_TAG_ASSIGNED',
    FUTURE_BOOKINGS_CANCELLED: 'FUTURE_BOOKINGS_CANCELLED',
    WAITING_7_DAYS: 'WAITING_7_DAYS',
    P57_TAG_ASSIGNED: 'P57_TAG_ASSIGNED',
    FAILED: 'FAILED'
};

function getConfig() {
    const config = {
        hostId: HOST_ID,
        lc7TagId: LC7_TAG_ID,
        p57TagId: P57_TAG_ID,
        accessToken: process.env.MOMENCE_ACCESS_TOKEN,
        allCookies: process.env.MOMENCE_ALL_COOKIES,
        googleClientId: process.env.GOOGLE_CLIENT_ID,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
        googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        sheetId: process.env.LC7_LIFECYCLE_SHEET_ID,
        dryRun: process.env.DRY_RUN === 'true',
        testMemberId: process.env.TEST_MEMBER_ID ? Number(process.env.TEST_MEMBER_ID) : null,
        cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *'
    };

    const missing = [];
    for (const [key, value] of Object.entries({
        MOMENCE_ACCESS_TOKEN: config.accessToken,
        MOMENCE_ALL_COOKIES: config.allCookies,
        GOOGLE_CLIENT_ID: config.googleClientId,
        GOOGLE_CLIENT_SECRET: config.googleClientSecret,
        GOOGLE_REFRESH_TOKEN: config.googleRefreshToken,
        LC7_LIFECYCLE_SHEET_ID: config.sheetId
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
    P57_TAG_ID,
    LIFECYCLE_STATUSES,
    getConfig
};
