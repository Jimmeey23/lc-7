# Railway Deployment

This project is configured as a Railway worker.

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
CRON_SCHEDULE=*/5 * * * *
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
