const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTemplateA,
    buildTemplateB,
    getFirstName,
    shouldSendTemplateA,
    shouldSendTemplateB
} = require('../src/email-service');

function cycle(overrides = {}) {
    return {
        cycleId: 'cycle-1',
        memberId: 100,
        memberName: 'Priya Shah',
        memberEmail: 'priya@example.com',
        latestLateCancellationAt: '27-05-2026 10:00:00',
        p57EligibleAt: '03-06-2026 10:00:00',
        triggerWindowDates: [
            '25-05-2026 08:00:00',
            '26-05-2026 08:00:00',
            '27-05-2026 10:00:00'
        ],
        ...overrides
    };
}

test('shouldSendTemplateA requires all three trigger cancellations on or after May 25 IST', () => {
    assert.equal(shouldSendTemplateA(cycle()), true);
    assert.equal(shouldSendTemplateA(cycle({
        triggerWindowDates: [
            '24-05-2026 23:59:59',
            '26-05-2026 08:00:00',
            '27-05-2026 10:00:00'
        ]
    })), false);
});

test('shouldSendTemplateA skips cycles without member email', () => {
    assert.equal(shouldSendTemplateA(cycle({ memberEmail: '' })), false);
});

test('shouldSendTemplateB requires removal date on or after May 25 IST regardless of cancellation dates', () => {
    assert.equal(shouldSendTemplateB(cycle({
        p57EligibleAt: '25-05-2026 00:00:00',
        triggerWindowDates: [
            '18-05-2026 08:00:00',
            '19-05-2026 08:00:00',
            '20-05-2026 10:00:00'
        ]
    })), true);
    assert.equal(shouldSendTemplateB(cycle({ p57EligibleAt: '24-05-2026 23:59:59' })), false);
});

test('templates address the member by first name', () => {
    assert.equal(getFirstName(cycle()), 'Priya');
    assert.match(buildTemplateA(cycle()).text, /^Hi Priya,/);
    assert.match(buildTemplateB(cycle()).text, /^Hi Priya,/);
});
