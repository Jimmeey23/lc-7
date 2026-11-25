const cron = require('node-cron');
const { getConfig } = require('./config');
const run_ = require('./run');
const { run } = run_;
const { withLock } = require('./lock');
const { createEmailService } = require('./email-service');
const { createMomenceClient } = require('./momence-client');
const { createMomenceV2Client } = require('./momence-v2');
const { createSheetsStore } = require('./sheets-store');
const { createWebhookQueue, createWebhookServer } = require('./webhook-server');

const config = getConfig();

console.log(`LC-7 lifecycle scheduler started with schedule: ${config.cronSchedule}`);

let currentRun = null;
let shuttingDown = false;

const task = cron.schedule(config.cronSchedule, async () => {
    if (shuttingDown) return;
    if (currentRun) {
        console.log('Previous run still active; skipping this tick');
        return;
    }

    currentRun = withLock(() => run())
        .catch(error => {
            console.error(`Scheduled run failed: ${error.message}`);
        })
        .finally(() => {
            currentRun = null;
        });
    await currentRun;
}, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
});

// Webhook receiver: real-time late-cancellation handling. The HTTP server always starts
// (so /health and the public URL respond); webhooks are rejected with 503 until
// MOMENCE_WEBHOOK_SECRET is set.
let server = null;
let webhookQueue = null;
{
    webhookQueue = createWebhookQueue({
        createContext: async () => ({
            config,
            store: await createSheetsStore(config),
            momence: createMomenceClient(config),
            momenceV2: createMomenceV2Client(config),
            emailService: createEmailService(config),
            helpers: run_
        })
    });
    server = createWebhookServer({ config, queue: webhookQueue, path: config.webhook.path });
    server.listen(config.webhook.port, () => {
        console.log(`Webhook receiver listening on :${config.webhook.port}${config.webhook.path}`);
        if (!config.webhook.secret) console.log('MOMENCE_WEBHOOK_SECRET not set; webhooks will be rejected (503) until it is configured');
    });
}

// Let an in-flight run finish before exiting so a member is never left half-processed
// (e.g. LC-7 assigned but future bookings not yet cancelled). Railway sends SIGTERM on redeploy.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5 * 60 * 1000;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Scheduler received ${signal}; stopping`);
    task.stop();
    if (server) server.close();
    const pending = [currentRun, webhookQueue && webhookQueue.idle()].filter(Boolean);
    if (pending.length > 0) {
        console.log('Waiting for active run / queued webhooks to finish before exiting...');
        const timeout = new Promise(resolve => setTimeout(() => {
            console.warn(`Active work did not finish within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
            resolve();
        }, SHUTDOWN_TIMEOUT_MS));
        await Promise.race([Promise.all(pending), timeout]);
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
