# Railway Deployment

This project runs as a Railway web service: hourly scheduler plus the Momence webhook receiver (see README "Real-time webhooks"). Generate a public domain for the service so Momence can reach `/webhooks/momence`.

## Start Command

Railway should run:

```bash
node src/scheduler.js
```

Both `railway.json` and `Procfile` point to the scheduler.

If Railway service settings still have an old custom start command, replace it with:

```bash
node src/scheduler.js
```

The root `schedule.js` file is kept only as a compatibility entrypoint for older deployments that still run `node schedule.js`.

## Required Variables

Set these in Railway Variables:

```bash
MOMENCE_ACCESS_TOKEN=
MOMENCE_ALL_COOKIES=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
LC7_LIFECYCLE_SHEET_ID=
MAILTRAP_API_URL=https://send.api.mailtrap.io/api/send
MAILTRAP_API_TOKEN=
MAIL_FROM=hello@physique57india.com
MAIL_FROM_NAME=Mailtrap Test
MAIL_REPLY_TO=latecancellations@physique57india.com
CRON_SCHEDULE=0 * * * *
MOMENCE_WEBHOOK_SECRET=
MOMENCE_API_CLIENT_ID=
MOMENCE_API_CLIENT_SECRET=
MOMENCE_API_USERNAME=
MOMENCE_API_PASSWORD=
DRY_RUN=false
```

`LC7_LIFECYCLE_SHEET_ID` must be a different Google Sheet from the old automation.

## Test Mode

For a one-member Railway test, temporarily add:

```bash
TEST_MEMBER_ID=1606585
DRY_RUN=true
```

Remove `TEST_MEMBER_ID` and set `DRY_RUN=false` for production.
