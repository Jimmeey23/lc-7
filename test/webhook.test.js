const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { LIFECYCLE_STATUSES } = require('../src/config');
const { createEmailService } = require('../src/email-service');
const { formatIST } = require('../src/date-utils');
const { extractMembershipName } = require('../src/momence-v2');
const { dedupeCancellations, processLateCancellation, verifyWebhook } = require('../src/webhook');
const { createWebhookQueue, createWebhookServer } = require('../src/webhook-server');
const helpers = require('../src/run');

const SECRET = 'test-secret';
const NOW = new Date('2026-11-25T12:00:00Z');

function envelope(payload, event = 'session-booking-cancelled') {
    return JSON.stringify({ timestamp: NOW.toISOString(), event, payload });
}

function signedRequest(payloadString, { secret = SECRET, encoding = 'hex', requestId = 'req-1' } = {}) {
    return {
        rawBody: JSON.stringify({ payload: payloadString }),
        headers: {
            'x-webhook-secret': secret,
            'x-webhook-signature': crypto.createHmac('sha256', SECRET).update(payloadString).digest(encoding),
            'x-webhook-reqeuest-id': requestId
        }
    };
}

function latePayload(overrides = {}) {
    return {
        sessionBookingId: 900,
        sessionId: 50,
        payingMemberId: 100,
        targetMemberId: 100,
        isLateCancellation: true,
        cancelledAt: '2026-11-25T10:00:00Z',
        ...overrides
    };
}

function rawRow(memberId, cancelledAtIso, sessionAtIso, membershipName = 'Studio Annual Unlimited Membership') {
    return {
        rawId: crypto.randomUUID(),
        memberId: String(memberId),
        memberName: 'Member One',
        memberEmail: 'member@example.com',
        cancelledEvent: 'Barre',
        cancelledAt: formatIST(cancelledAtIso),
        sessionAt: formatIST(sessionAtIso),
        membershipName,
        homeLocation: '',
        createdAt: '',
        comment: ''
    };
}

function makeStore(rawRows = [], lifecycle = []) {
    const updates = [];
    const emailLog = [];
    return {
        rawRows,
        lifecycle,
        updates,
        emailLog,
        getRawRows: async () => rawRows,
        insertRawRows: async rows => {
            const ids = new Set(rawRows.map(row => row.rawId));
            const fresh = rows.filter(row => !ids.has(row.rawId));
            rawRows.push(...fresh);
            return fresh.length;
        },
        getLifecycleRows: async () => lifecycle,
        insertLifecycleRows: async cycles => {
            lifecycle.push(...cycles);
            return cycles.length;
        },
        updateCycle: async (cycleId, changes) => {
            updates.push({ cycleId, changes });
            const cycle = lifecycle.find(item => item.cycleId === cycleId);
            if (cycle) Object.assign(cycle, changes);
        },
        getEmailLogRows: async () => emailLog,
        appendEmailLog: async log => emailLog.push(log),
        appendRunLog: async () => {}
    };
}

function makeDeps(store, { booking, member, reportRecords = [] } = {}) {
    const calls = { assignLc7Tag: [], cancelFutureBookings: [], report: 0, mail: [] };
    const momence = {
        assignLc7Tag: async memberId => calls.assignLc7Tag.push(memberId),
        cancelFutureBookings: async memberId => {
            calls.cancelFutureBookings.push(memberId);
            return { total: 1, successful: 1, failed: [], bookingIds: [1] };
        },
        fetchLateCancellations: async () => {
            calls.report++;
            return reportRecords;
        }
    };
    const momenceV2 = {
        getMember: async () => member === undefined ? { id: 100, firstName: 'Member', lastName: 'One', email: 'member@example.com' } : member,
        findMemberBooking: async () => booking === undefined ? {
            id: 900,
            cancelledAt: '2026-11-25T10:00:00Z',
            session: { id: 50, name: 'Barre 57', startsAt: '2026-11-25T11:00:00Z' },
            boughtMembership: { membership: { name: 'Studio Annual Unlimited Membership' } }
        } : booking
    };
    const emailService = createEmailService({
        dryRun: false,
        mail: { apiUrl: 'https://example.test/send', apiToken: 't', from: 'a@b.c', fromName: 'X', replyTo: 'r@b.c' }
    }, { post: async (url, payload) => { calls.mail.push(payload); return { data: { success: true } }; } });
    return {
        calls,
        deps: { store, momence, momenceV2, emailService, config: { reportLookbackDays: 30, testMemberId: null }, helpers }
    };
}

const verifiedLate = (payload = latePayload()) => ({ ok: true, requestId: 'r', event: 'session-booking-cancelled', payload });

test('verifyWebhook accepts valid secret and hex or base64 signature', () => {
    const payloadString = envelope(latePayload());
    for (const encoding of ['hex', 'base64']) {
        const req = signedRequest(payloadString, { encoding });
        const result = verifyWebhook({ ...req, secret: SECRET, enforceSignature: true });
        assert.equal(result.ok, true);
        assert.equal(result.event, 'session-booking-cancelled');
        assert.equal(result.payload.targetMemberId, 100);
        assert.equal(result.requestId, 'req-1');
    }
});

test('verifyWebhook rejects wrong secret and, when enforced, a bad signature', () => {
    const payloadString = envelope(latePayload());
    const wrongSecret = signedRequest(payloadString, { secret: 'nope' });
    assert.equal(verifyWebhook({ ...wrongSecret, secret: SECRET }).status, 401);

    const badSig = signedRequest(payloadString);
    badSig.headers['x-webhook-signature'] = 'deadbeef';
    assert.equal(verifyWebhook({ ...badSig, secret: SECRET, enforceSignature: true }).status, 401);
    assert.equal(verifyWebhook({ ...badSig, secret: SECRET, enforceSignature: false }).ok, true);
});

test('extractMembershipName finds membership but never uses the session name', () => {
    assert.equal(extractMembershipName({ boughtMembership: { membership: { name: 'Unlimited' } } }), 'Unlimited');
    assert.equal(extractMembershipName({ membershipName: 'Annual Unlimited' }), 'Annual Unlimited');
    assert.equal(extractMembershipName({ paidWith: { type: 'membership', boughtMembership: { membership: { name: 'Pack' } } } }), 'Pack');
    assert.equal(extractMembershipName({ session: { name: 'Barre 57' } }), '');
    assert.equal(extractMembershipName(null), '');
});

test('third unlimited late cancellation within 7 days triggers LC-7, booking cancellation and email A', async () => {
    const store = makeStore([
        rawRow(100, '2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z'),
        rawRow(100, '2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z')
    ]);
    const { deps, calls } = makeDeps(store);

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.equal(result.outcome, 'LC7_TRIGGERED');
    assert.deepEqual(calls.assignLc7Tag, [100]);
    assert.deepEqual(calls.cancelFutureBookings, [100]);
    assert.equal(calls.mail.length, 1);
    assert.equal(store.lifecycle[0].status, LIFECYCLE_STATUSES.WAITING_7_DAYS);
    assert.equal(store.rawRows.length, 3);
    assert.equal(calls.report, 0, 'report fallback not needed when booking has membership');
});

test('second late cancellation stays below threshold and changes nothing in Momence', async () => {
    const store = makeStore([rawRow(100, '2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z')]);
    const { deps, calls } = makeDeps(store);

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.match(result.outcome, /^BELOW_THRESHOLD/);
    assert.deepEqual(calls.assignLc7Tag, []);
    assert.equal(store.lifecycle.length, 0);
});

test('late cancellation on a non-unlimited membership is stored but never counted', async () => {
    const store = makeStore([
        rawRow(100, '2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z'),
        rawRow(100, '2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z')
    ]);
    const { deps, calls } = makeDeps(store, {
        booking: { id: 900, session: { name: 'Barre', startsAt: '2026-11-25T11:00:00Z' }, boughtMembership: { membership: { name: '10 Class Pack' } } }
    });

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.equal(result.outcome, 'NOT_UNLIMITED_MEMBERSHIP');
    assert.deepEqual(calls.assignLc7Tag, []);
    assert.equal(store.rawRows.length, 3);
});

test('membership missing from booking falls back to the late-cancellation report', async () => {
    const store = makeStore([
        rawRow(100, '2026-11-21T09:00:00Z', '2026-11-21T10:00:00Z'),
        rawRow(100, '2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z')
    ]);
    const { deps, calls } = makeDeps(store, {
        booking: { id: 900, session: { name: 'Barre', startsAt: '2026-11-25T11:00:00Z' } },
        reportRecords: [{ memberId: 100, cancelledDate: '2026-11-25T10:00:30Z', sessionDate: '2026-11-25T11:00:00Z', membershipName: 'Studio Unlimited' }]
    });

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.equal(calls.report, 1);
    assert.equal(result.outcome, 'LC7_TRIGGERED');
});

test('unknown membership is stored and deferred to the scheduled run', async () => {
    const store = makeStore();
    const { deps, calls } = makeDeps(store, { booking: null });

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.equal(result.outcome, 'MEMBERSHIP_UNKNOWN_DEFERRED_TO_SCHEDULED_RUN');
    assert.equal(store.rawRows.length, 1);
    assert.deepEqual(calls.assignLc7Tag, []);
});

test('the same cancellation stored by both webhook and report is counted once', async () => {
    const store = makeStore([
        rawRow(100, '2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z'),
        rawRow(100, '2026-11-25T10:00:00Z', '2026-11-25T11:00:00Z') // report copy of this webhook's cancellation
    ]);
    const { deps, calls } = makeDeps(store);

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.match(result.outcome, /^BELOW_THRESHOLD \(2/);
    assert.deepEqual(calls.assignLc7Tag, []);
    assert.equal(dedupeCancellations([
        { memberId: 1, cancelledDate: '2026-11-25T10:00:00Z', sessionDate: '2026-11-25T11:00:00Z' },
        { memberId: 1, cancelledDate: '2026-11-25T10:00:20Z', sessionDate: '2026-11-25T11:00:00Z' }
    ]).length, 1);
});

test('member already waiting gets the 7-day clock reset instead of a new cycle', async () => {
    const store = makeStore([
        rawRow(100, '2026-11-23T09:00:00Z', '2026-11-23T10:00:00Z'),
        rawRow(100, '2026-11-24T09:00:00Z', '2026-11-24T10:00:00Z')
    ], [{
        cycleId: 'c1', memberId: '100', status: LIFECYCLE_STATUSES.WAITING_7_DAYS,
        latestLateCancellationAt: formatIST('2026-11-20T09:00:00Z'), p57EligibleAt: formatIST('2026-11-27T09:00:00Z')
    }]);
    const { deps, calls } = makeDeps(store);

    const result = await processLateCancellation(verifiedLate(), deps, NOW);

    assert.equal(result.outcome, 'WAITING_PERIOD_RESET');
    assert.equal(store.lifecycle.length, 1);
    assert.equal(store.lifecycle[0].p57EligibleAt, formatIST('2026-12-02T10:00:00Z'));
    assert.deepEqual(calls.assignLc7Tag, []);
});

test('HTTP server: ignores non-late events, queues late ones once, rejects bad secret', async () => {
    const logged = [];
    const queue = createWebhookQueue({
        // Context whose store records RunLog rows; member 0 makes processing exit early.
        createContext: async () => ({
            config: { testMemberId: null },
            store: { appendRunLog: async log => logged.push(log) }
        })
    });
    const server = createWebhookServer({ config: { webhook: { secret: SECRET, enforceSignature: true } }, queue });
    await new Promise(resolve => server.listen(0, resolve));
    const { port } = server.address();
    const post = async (req, path = '/webhooks/momence') => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: req.headers, body: req.rawBody });
        return { status: response.status, body: await response.json() };
    };

    try {
        const notLate = await post(signedRequest(envelope(latePayload({ isLateCancellation: false })), { requestId: 'a' }));
        assert.equal(notLate.status, 200);
        assert.equal(notLate.body.ignored, true);

        const late = await post(signedRequest(envelope(latePayload({ targetMemberId: 0, payingMemberId: 0 })), { requestId: 'b' }));
        assert.equal(late.body.queued, true);
        const duplicate = await post(signedRequest(envelope(latePayload({ targetMemberId: 0, payingMemberId: 0 })), { requestId: 'b' }));
        assert.equal(duplicate.body.duplicate, true);

        const rejected = await post(signedRequest(envelope(latePayload()), { secret: 'bad', requestId: 'c' }));
        assert.equal(rejected.status, 401);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 200);
        await queue.idle();
        assert.equal(logged.length, 1, 'duplicate request id processed once');
        assert.match(logged[0].message, /SKIPPED_NO_MEMBER/);
    } finally {
        server.close();
    }
});
