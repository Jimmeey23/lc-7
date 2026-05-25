const cron = require('node-cron');
const { getConfig } = require('./config');
const { run } = require('./run');

const config = getConfig();

console.log(`LC-7 lifecycle scheduler started with schedule: ${config.cronSchedule}`);

let running = false;
cron.schedule(config.cronSchedule, async () => {
    if (running) {
        console.log('Previous run still active; skipping this tick');
        return;
    }

    running = true;
    try {
        await run();
    } catch (error) {
        console.error(`Scheduled run failed: ${error.message}`);
    } finally {
        running = false;
    }
}, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
});

process.on('SIGINT', () => {
    console.log('Scheduler stopping');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Scheduler terminating');
    process.exit(0);
});
