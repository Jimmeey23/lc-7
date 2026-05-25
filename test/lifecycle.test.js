const test = require('node:test');
const assert = require('node:assert/strict');
const { LIFECYCLE_STATUSES } = require('../src/config');
const { formatIST, parseDate } = require('../src/date-utils');
const {
    buildP57TagPayload,
    findTriggeringMembers,
    findLatestTriggerAfter,
    getMostRecentLateCancellationDate,
    shouldTransitionToP57
} = require('../src/lifecycle');

function cancellation(memberId, cancelledDate, membershipName = 'Studio Annual Unlimited Membership') {
    return {
        memberId,
        customerName: 'Member',
        customerEmail: 'member@example.com',
        cancelledDate,
        sessionDate: cancelledDate,
        membershipName
    };
}

test('findTriggeringMembers creates one lifecycle cycle for three unlimited cancellations in seven days', () => {
    const detections = findTriggeringMembers([
        cancellation(100, '2026-05-19T00:00:00.000Z'),
        cancellation(100, '2026-05-20T00:00:00.000Z'),
        cancellation(100, '2026-05-22T00:00:00.000Z')
    ], [], new Date('2026-05-25T01:00:00.000Z'));

    assert.equal(detections.length, 1);
    assert.equal(detections[0].memberId, 100);
    assert.equal(detections[0].status, LIFECYCLE_STATUSES.DETECTED);
    assert.equal(detections[0].latestLateCancellationAt, '22-05-2026 05:30:00');
    assert.match(detections[0].actionComment, /LC-7 initiated/);
});

test('findTriggeringMembers ignores non-unlimited memberships and existing cycles', () => {
    const existing = findTriggeringMembers([
        cancellation(100, '2026-05-19T00:00:00.000Z'),
        cancellation(100, '2026-05-20T00:00:00.000Z'),
        cancellation(100, '2026-05-22T00:00:00.000Z')
    ], [], new Date('2026-05-25T01:00:00.000Z'));

    const detections = findTriggeringMembers([
        cancellation(100, '2026-05-19T00:00:00.000Z'),
        cancellation(100, '2026-05-20T00:00:00.000Z'),
        cancellation(100, '2026-05-22T00:00:00.000Z'),
        cancellation(200, '2026-05-19T00:00:00.000Z', 'Studio 10 Pack'),
        cancellation(200, '2026-05-20T00:00:00.000Z', 'Studio 10 Pack'),
        cancellation(200, '2026-05-22T00:00:00.000Z', 'Studio 10 Pack')
    ], existing, new Date('2026-05-25T00:00:00.000Z'));

    assert.equal(detections.length, 0);
});

test('findTriggeringMembers ignores historical windows before the May 18 IST cutoff', () => {
    const detections = findTriggeringMembers([
        cancellation(100, '2026-05-10T00:00:00.000Z'),
        cancellation(100, '2026-05-12T00:00:00.000Z'),
        cancellation(100, '2026-05-14T00:00:00.000Z')
    ], [], new Date('2026-05-25T00:00:00.000Z'));

    assert.equal(detections.length, 0);
});

test('findTriggeringMembers can qualify when the third cancellation is on the May 18 IST cutoff', () => {
    const detections = findTriggeringMembers([
        cancellation(100, '2026-05-12T18:30:00.000Z'),
        cancellation(100, '2026-05-15T00:00:00.000Z'),
        cancellation(100, '2026-05-17T18:30:00.000Z')
    ], [], new Date('2026-05-25T00:00:00.000Z'));

    assert.equal(detections.length, 1);
    assert.equal(detections[0].latestLateCancellationAt, '18-05-2026 00:00:00');
});

test('findTriggeringMembers uses the third cancellation date even when later cancellations exist', () => {
    const detections = findTriggeringMembers([
        cancellation(100, '2026-05-19T00:00:00.000Z'),
        cancellation(100, '2026-05-20T00:00:00.000Z'),
        cancellation(100, '2026-05-22T00:00:00.000Z'),
        cancellation(100, '2026-05-24T00:00:00.000Z')
    ], [], new Date('2026-05-25T00:00:00.000Z'));

    assert.equal(detections.length, 1);
    assert.equal(detections[0].latestLateCancellationAt, '22-05-2026 05:30:00');
    assert.equal(detections[0].p57EligibleAt, '29-05-2026 05:30:00');
});

test('findLatestTriggerAfter resets only after three newer cancellations in seven days', () => {
    const records = [
        cancellation(100, '2026-05-19T00:00:00.000Z'),
        cancellation(100, '2026-05-20T00:00:00.000Z'),
        cancellation(100, '2026-05-22T00:00:00.000Z'),
        cancellation(100, '2026-05-24T00:00:00.000Z'),
        cancellation(100, '2026-05-25T00:00:00.000Z'),
        cancellation(100, '2026-05-26T00:00:00.000Z')
    ];

    const noReset = findLatestTriggerAfter(records.slice(0, 4), 100, '22-05-2026 05:30:00');
    const reset = findLatestTriggerAfter(records, 100, '22-05-2026 05:30:00');

    assert.equal(noReset, null);
    assert.equal(formatIST(reset.trigger.cancelledAt), '26-05-2026 05:30:00');
    assert.equal(reset.window.length, 3);
});

test('getMostRecentLateCancellationDate uses Momence isLateCancelled and deletedAt fields', () => {
    const latest = getMostRecentLateCancellationDate([
        { type: 'session', isLateCancelled: true, deletedAt: '2026-04-28T19:54:10.986Z' },
        { type: 'session', isLateCancelled: false, deletedAt: '2026-05-20T00:00:00.000Z' },
        { type: 'session', isLateCancelled: true, deletedAt: '2026-04-27T17:16:47.087Z' }
    ]);

    assert.equal(latest.toISOString(), '2026-04-28T19:54:10.986Z');
});

test('shouldTransitionToP57 requires LC-7 and more than seven days since latest late cancellation', () => {
    const cycle = {
        latestLateCancellationAt: '18-05-2026 05:29:59'
    };
    const decision = shouldTransitionToP57(
        cycle,
        [{ id: 164561 }],
        new Date('2026-05-25T00:00:00.000Z')
    );

    assert.equal(decision.shouldTransition, true);
});

test('shouldTransitionToP57 blocks exactly seven days', () => {
    const cycle = {
        latestLateCancellationAt: '18-05-2026 05:30:00'
    };
    const decision = shouldTransitionToP57(
        cycle,
        [{ id: 164561 }],
        new Date('2026-05-25T00:00:00.000Z')
    );

    assert.equal(decision.shouldTransition, false);
});

test('buildP57TagPayload removes LC-7, preserves existing tags, and adds P57', () => {
    const payload = buildP57TagPayload([
        { id: 154702 },
        { id: 164561 },
        { id: 999999 }
    ], 15338348);

    assert.deepEqual(payload, {
        tagIds: [154702, 999999, 164581],
        type: 'customer',
        entityId: 15338348
    });
});

test('formatIST writes sheet dates as DD-MM-YYYY HH:MM:SS and parseDate reads them back', () => {
    const formatted = formatIST('2026-05-25T06:08:02.350Z');
    assert.equal(formatted, '25-05-2026 11:38:02');
    assert.equal(parseDate(formatted).toISOString(), '2026-05-25T06:08:02.000Z');
});
