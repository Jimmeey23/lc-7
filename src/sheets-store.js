const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const { LIFECYCLE_STATUSES, MAX_AUTO_RETRIES } = require('./config');
const { formatRunTimestamp, parseDate } = require('./date-utils');

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
    'lc7TagAssignedAt',
    'futureBookingsCancelledCount',
    'p57EligibleAt',
    'p57TagAssignedAt',
    'status',
    'retryCount',
    'assignmentReason',
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
    'retriedCount',
    'missedAssignmentsDetected',
    'skippedRecords',
    'failedCount',
    'emailsSent',
    'emailsFailed',
    'failedMemberIds',
    'status',
    'message'
];

const ACTIVE_LC7_HEADERS = [
    'memberId',
    'memberName',
    'memberEmail',
    'latestLateCancellationAt',
    'lc7TagAssignedAt',
    'p57EligibleAt',
    'daysRemaining',
    'bookingsCancelled',
    'retryCount',
    'status',
    'assignmentReason',
    'failureReason',
    'refreshedAt'
];

const COMPLETED_LC7_HEADERS = [
    'cycleId',
    'memberId',
    'memberName',
    'memberEmail',
    'latestLateCancellationAt',
    'lc7TagAssignedAt',
    'p57TagAssignedAt',
    'durationDays',
    'bookingsCancelled',
    'assignmentReason',
    'completedAt'
];

const AT_RISK_HEADERS = [
    'memberId',
    'memberName',
    'memberEmail',
    'cancellationsInWindow',
    'oldestCancellationInWindow',
    'latestCancellationAt',
    'windowExpiresAt',
    'membershipName',
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

// backward compat alias — code that imported CURRENT_LC7_HEADERS still works
const CURRENT_LC7_HEADERS = ACTIVE_LC7_HEADERS;

function rowToObject(row, headers) {
    const object = {};
    for (const header of headers) object[header] = row.get(header) || '';
    return object;
}

function headersMatchExactly(currentHeaders, expectedHeaders) {
    if (!Array.isArray(currentHeaders) || currentHeaders.length !== expectedHeaders.length) return false;
    return expectedHeaders.every((header, index) => currentHeaders[index] === header);
}

function mapRowForHeaders(row, headers, sheetTitle) {
    const newRow = {};
    for (const header of headers) newRow[header] = row.get(header) || '';

    if (sheetTitle === 'LC7Lifecycle' && headers.includes('assignmentReason') && !newRow.assignmentReason) {
        const triggerWindowDates = row.get('triggerWindowDates') || '';
        if (triggerWindowDates) {
            newRow.assignmentReason = `Migrated legacy trigger window: ${triggerWindowDates}`;
        }
    }

    return newRow;
}

function looksLikeStatus(value) {
    return Object.values(LIFECYCLE_STATUSES).includes(String(value || ''));
}

function repairShiftedLifecycleValues(rawData) {
    if (!Array.isArray(rawData) || rawData.length < LIFECYCLE_HEADERS.length) return null;
    if (!looksLikeStatus(rawData[12]) || looksLikeStatus(rawData[9])) return null;

    const triggerWindowDates = rawData[5] || '';
    return {
        cycleId: rawData[0] || '',
        memberId: rawData[1] || '',
        memberName: rawData[2] || '',
        memberEmail: rawData[3] || '',
        latestLateCancellationAt: rawData[4] || '',
        lc7TagAssignedAt: rawData[7] || '',
        futureBookingsCancelledCount: rawData[9] || '',
        p57EligibleAt: rawData[10] || '',
        p57TagAssignedAt: rawData[11] || '',
        status: rawData[12] || '',
        retryCount: 0,
        assignmentReason: triggerWindowDates ? `Migrated legacy trigger window: ${triggerWindowDates}` : '',
        lastError: rawData[13] || '',
        actionComment: rawData[14] || ''
    };
}

async function repairLifecycleRows(sheet) {
    const rows = await sheet.getRows();
    let repaired = 0;

    for (const row of rows) {
        const values = repairShiftedLifecycleValues(row._rawData || []);
        if (!values) continue;

        for (const [key, value] of Object.entries(values)) row.set(key, value);
        row.set('updatedAt', formatRunTimestamp());
        await row.save();
        repaired++;
    }

    return repaired;
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
    if (headersMatchExactly(currentHeaders, headers)) return sheet;

    const rows = await sheet.getRows();
    const migratedRows = rows.map(row => mapRowForHeaders(row, headers, title));

    // Back up the tab before clearing so a failed rewrite (quota/network) cannot lose data.
    let backup = null;
    if (rows.length > 0) {
        backup = await sheet.duplicate({ title: `${title}_backup_${Date.now()}` });
    }

    await sheet.clear();
    await sheet.setHeaderRow(headers);
    if (migratedRows.length > 0) {
        await sheet.addRows(migratedRows);
    }

    if (backup) {
        try {
            await backup.delete();
        } catch (error) {
            console.warn(`Header migration for ${title} succeeded but backup tab ${backup.title} could not be removed: ${error.message}`);
        }
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

    // Migrate old CurrentLC7Members tab name to ActiveLC7
    const oldCurrentSheet = doc.sheetsByTitle['CurrentLC7Members'];
    if (oldCurrentSheet && !doc.sheetsByTitle['ActiveLC7']) {
        await oldCurrentSheet.updateProperties({ title: 'ActiveLC7' });
        await doc.loadInfo();
    }

    const rawSheet = await ensureSheet(doc, 'LateCancellationsRaw', RAW_HEADERS);
    const lifecycleSheet = await ensureSheet(doc, 'LC7Lifecycle', LIFECYCLE_HEADERS);
    const runLogSheet = await ensureSheet(doc, 'RunLog', RUN_LOG_HEADERS);
    const activeLC7Sheet = await ensureSheet(doc, 'ActiveLC7', ACTIVE_LC7_HEADERS);
    const emailLogSheet = await ensureSheet(doc, 'EmailLog', EMAIL_LOG_HEADERS);
    const completedLC7Sheet = await ensureSheet(doc, 'CompletedLC7', COMPLETED_LC7_HEADERS);
    const atRiskSheet = await ensureSheet(doc, 'AtRisk', AT_RISK_HEADERS);
    const repairedLifecycleRows = await repairLifecycleRows(lifecycleSheet);
    if (repairedLifecycleRows > 0) {
        console.log(`Repaired ${repairedLifecycleRows} shifted LC7Lifecycle row(s)`);
    }

    async function getRawRows() {
        return (await rawSheet.getRows()).map(row => rowToObject(row, RAW_HEADERS));
    }

    // Read only the rawId column (column A) for dedup instead of every column of every
    // row. The raw tab grows forever, so this keeps each run's read small and fast.
    async function getExistingRawIds() {
        try {
            const values = await rawSheet.getCellsInRange('A2:A');
            return new Set((values || []).map(row => (row && row[0]) || '').filter(Boolean));
        } catch (error) {
            console.warn(`Raw ID column read failed, falling back to full read: ${error.message}`);
            return new Set((await getRawRows()).map(row => row.rawId));
        }
    }

    async function insertRawRows(rawRows) {
        if (rawRows.length === 0) return 0;
        const existing = await getExistingRawIds();
        const rowsToInsert = rawRows.filter(row => !existing.has(row.rawId));
        if (rowsToInsert.length > 0) await rawSheet.addRows(rowsToInsert);
        return rowsToInsert.length;
    }

    // Lifecycle rows are loaded once per run (a store is created per run) and kept in
    // sync locally on every insert/update. This avoids re-reading the whole sheet on
    // every updateCycle call, which exhausted the Google Sheets read quota.
    let lifecycleRowCache = null;

    async function loadLifecycleSheetRows() {
        if (!lifecycleRowCache) lifecycleRowCache = await lifecycleSheet.getRows();
        return lifecycleRowCache;
    }

    async function findLifecycleRow(cycleId) {
        const rows = await loadLifecycleSheetRows();
        const row = rows.find(item => item.get('cycleId') === cycleId);
        if (!row) throw new Error(`Lifecycle cycle not found: ${cycleId}`);
        return row;
    }

    async function getLifecycleRows() {
        return (await loadLifecycleSheetRows()).map(row => rowToObject(row, LIFECYCLE_HEADERS));
    }

    async function getMemberIdsWithAnyCycle() {
        const rows = await getLifecycleRows();
        return new Set(rows.map(row => Number(row.memberId)).filter(Boolean));
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
                lc7TagAssignedAt: cycle.lc7TagAssignedAt || '',
                futureBookingsCancelledCount: cycle.futureBookingsCancelledCount || '',
                p57EligibleAt: cycle.p57EligibleAt,
                p57TagAssignedAt: cycle.p57TagAssignedAt || '',
                status: cycle.status || LIFECYCLE_STATUSES.DETECTED,
                retryCount: cycle.retryCount || 0,
                assignmentReason: cycle.assignmentReason || '',
                lastError: cycle.lastError || '',
                actionComment: cycle.actionComment || '',
                updatedAt: formatRunTimestamp()
            }));
        if (rows.length > 0) {
            const added = await lifecycleSheet.addRows(rows);
            if (lifecycleRowCache && Array.isArray(added) && added.length === rows.length) {
                lifecycleRowCache.push(...added);
            } else {
                lifecycleRowCache = null;
            }
        }
        return rows.length;
    }

    async function updateCycle(cycleId, changes) {
        const row = await findLifecycleRow(cycleId);
        for (const [key, value] of Object.entries(changes)) row.set(key, value ?? '');
        row.set('updatedAt', formatRunTimestamp());
        await row.save();
    }

    async function getCyclesByStatus(status) {
        return (await getLifecycleRows()).filter(row => row.status === status);
    }

    async function getRetryableCycles() {
        const rows = await getLifecycleRows();
        return rows.filter(row =>
            row.status === LIFECYCLE_STATUSES.FAILED &&
            Number(row.retryCount || 0) < MAX_AUTO_RETRIES
        );
    }

    async function incrementRetryCount(cycleId) {
        const row = await findLifecycleRow(cycleId);
        const current = Number(row.get('retryCount') || 0);
        row.set('retryCount', current + 1);
        row.set('updatedAt', formatRunTimestamp());
        await row.save();
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
            retriedCount: log.retriedCount || 0,
            missedAssignmentsDetected: log.missedAssignmentsDetected || 0,
            skippedRecords: log.skippedRecords || 0,
            failedCount: log.failedCount || 0,
            emailsSent: log.emailsSent || 0,
            emailsFailed: log.emailsFailed || 0,
            failedMemberIds: log.failedMemberIds || '',
            status: log.status || 'COMPLETED',
            message: log.message || ''
        });
    }

    async function getEmailLogRows() {
        return (await emailLogSheet.getRows()).map(row => rowToObject(row, EMAIL_LOG_HEADERS));
    }

    async function hasSentEmail(emailId) {
        if (!emailId) return false;
        const rows = await getEmailLogRows();
        return rows.some(row => row.emailId === emailId && row.status === 'SENT');
    }

    async function getFailedEmailRows() {
        const rows = await getEmailLogRows();
        const sent = new Set(rows.filter(row => row.status === 'SENT').map(row => row.emailId));
        return rows.filter(row => row.status === 'FAILED' && !sent.has(row.emailId));
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

    async function appendCompletedCycle(cycle) {
        const lc7Date = parseDate(cycle.lc7TagAssignedAt);
        const p57Date = parseDate(cycle.p57TagAssignedAt);
        const durationDays = lc7Date && p57Date
            ? Math.round((p57Date.getTime() - lc7Date.getTime()) / (1000 * 60 * 60 * 24))
            : '';
        await completedLC7Sheet.addRow({
            cycleId: cycle.cycleId || '',
            memberId: cycle.memberId || '',
            memberName: cycle.memberName || '',
            memberEmail: cycle.memberEmail || '',
            latestLateCancellationAt: cycle.latestLateCancellationAt || '',
            lc7TagAssignedAt: cycle.lc7TagAssignedAt || '',
            p57TagAssignedAt: cycle.p57TagAssignedAt || '',
            durationDays,
            bookingsCancelled: cycle.futureBookingsCancelledCount || 0,
            assignmentReason: cycle.assignmentReason || '',
            completedAt: formatRunTimestamp()
        });
    }

    // Rewrite a dashboard tab only when its content changed. refreshedAt therefore
    // means "last changed at". Header row is kept (ensureSheet validates it each run).
    async function replaceDashboardRows(sheet, headers, newRows) {
        const comparable = row => headers
            .filter(header => header !== 'refreshedAt')
            .map(header => String(row[header] ?? ''))
            .join('\u0001');

        const existingRows = (await sheet.getRows()).map(row => rowToObject(row, headers));
        const unchanged = existingRows.length === newRows.length &&
            existingRows.every((row, index) => comparable(row) === comparable(newRows[index]));
        if (unchanged) return false;

        await sheet.clearRows();
        if (newRows.length > 0) await sheet.addRows(newRows);
        return true;
    }

    async function refreshActiveLC7(rows) {
        const now = new Date();
        const refreshedAt = formatRunTimestamp();
        const newRows = rows.map(row => {
            const p57Date = parseDate(row.p57EligibleAt);
            const daysRemaining = p57Date
                ? Math.max(0, Math.ceil((p57Date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
                : '';
            return {
                memberId: row.memberId,
                memberName: row.memberName || '',
                memberEmail: row.memberEmail || '',
                latestLateCancellationAt: row.latestLateCancellationAt || '',
                lc7TagAssignedAt: row.lc7TagAssignedAt || '',
                p57EligibleAt: row.p57EligibleAt || '',
                daysRemaining,
                bookingsCancelled: row.futureBookingsCancelledCount || row.bookingsCancelled || '',
                retryCount: row.retryCount || 0,
                status: row.status || '',
                assignmentReason: row.assignmentReason || '',
                failureReason: row.lastError || '',
                refreshedAt
            };
        });
        await replaceDashboardRows(activeLC7Sheet, ACTIVE_LC7_HEADERS, newRows);
        return rows.length;
    }

    // kept for backward compat — callers in run.js were updated to use refreshActiveLC7
    const refreshCurrentLc7Members = refreshActiveLC7;

    async function refreshAtRiskSheet(rows) {
        const refreshedAt = formatRunTimestamp();
        await replaceDashboardRows(atRiskSheet, AT_RISK_HEADERS, rows.map(row => ({ ...row, refreshedAt })));
        return rows.length;
    }

    // Dashboard helpers. The store is long-lived there, so it must drop its per-run
    // lifecycle cache before reading or writing fresh state.
    function resetCache() {
        lifecycleRowCache = null;
    }

    async function getRunLogRows() {
        return (await runLogSheet.getRows()).map(row => rowToObject(row, RUN_LOG_HEADERS));
    }

    async function getAtRiskRows() {
        return (await atRiskSheet.getRows()).map(row => rowToObject(row, AT_RISK_HEADERS));
    }

    async function getCompletedRows() {
        return (await completedLC7Sheet.getRows()).map(row => rowToObject(row, COMPLETED_LC7_HEADERS));
    }

    return {
        resetCache,
        getRunLogRows,
        getAtRiskRows,
        getCompletedRows,
        appendCompletedCycle,
        appendEmailLog,
        appendRunLog,
        getCyclesByStatus,
        getEmailLogRows,
        getFailedEmailRows,
        getLifecycleRows,
        getMemberIdsWithAnyCycle,
        getRawRows,
        getRetryableCycles,
        hasSentEmail,
        incrementRetryCount,
        insertLifecycleRows,
        insertRawRows,
        refreshActiveLC7,
        refreshAtRiskSheet,
        refreshCurrentLc7Members,
        updateCycle
    };
}

module.exports = {
    createSheetsStore,
    ACTIVE_LC7_HEADERS,
    AT_RISK_HEADERS,
    COMPLETED_LC7_HEADERS,
    CURRENT_LC7_HEADERS,
    EMAIL_LOG_HEADERS,
    LIFECYCLE_HEADERS,
    RAW_HEADERS,
    headersMatchExactly,
    repairShiftedLifecycleValues,
    RUN_LOG_HEADERS
};
