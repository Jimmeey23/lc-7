const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const { LIFECYCLE_STATUSES } = require('./config');
const { formatRunTimestamp } = require('./date-utils');

const RAW_HEADERS = [
    'rawId',
    'memberId',
    'memberName',
    'memberEmail',
    'cancelledEvent',
    'cancelledAt',
    'sessionAt',
    'membershipName',
    'homeLocation',
    'createdAt',
    'comment'
];

const LIFECYCLE_HEADERS = [
    'cycleId',
    'memberId',
    'memberName',
    'memberEmail',
    'latestLateCancellationAt',
    'triggerWindowDates',
    'lc7TriggeredAt',
    'lc7TagAssignedAt',
    'futureBookingsCancelledAt',
    'futureBookingsCancelledCount',
    'p57EligibleAt',
    'p57TagAssignedAt',
    'status',
    'lastError',
    'actionComment',
    'updatedAt'
];

const RUN_LOG_HEADERS = [
    'runId',
    'startedAt',
    'finishedAt',
    'rawRecordsFetched',
    'rawRecordsInserted',
    'cyclesCreated',
    'lc7Assigned',
    'bookingsCancelled',
    'p57Assigned',
    'failedCount',
    'emailsSent',
    'emailsFailed',
    'status',
    'message'
];

const CURRENT_LC7_HEADERS = [
    'memberId',
    'memberName',
    'memberEmail',
    'latestLateCancellationAt',
    'lc7TagAssignedAt',
    'p57EligibleAt',
    'status',
    'comment',
    'refreshedAt'
];

const EMAIL_LOG_HEADERS = [
    'emailId',
    'cycleId',
    'memberId',
    'memberEmail',
    'template',
    'subject',
    'status',
    'relatedDate',
    'sentAt',
    'error'
];

function rowToObject(row, headers) {
    const object = {};
    for (const header of headers) object[header] = row.get(header) || '';
    return object;
}

async function ensureSheet(doc, title, headers) {
    let sheet = doc.sheetsByTitle[title];
    if (!sheet) {
        return doc.addSheet({ title, headerValues: headers });
    }

    try {
        await sheet.loadHeaderRow();
    } catch (error) {
        if (String(error.message || '').includes('No values in the header row')) {
            await sheet.clear();
            await sheet.setHeaderRow(headers);
            return sheet;
        }
        throw error;
    }
    const currentHeaders = sheet.headerValues || [];
    const missingHeaders = headers.filter(header => !currentHeaders.includes(header));
    if (missingHeaders.length === 0) return sheet;

    const rows = await sheet.getRows();
    await sheet.clear();
    await sheet.setHeaderRow(headers);
    if (rows.length > 0) {
        await sheet.addRows(rows.map(row => {
            const newRow = {};
            for (const header of headers) newRow[header] = row.get(header) || '';
            return newRow;
        }));
    }
    return sheet;
}

async function createSheetsStore(config) {
    const oAuth2Client = new OAuth2Client({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: 'urn:ietf:wg:oauth:2.0:oob'
    });
    oAuth2Client.setCredentials({ refresh_token: config.googleRefreshToken });
    await oAuth2Client.getAccessToken();

    const doc = new GoogleSpreadsheet(config.sheetId, oAuth2Client);
    await doc.loadInfo();

    const rawSheet = await ensureSheet(doc, 'LateCancellationsRaw', RAW_HEADERS);
    const lifecycleSheet = await ensureSheet(doc, 'LC7Lifecycle', LIFECYCLE_HEADERS);
    const runLogSheet = await ensureSheet(doc, 'RunLog', RUN_LOG_HEADERS);
    const currentLc7Sheet = await ensureSheet(doc, 'CurrentLC7Members', CURRENT_LC7_HEADERS);
    const emailLogSheet = await ensureSheet(doc, 'EmailLog', EMAIL_LOG_HEADERS);

    async function getRawRows() {
        return (await rawSheet.getRows()).map(row => rowToObject(row, RAW_HEADERS));
    }

    async function insertRawRows(rawRows) {
        const existing = new Set((await getRawRows()).map(row => row.rawId));
        const rowsToInsert = rawRows.filter(row => !existing.has(row.rawId));
        if (rowsToInsert.length > 0) await rawSheet.addRows(rowsToInsert);
        return rowsToInsert.length;
    }

    async function getLifecycleRows() {
        return (await lifecycleSheet.getRows()).map(row => rowToObject(row, LIFECYCLE_HEADERS));
    }

    async function insertLifecycleRows(cycles) {
        if (cycles.length === 0) return 0;
        const existing = new Set((await getLifecycleRows()).map(row => row.cycleId));
        const rows = cycles
            .filter(cycle => !existing.has(cycle.cycleId))
            .map(cycle => ({
                cycleId: cycle.cycleId,
                memberId: cycle.memberId,
                memberName: cycle.memberName,
                memberEmail: cycle.memberEmail,
                latestLateCancellationAt: cycle.latestLateCancellationAt,
                triggerWindowDates: Array.isArray(cycle.triggerWindowDates) ? cycle.triggerWindowDates.join(' | ') : cycle.triggerWindowDates || '',
                lc7TriggeredAt: cycle.lc7TriggeredAt,
                lc7TagAssignedAt: '',
                futureBookingsCancelledAt: '',
                futureBookingsCancelledCount: '',
                p57EligibleAt: cycle.p57EligibleAt,
                p57TagAssignedAt: '',
                status: cycle.status || LIFECYCLE_STATUSES.DETECTED,
                lastError: cycle.lastError || '',
                actionComment: cycle.actionComment || '',
                updatedAt: formatRunTimestamp()
            }));
        if (rows.length > 0) await lifecycleSheet.addRows(rows);
        return rows.length;
    }

    async function updateCycle(cycleId, changes) {
        const rows = await lifecycleSheet.getRows();
        const row = rows.find(item => item.get('cycleId') === cycleId);
        if (!row) throw new Error(`Lifecycle cycle not found: ${cycleId}`);
        for (const [key, value] of Object.entries(changes)) row.set(key, value ?? '');
        row.set('updatedAt', formatRunTimestamp());
        await row.save();
    }

    async function getCyclesByStatus(status) {
        return (await getLifecycleRows()).filter(row => row.status === status);
    }

    async function appendRunLog(log) {
        await runLogSheet.addRow({
            runId: log.runId,
            startedAt: log.startedAt,
            finishedAt: log.finishedAt || '',
            rawRecordsFetched: log.rawRecordsFetched || 0,
            rawRecordsInserted: log.rawRecordsInserted || 0,
            cyclesCreated: log.cyclesCreated || 0,
            lc7Assigned: log.lc7Assigned || 0,
            bookingsCancelled: log.bookingsCancelled || 0,
            p57Assigned: log.p57Assigned || 0,
            failedCount: log.failedCount || 0,
            emailsSent: log.emailsSent || 0,
            emailsFailed: log.emailsFailed || 0,
            status: log.status || 'COMPLETED',
            message: log.message || ''
        });
    }

    async function getEmailLogRows() {
        return (await emailLogSheet.getRows()).map(row => rowToObject(row, EMAIL_LOG_HEADERS));
    }

    async function hasSentEmail(emailId) {
        const rows = await getEmailLogRows();
        return rows.some(row => row.emailId === emailId && row.status === 'SENT');
    }

    async function appendEmailLog(log) {
        await emailLogSheet.addRow({
            emailId: log.emailId,
            cycleId: log.cycleId || '',
            memberId: log.memberId || '',
            memberEmail: log.memberEmail || '',
            template: log.template || '',
            subject: log.subject || '',
            status: log.status || '',
            relatedDate: log.relatedDate || '',
            sentAt: log.sentAt || formatRunTimestamp(),
            error: log.error || ''
        });
    }

    async function refreshCurrentLc7Members(rows) {
        await currentLc7Sheet.clear();
        await currentLc7Sheet.setHeaderRow(CURRENT_LC7_HEADERS);
        if (rows.length === 0) return 0;
        await currentLc7Sheet.addRows(rows.map(row => ({
            memberId: row.memberId,
            memberName: row.memberName || '',
            memberEmail: row.memberEmail || '',
            latestLateCancellationAt: row.latestLateCancellationAt || '',
            lc7TagAssignedAt: row.lc7TagAssignedAt || '',
            p57EligibleAt: row.p57EligibleAt || '',
            status: row.status || '',
            comment: row.comment || '',
            refreshedAt: formatRunTimestamp()
        })));
        return rows.length;
    }

    return {
        appendRunLog,
        appendEmailLog,
        getCyclesByStatus,
        getEmailLogRows,
        getLifecycleRows,
        hasSentEmail,
        insertLifecycleRows,
        insertRawRows,
        refreshCurrentLc7Members,
        updateCycle
    };
}

module.exports = {
    createSheetsStore,
    LIFECYCLE_HEADERS,
    CURRENT_LC7_HEADERS,
    EMAIL_LOG_HEADERS,
    RAW_HEADERS,
    RUN_LOG_HEADERS
};
