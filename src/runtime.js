const crypto = require('crypto');
const { LIFECYCLE_STATUSES } = require('./config');
const { formatIST, parseDate } = require('./date-utils');
const { SILENT_MARKER, createEmailService } = require('./email-service');
const { createMomenceClient } = require('./momence-client');
const { createMomenceV2Client } = require('./momence-v2');
const { createSheetsStore } = require('./sheets-store');
const { withLock } = require('./lock');
const { emitEvent, withLogContext } = require('./log-bus');
const { configForLocation, describeLocation } = require('./locations');
const helpers = require('./run');

const ACTIVE_STATUSES = new Set([
    LIFECYCLE_STATUSES.DETECTED,
    LIFECYCLE_STATUSES.LC7_TAG_ASSIGNED,
    LIFECYCLE_STATUSES.FUTURE_BOOKINGS_CANCELLED,
    LIFECYCLE_STATUSES.WAITING_7_DAYS,
    LIFECYCLE_STATUSES.FAILED,
    LIFECYCLE_STATUSES.RETRY_PENDING
]);
const SNAPSHOT_TTL_MS = Number(process.env.DASHBOARD_CACHE_MS) || 20 * 1000;

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

// One runtime per process. Holds per-location clients, run state and a short-lived
// read cache so the dashboard does not exhaust the Google Sheets read quota.
function createRuntime({ registry, runFn = helpers.run }) {
    const contexts = new Map();
    const snapshots = new Map();
    const state = new Map(); // locationId -> { running, lastRunAt, lastRunStatus, lastError }

    function locationState(id) {
        if (!state.has(id)) state.set(id, { running: false, lastRunAt: null, lastRunStatus: null, lastError: null });
        return state.get(id);
    }

    async function resolveLocation(id) {
        const location = await registry.get(id);
        if (!location) throw httpError(404, `Unknown location: ${id}`);
        return location;
    }

    // Clients for one location, created once. Throws if the location's secrets are missing.
    async function context(id) {
        const location = await resolveLocation(id);
        const config = configForLocation(location);
        const key = `${id}|${location.updatedAt || ''}`;
        const cached = contexts.get(id);
        if (cached && cached.key === key) return cached;
        const ctx = {
            key,
            location,
            config,
            store: null,
            momence: createMomenceClient(config),
            momenceV2: createMomenceV2Client(config),
            emailService: createEmailService(config),
            helpers
        };
        contexts.set(id, ctx);
        return ctx;
    }

    async function storeFor(ctx) {
        if (!ctx.store) ctx.store = await createSheetsStore(ctx.config);
        ctx.store.resetCache();
        return ctx.store;
    }

    function invalidate(id) {
        snapshots.delete(id);
        emitEvent('changed', { location: id });
    }

    // Serialised work for a location, tagged in the live log.
    function locked(id, source, fn) {
        return withLock(() => withLogContext({ location: id, source }, fn));
    }

    async function runLocation(id, source = 'manual') {
        const st = locationState(id);
        if (st.running) throw httpError(409, 'A run is already in progress for this location.');
        const ctx = await context(id);
        st.running = true;
        emitEvent('run', { location: id, running: true });
        try {
            await locked(id, source, () => runFn(ctx.config));
            st.lastRunStatus = 'COMPLETED';
            st.lastError = null;
        } catch (error) {
            st.lastRunStatus = 'FAILED';
            st.lastError = error.message;
            throw error;
        } finally {
            st.running = false;
            st.lastRunAt = new Date().toISOString();
            invalidate(id);
            emitEvent('run', { location: id, running: false, status: st.lastRunStatus });
        }
    }

    async function runAllEnabled(source = 'schedule') {
        const locations = await registry.list(true).catch(error => {
            console.error(`Could not load Locations tab, running primary location only: ${error.message}`);
            return registry.list().catch(() => [{ id: 'default', enabled: true }]);
        });
        for (const location of locations.filter(item => item.enabled !== false)) {
            try {
                await runLocation(location.id, source);
            } catch (error) {
                console.error(`Scheduled run failed for ${location.id}: ${error.message}`);
            }
        }
    }

    async function snapshot(id, force = false) {
        const cached = snapshots.get(id);
        if (!force && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;
        const ctx = await context(id);
        const store = await storeFor(ctx);
        const [cycles, runLog, atRisk, emailLog] = await Promise.all([
            store.getLifecycleRows(),
            store.getRunLogRows(),
            store.getAtRiskRows(),
            store.getEmailLogRows()
        ]);
        const data = { cycles, runLog, atRisk, emailLog, loadedAt: new Date().toISOString() };
        snapshots.set(id, { at: Date.now(), data });
        return data;
    }

    async function overview(id) {
        const location = describeLocation(await resolveLocation(id));
        let data = null;
        let error = null;
        try {
            data = await snapshot(id);
        } catch (err) {
            error = err.message;
        }
        const st = locationState(id);
        if (!data) return { location, state: st, error };

        const now = Date.now();
        const weekAgo = now - 7 * 86400000;
        const cycles = data.cycles;
        const active = cycles.filter(cycle => ACTIVE_STATUSES.has(cycle.status) && cycle.status !== LIFECYCLE_STATUSES.FAILED);
        const failed = cycles.filter(cycle => cycle.status === LIFECYCLE_STATUSES.FAILED);
        const restoredThisWeek = cycles.filter(cycle => {
            const at = parseDate(cycle.p57TagAssignedAt);
            return cycle.status === LIFECYCLE_STATUSES.P57_TAG_ASSIGNED && at && at.getTime() >= weekAgo;
        });
        const startedThisWeek = cycles.filter(cycle => {
            const at = parseDate(cycle.lc7TagAssignedAt);
            return at && at.getTime() >= weekAgo;
        });
        const dueSoon = active
            .map(cycle => ({ cycle, at: parseDate(cycle.p57EligibleAt) }))
            .filter(item => item.at && item.at.getTime() - now < 86400000)
            .map(item => item.cycle);

        return {
            location,
            state: st,
            loadedAt: data.loadedAt,
            counts: {
                active: active.length,
                failed: failed.length,
                atRisk: data.atRisk.length,
                restoredThisWeek: restoredThisWeek.length,
                startedThisWeek: startedThisWeek.length,
                dueSoon: dueSoon.length,
                total: cycles.length
            },
            recentRuns: data.runLog.slice(-25).reverse(),
            emailStats: {
                sent: data.emailLog.filter(row => row.status === 'SENT').length,
                failed: data.emailLog.filter(row => row.status === 'FAILED').length
            }
        };
    }

    function sortByDateDesc(rows, field) {
        return [...rows].sort((a, b) => (parseDate(b[field])?.getTime() || 0) - (parseDate(a[field])?.getTime() || 0));
    }

    async function members(id, { status = 'active', q = '' } = {}) {
        const data = await snapshot(id);
        let rows = data.cycles;
        if (status === 'active') rows = rows.filter(cycle => ACTIVE_STATUSES.has(cycle.status));
        else if (status !== 'all') rows = rows.filter(cycle => cycle.status === status);
        const needle = q.trim().toLowerCase();
        if (needle) {
            rows = rows.filter(cycle => [cycle.memberId, cycle.memberName, cycle.memberEmail]
                .some(value => String(value || '').toLowerCase().includes(needle)));
        }
        return { rows: sortByDateDesc(rows, 'updatedAt'), loadedAt: data.loadedAt };
    }

    async function atRisk(id) {
        const data = await snapshot(id);
        return { rows: data.atRisk, loadedAt: data.loadedAt };
    }

    async function logs(id, kind) {
        const data = await snapshot(id);
        if (kind === 'runs') return { rows: data.runLog.slice(-200).reverse(), loadedAt: data.loadedAt };
        if (kind === 'emails') return { rows: data.emailLog.slice(-300).reverse(), loadedAt: data.loadedAt };
        throw httpError(400, 'Unknown log type');
    }

    async function findCycle(store, cycleId) {
        const cycle = (await store.getLifecycleRows()).find(row => row.cycleId === cycleId);
        if (!cycle) throw httpError(404, 'Cycle not found');
        return cycle;
    }

    // End an LC-7 block now: LC-7 off, P57 on, status P57_TAG_ASSIGNED, email B
    // (unless silent). Uses the same OVERRIDE processing as the hourly run.
    async function endBlock(id, cycleId, { silent = false, note = '' } = {}) {
        const ctx = await context(id);
        const result = await locked(id, 'dashboard', async () => {
            const store = await storeFor(ctx);
            const cycle = await findCycle(store, cycleId);
            if (!ACTIVE_STATUSES.has(cycle.status) && cycle.status !== LIFECYCLE_STATUSES.OVERRIDE) {
                throw httpError(400, `This cycle is ${cycle.status}; there is no active block to end.`);
            }
            const reason = [cycle.assignmentReason, `Ended from dashboard${note ? `: ${note}` : ''}`, silent ? SILENT_MARKER : '']
                .filter(Boolean).join(' | ');
            await store.updateCycle(cycleId, { status: LIFECYCLE_STATUSES.OVERRIDE, assignmentReason: reason });
            console.log(`🧯 Dashboard: ending LC-7 block for member ${cycle.memberId} (${cycle.memberName || ''})`);
            const outcome = await helpers.processOverrideCycles(store, ctx.momence, [{ ...cycle, status: LIFECYCLE_STATUSES.OVERRIDE, assignmentReason: reason }]);
            if (outcome.failedCount > 0) throw httpError(502, 'Momence tag update failed; the cycle stays in OVERRIDE and the next run will retry.');
            for (const done of outcome.overriddenCycles) await store.appendCompletedCycle(done);
            const emails = silent ? { sent: 0, failed: 0 } : await helpers.sendLifecycleEmails(store, ctx.emailService, outcome.overriddenCycles, 'B');
            console.log(`✅ Dashboard: member ${cycle.memberId} restored to P57${silent ? ' (no email)' : `, ${emails.sent} email(s) sent`}`);
            return { ok: true, emailsSent: emails.sent };
        });
        invalidate(id);
        return result;
    }

    async function changeEndDate(id, cycleId, endsAt) {
        const date = new Date(endsAt);
        if (Number.isNaN(date.getTime())) throw httpError(400, 'Invalid date');
        if (date.getTime() < Date.now() - 60000) throw httpError(400, 'The new end date is in the past. Use "End block now" instead.');
        const ctx = await context(id);
        await locked(id, 'dashboard', async () => {
            const store = await storeFor(ctx);
            const cycle = await findCycle(store, cycleId);
            if (cycle.status !== LIFECYCLE_STATUSES.WAITING_7_DAYS) throw httpError(400, 'Only members currently serving LC-7 can have their end date changed.');
            await store.updateCycle(cycleId, {
                p57EligibleAt: formatIST(date),
                actionComment: `${cycle.actionComment || ''} End date changed from dashboard to ${formatIST(date)}.`.trim()
            });
            console.log(`🗓️ Dashboard: member ${cycle.memberId} block now ends ${formatIST(date)}`);
        });
        invalidate(id);
        return { ok: true };
    }

    // Manually put a member on LC-7 (same steps as an automatic trigger).
    async function blockMember(id, input) {
        const memberId = Number(input.memberId);
        if (!Number.isInteger(memberId) || memberId <= 0) throw httpError(400, 'Enter a valid Momence member ID.');
        const days = Number(input.days || 7);
        if (!(days >= 1 && days <= 60)) throw httpError(400, 'Block length must be between 1 and 60 days.');
        const silent = Boolean(input.silent);
        const cancelBookings = input.cancelBookings !== false;
        const reasonText = String(input.reason || '').trim().slice(0, 300);
        const ctx = await context(id);

        const result = await locked(id, 'dashboard', async () => {
            const store = await storeFor(ctx);
            const existing = (await store.getLifecycleRows())
                .find(cycle => Number(cycle.memberId) === memberId && ACTIVE_STATUSES.has(cycle.status));
            if (existing) throw httpError(409, `Member ${memberId} already has an active LC-7 cycle (${existing.status}).`);

            let member = null;
            try {
                member = await ctx.momenceV2.getMember(memberId);
            } catch (error) {
                console.warn(`Dashboard: member lookup for ${memberId} failed: ${error.response?.status || error.message}`);
            }
            const memberName = [member?.firstName, member?.lastName].filter(Boolean).join(' ') || String(input.memberName || '').trim();
            const memberEmail = member?.email || String(input.memberEmail || '').trim();
            if (!member && !memberName) throw httpError(400, 'Could not look up this member in Momence. Enter their name and email to continue.');

            const now = new Date();
            const endsAt = new Date(now.getTime() + days * 86400000);
            const cycle = {
                cycleId: crypto.createHash('sha1').update(['manual', memberId, now.toISOString()].join('|')).digest('hex'),
                memberId,
                memberName,
                memberEmail,
                latestLateCancellationAt: formatIST(now),
                p57EligibleAt: formatIST(endsAt),
                status: LIFECYCLE_STATUSES.DETECTED,
                assignmentReason: `Manual block via dashboard${reasonText ? `: ${reasonText}` : ''}${silent ? ` ${SILENT_MARKER}` : ''}`,
                actionComment: `Manual LC-7 block for ${days} day(s) created from dashboard.`
            };
            console.log(`⛔ Dashboard: manually blocking member ${memberId} (${memberName}) for ${days} day(s)`);
            await store.insertLifecycleRows([cycle]);
            const { assigned, failedCount } = await helpers.assignLc7ForNewCycles(store, ctx.momence, [cycle]);
            if (failedCount > 0 || assigned.length === 0) throw httpError(502, 'LC-7 tag could not be added in Momence. The cycle is marked FAILED and will be retried by the next run.');

            let ready = assigned;
            let bookingsCancelled = 0;
            if (cancelBookings) {
                const cancelled = await helpers.cancelBookingsForAssignedCycles(store, ctx.momence, assigned);
                ready = cancelled.completedCycles;
                bookingsCancelled = cancelled.totalCancelled;
            } else {
                await store.updateCycle(cycle.cycleId, {
                    status: LIFECYCLE_STATUSES.WAITING_7_DAYS,
                    futureBookingsCancelledCount: 0,
                    actionComment: `${cycle.actionComment} Future bookings were kept.`
                });
                ready = assigned.map(item => ({ ...item, status: LIFECYCLE_STATUSES.WAITING_7_DAYS }));
            }
            const emails = silent ? { sent: 0 } : await helpers.sendLifecycleEmails(store, ctx.emailService, ready, 'A');
            console.log(`✅ Dashboard: member ${memberId} is on LC-7 until ${formatIST(endsAt)}; ${bookingsCancelled} booking(s) cancelled; ${emails.sent} email(s) sent`);
            return { ok: true, cycleId: cycle.cycleId, bookingsCancelled, emailsSent: emails.sent, endsAt: formatIST(endsAt) };
        });
        invalidate(id);
        return result;
    }

    async function retryCycle(id, cycleId) {
        const ctx = await context(id);
        await locked(id, 'dashboard', async () => {
            const store = await storeFor(ctx);
            const cycle = await findCycle(store, cycleId);
            if (cycle.status !== LIFECYCLE_STATUSES.FAILED) throw httpError(400, 'Only FAILED cycles can be retried.');
            await store.updateCycle(cycleId, { retryCount: 0 });
            await helpers.retryFailedCycles(store, ctx.momence);
        });
        invalidate(id);
        return { ok: true };
    }

    async function lookupMember(id, memberId) {
        const ctx = await context(id);
        const member = await ctx.momenceV2.getMember(Number(memberId));
        return {
            memberId: Number(memberId),
            name: [member?.firstName, member?.lastName].filter(Boolean).join(' '),
            email: member?.email || ''
        };
    }

    async function checkLocation(id) {
        const location = await resolveLocation(id);
        const described = describeLocation(location);
        const checks = [];
        let config = null;
        try {
            config = configForLocation(location);
            checks.push({ name: 'Settings & secrets', ok: true });
        } catch (error) {
            checks.push({ name: 'Settings & secrets', ok: false, detail: error.message });
        }
        if (config) {
            try {
                await createSheetsStore(config);
                checks.push({ name: 'Google Sheet (tabs created if missing)', ok: true });
            } catch (error) {
                checks.push({ name: 'Google Sheet', ok: false, detail: error.message });
            }
            try {
                await createMomenceClient(config).fetchLc7Members();
                checks.push({ name: 'Momence connection (LC-7 tag members)', ok: true });
            } catch (error) {
                checks.push({ name: 'Momence connection', ok: false, detail: error.response?.status ? `HTTP ${error.response.status}` : error.message });
            }
            checks.push({
                name: 'Webhook secret',
                ok: Boolean(config.webhook.secret),
                detail: config.webhook.secret ? '' : `Set ${location.envPrefix || ''}MOMENCE_WEBHOOK_SECRET to enable real-time processing (hourly runs still work).`
            });
        }
        contexts.delete(id);
        invalidate(id);
        return { location: described, checks };
    }

    return {
        atRisk,
        blockMember,
        changeEndDate,
        checkLocation,
        context,
        endBlock,
        invalidate,
        locationState,
        logs,
        lookupMember,
        members,
        overview,
        retryCycle,
        runAllEnabled,
        runLocation,
        state
    };
}

module.exports = { ACTIVE_STATUSES, createRuntime };
