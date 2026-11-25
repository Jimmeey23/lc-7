const cron = require('node-cron');
const { getConfig } = require('./config');
const { run } = require('./run');

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

    currentRun = run()
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

// Let an in-flight run finish before exiting so a member is never left half-processed
// (e.g. LC-7 assigned but future bookings not yet cancelled). Railway sends SIGTERM on redeploy.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5 * 60 * 1000;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Scheduler received ${signal}; stopping`);
    task.stop();
    if (currentRun) {
        console.log('Waiting for active run to finish before exiting...');
        const timeout = new Promise(resolve => setTimeout(() => {
            console.warn(`Active run did not finish within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
            resolve();
        }, SHUTDOWN_TIMEOUT_MS));
        await Promise.race([currentRun, timeout]);
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
