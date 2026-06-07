const test = require('node:test');
const assert = require('node:assert/strict');
const { headersMatchExactly, repairShiftedLifecycleValues } = require('../src/sheets-store');

test('repairShiftedLifecycleValues restores legacy shifted LC7Lifecycle row values', () => {
    const repaired = repairShiftedLifecycleValues([
        '6373012d39cc5772ac768cd789debf7f69882e9e',
        '15337085',
        'Bijuri Shah',
        'bijuri@gmail.com',
        '02-06-2026 19:05:21',
        '27-05-2026 08:07:35 | 02-06-2026 06:20:27 | 02-06-2026 19:05:21',
        '02-06-2026 19:10:18',
        '02-06-2026 19:10:19',
        '02-06-2026 19:10:24',
        '2',
        '09/06/2026 19:05:21',
        '',
        'WAITING_7_DAYS',
        '',
        'Future booking cancellation ran immediately after LC-7 assignment.'
    ]);

    assert.equal(repaired.status, 'WAITING_7_DAYS');
    assert.equal(repaired.lc7TagAssignedAt, '02-06-2026 19:10:19');
    assert.equal(repaired.futureBookingsCancelledCount, '2');
    assert.equal(repaired.p57EligibleAt, '09/06/2026 19:05:21');
    assert.equal(repaired.p57TagAssignedAt, '');
    assert.equal(repaired.lastError, '');
    assert.match(repaired.assignmentReason, /27-05-2026 08:07:35/);
});

test('headersMatchExactly rejects stale lifecycle columns even when required headers exist', () => {
    const expected = ['cycleId', 'memberId', 'status'];

    assert.equal(headersMatchExactly(['cycleId', 'memberId', 'status'], expected), true);
    assert.equal(headersMatchExactly(['cycleId', 'memberId', 'oldColumn', 'status'], expected), false);
    assert.equal(headersMatchExactly(['cycleId', 'status', 'memberId'], expected), false);
});
