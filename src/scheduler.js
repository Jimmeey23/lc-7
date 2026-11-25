const logBus = require('./log-bus');
logBus.install();

const cron = require('node-cron');
const { getConfig } = require('./config');
const { createAuth } = require('./auth');
const { createAppServer } = require('./app-server');
const { createLocationRegistry } = require('./locations');
const { createRuntime } = require('./runtime');

const config = getConfig();
const registry = createLocationRegistry(config);
const runtime = createRuntime({ registry });
const auth = createAuth();

console.log(`LC-7 lifecycle scheduler started with schedule: ${config.cronSchedule}`);

let currentRun = null;
let shuttingDown = false;

// Every tick runs each enabled location in turn (primary first). Runs, webhooks and
// dashboard actions share one lock, so they never touch Momence/Sheets at once.
const task = cron.schedule(config.cronSchedule, async () => {
    if (shuttingDown) return;
    if (currentRun) {
        console.log('Previous run still active; skipping this tick');
        return;
    }
    currentRun = runtime.runAllEnabled('schedule')
        .catch(error => console.error(`Scheduled run failed: ${error.message}`))
        .finally(() => {
            currentRun = null;
        });
    await currentRun;
}, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
});

// HTTP: dashboard (/), API (/api), webhooks (/webhooks/momence[/<locationId>]), /health.
const server = createAppServer({
    runtime,
    registry,
    auth,
    webhookPath: process.env.WEBHOOK_PATH || '/webhooks/momence'
});
server.listen(config.webhook.port, () => {
    console.log(`Webhook receiver listening on :${config.webhook.port}${config.webhook.path}`);
    console.log(`Dashboard available on :${config.webhook.port}/${auth.configured ? '' : ' (locked: set ADMIN_PASSWORD to enable sign-in)'}`);
    if (!config.webhook.secret) console.log('MOMENCE_WEBHOOK_SECRET not set; webhooks will be rejected (503) until it is configured');
});

// Let in-flight work finish before exiting so a member is never left half-processed
// (e.g. LC-7 assigned but future bookings not yet cancelled). Railway sends SIGTERM on redeploy.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5 * 60 * 1000;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Scheduler received ${signal}; stopping`);
    task.stop();
    server.close();
    const pending = [
        currentRun,
        ...[...server.webhookQueues.values()].map(queue => queue.idle())
    ].filter(Boolean);
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
