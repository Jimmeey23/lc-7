const crypto = require('crypto');
const axios = require('axios');
const { formatRunTimestamp, parseDate } = require('./date-utils');

const EMAIL_POLICY_CUTOFF_AT = new Date('2026-05-24T18:30:00.000Z');

const TEMPLATE_A_SUBJECT = 'Booking Privileges Paused for 7 Days (Late Cancellations)';
const TEMPLATE_B_SUBJECT = 'Notification: Your Booking Privileges Are Now Restored';
const TEMPLATE_A_UUID = 'c608e180-2366-4035-9c41-f4a54ca54caf';
const TEMPLATE_B_UUID = 'd5c9a2a0-2e55-48cf-9016-36f48330564b';

function makeEmailId(template, cycle, relatedDate = '') {
    return crypto
        .createHash('sha1')
        .update([template, cycle.cycleId, cycle.memberId, relatedDate].join('|'))
        .digest('hex');
}

function getFirstName(cycle) {
    const name = String(cycle.memberName || '').trim();
    if (!name) return 'there';
    return name.split(/\s+/)[0];
}

function areAllTriggerDatesOnOrAfterEmailCutoff(cycle) {
    const dates = Array.isArray(cycle.triggerWindowDates)
        ? cycle.triggerWindowDates
        : String(cycle.triggerWindowDates || '').split('|').map(value => value.trim()).filter(Boolean);
    if (dates.length < 3) return false;
    return dates.slice(0, 3).every(value => {
        const date = parseDate(value);
        return date && date >= EMAIL_POLICY_CUTOFF_AT;
    });
}

function isRemovalDateOnOrAfterEmailCutoff(cycle) {
    const date = parseDate(cycle.p57EligibleAt);
    return Boolean(date && date >= EMAIL_POLICY_CUTOFF_AT);
}

function shouldSendTemplateA(cycle) {
    return Boolean(cycle.memberEmail && areAllTriggerDatesOnOrAfterEmailCutoff(cycle));
}

function shouldSendTemplateB(cycle) {
    return Boolean(cycle.memberEmail && isRemovalDateOnOrAfterEmailCutoff(cycle));
}

function buildTemplateA(cycle) {
    const firstName = getFirstName(cycle);
    return {
        subject: TEMPLATE_A_SUBJECT,
        templateUuid: TEMPLATE_A_UUID,
        templateVariables: {
            first_name: firstName,
            your_name: 'Team Physique 57'
        }
    };
}

function buildTemplateB(cycle) {
    const firstName = getFirstName(cycle);
    return {
        subject: TEMPLATE_B_SUBJECT,
        templateUuid: TEMPLATE_B_UUID,
        templateVariables: {
            first_name: firstName
        }
    };
}

function createEmailService(config, httpClient = axios) {
    async function sendMail(message, cycle) {
        return httpClient.post(
            config.mail.apiUrl,
            {
                from: {
                    email: config.mail.from,
                    name: config.mail.fromName
                },
                to: [{ email: cycle.memberEmail }],
                reply_to: { email: config.mail.replyTo },
                template_uuid: message.templateUuid,
                template_variables: message.templateVariables
            },
            {
                headers: {
                    Authorization: `Bearer ${config.mail.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
    }

    async function sendLifecycleEmail(store, cycle, template) {
        const message = template === 'A' ? buildTemplateA(cycle) : buildTemplateB(cycle);
        const relatedDate = template === 'A' ? cycle.latestLateCancellationAt : cycle.p57EligibleAt;
        const emailId = makeEmailId(template, cycle, relatedDate);

        if (await store.hasSentEmail(emailId)) {
            return { sent: false, skipped: true, emailId };
        }

        const logBase = {
            emailId,
            cycleId: cycle.cycleId,
            memberId: cycle.memberId,
            memberEmail: cycle.memberEmail,
            template,
            subject: message.subject,
            relatedDate
        };

        try {
            if (!config.dryRun) {
                await sendMail(message, cycle);
            }
            await store.appendEmailLog({
                ...logBase,
                status: config.dryRun ? 'DRY_RUN' : 'SENT',
                sentAt: formatRunTimestamp()
            });
            return { sent: !config.dryRun, dryRun: config.dryRun, emailId };
        } catch (error) {
            await store.appendEmailLog({
                ...logBase,
                status: 'FAILED',
                sentAt: formatRunTimestamp(),
                error: error.message
            });
            throw error;
        }
    }

    async function retryFailedEmail(store, cycle, failedEmail) {
        if (!cycle.memberEmail && failedEmail.memberEmail) {
            cycle.memberEmail = failedEmail.memberEmail;
        }
        if (failedEmail.template !== 'A' && failedEmail.template !== 'B') {
            return { sent: false, skipped: true };
        }
        return sendLifecycleEmail(store, cycle, failedEmail.template);
    }

    async function sendTemplateA(store, cycle) {
        if (!shouldSendTemplateA(cycle)) return { sent: false, skipped: true };
        return sendLifecycleEmail(store, cycle, 'A');
    }

    async function sendTemplateB(store, cycle) {
        if (!shouldSendTemplateB(cycle)) return { sent: false, skipped: true };
        return sendLifecycleEmail(store, cycle, 'B');
    }

    return {
        retryFailedEmail,
        sendTemplateA,
        sendTemplateB
    };
}

module.exports = {
    EMAIL_POLICY_CUTOFF_AT,
    TEMPLATE_A_SUBJECT,
    TEMPLATE_B_SUBJECT,
    TEMPLATE_A_UUID,
    TEMPLATE_B_UUID,
    areAllTriggerDatesOnOrAfterEmailCutoff,
    buildTemplateA,
    buildTemplateB,
    createEmailService,
    getFirstName,
    isRemovalDateOnOrAfterEmailCutoff,
    makeEmailId,
    shouldSendTemplateA,
    shouldSendTemplateB
};
