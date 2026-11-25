# P57 LC-7 Lifecycle Automation

Independent state-machine automation for the LC-7 process.

## Flow

1. Pull the Momence late-cancellations report.
2. Store raw late cancellations idempotently in `LateCancellationsRaw`.
3. Detect members with 3 qualifying late cancellations in a rolling 7-day period.
4. Create an `LC7Lifecycle` cycle for newly qualifying members.
5. Assign LC-7 tag `164561`.
6. Immediately cancel future bookings only for members assigned LC-7 in the current run.
7. Mark those cycles `WAITING_7_DAYS`.
8. On later runs, inspect only `WAITING_7_DAYS` cycles.
9. If latest late cancellation is more than 7 days old and LC-7 is still present, replace LC-7 with P57 tag `164581`.

## Google Sheets

The lifecycle workbook contains:

```text
LateCancellationsRaw
LC7Lifecycle
CurrentLC7Members
RunLog
```

All sheet-facing date columns are written in IST as `DD-MM-YYYY HH:MM:SS`.
The lifecycle and current LC-7 sheets include comments explaining why LC-7 was initiated, why future bookings were cancelled, why P57 was assigned, or why a member appears in the current LC-7 list.

## Setup

```bash
cp .env.example .env
npm install
npm test
```

Create a separate Google Sheet and set:

```bash
LC7_LIFECYCLE_SHEET_ID=your_new_sheet_id
MAILTRAP_API_URL=https://send.api.mailtrap.io/api/send
MAILTRAP_API_TOKEN=your_mailtrap_api_token
MAIL_FROM=hello@physique57india.com
MAIL_FROM_NAME=Mailtrap Test
MAIL_REPLY_TO=latecancellations@physique57india.com
```

Do not reuse the old `GOOGLE_SHEET_ID`.

## Run

```bash
npm start
```

Test one member:

```bash
TEST_MEMBER_ID=1606585 npm start
```

Preview without mutating Momence:

```bash
DRY_RUN=true npm start
```

Schedule locally:

```bash
npm run schedule
```

## Dashboard (LC-7 Control Room)

The same Railway service serves a web app at its public URL (`/`).

- **Overview**: counts (serving LC-7, at risk, blocked/restored this week, needs attention), recent runs and webhooks, live activity.
- **Members**: everyone in a lifecycle, filterable and searchable. Open a member to see their timeline and:
  - **End block & restore P57** now (optionally without emailing them),
  - **change when the block ends**,
  - **retry** a failed step.
- **Block a member**: manually put a member on LC-7 (choose length, reason, whether to cancel future bookings and whether to email).
- **At risk**, **Run history**, **Emails**: the AtRisk, RunLog and EmailLog tabs.
- **Live activity**: the server log streamed in real time; **Run now** starts a run and you can watch it.
- **Locations**: add, edit, pause or remove cities/studios; test their connection; copy their webhook URL.

Dashboard actions use the same code as the automation and share its lock, so they never collide with a run or webhook.

Sign-in: set `ADMIN_PASSWORD` (and optionally `SESSION_SECRET`) in Railway. Without `ADMIN_PASSWORD` the dashboard stays locked.

## Adding another city / location

All locations run in this one service, with the same rules.

1. Create an empty Google Sheet for the location (same Google account; tabs are created automatically).
2. In Momence, note the location's host ID and its LC-7 and P57 tag IDs.
3. In the dashboard: **Locations → Add location**. Pick a short ID (e.g. `blr`) and a secrets prefix (e.g. `BLR_`). Tick **Dry run** for the first day.
4. In Railway, add the location's secrets using the prefix:

   ```bash
   BLR_MOMENCE_ACCESS_TOKEN=...
   BLR_MOMENCE_ALL_COOKIES=...
   BLR_MOMENCE_WEBHOOK_SECRET=...        # optional, enables real-time webhooks
   BLR_MOMENCE_API_CLIENT_ID=... etc.    # optional, v2 API for webhooks/look-ups
   BLR_MAILTRAP_API_TOKEN=...            # optional, defaults to the primary one
   ```

   Momence and webhook secrets never fall back to the primary location's values.
5. Click **Test connection** on the location card, then point the location's Momence webhook to the URL shown on the card (`/webhooks/momence/<id>`).
6. When the dry run looks right, edit the location and untick **Dry run**.

Settings live in the `Locations` tab of the primary sheet; secrets stay in Railway. The primary location is still configured only by the env vars in `.env.example`.
Sheet dates and the scheduler use IST (`Asia/Kolkata`); locations outside IST need code changes in `src/date-utils.js`.

## Reliability notes

- Lifecycle rows are read once per run and cached, keeping Google Sheets reads well under quota.
- Raw-tab dedup reads only the `rawId` column.
- `ActiveLC7` / `AtRisk` are rewritten only when content changes (`refreshedAt` = last changed).
- Default schedule is hourly (`CRON_SCHEDULE` overrides); real-time work comes from webhooks.
- Header migrations back up a tab before rewriting it.
- Failed cycles count toward `MAX_AUTO_RETRIES`, then stop for manual review.
- Momence `401`/`403` stops right away with a "refresh token/cookies" message.
- On `SIGTERM` (redeploy), the scheduler waits for the active run to finish.

## Real-time webhooks

Momence calls the app whenever a booking is cancelled, so penalties apply within seconds.

```
Momence ── POST session-booking-cancelled ──▶ /webhooks/momence
  1. Check x-webhook-secret (and HMAC x-webhook-signature), reply 200 immediately
  2. Ignore unless isLateCancellation = true; drop repeated x-webhook-reqeuest-id
  3. memberId = targetMemberId -> GET /api/v2/host/members/{id} (name, email)
  4. GET /api/v2/host/members/{id}/sessions?includeCancelled=true -> booking matching sessionBookingId
  5. Membership used = membership on the matching booking in the private customer
     history (readonly-api .../customers/{id}/history, matched by bookingId, then
     sessionId); else membership on the v2 booking; else
     fall back to the late-cancellation report for that member; if still unknown,
     store the row and let the hourly run decide
  6. Save to LateCancellationsRaw (comment says "webhook")
  7. History = this member's late cancellations in the lookback window
     (webhook + report rows, duplicates merged)
  8. Same rules as the scheduled run: unlimited membership, 3 within 7 days
     -> LC-7 tag, cancel future bookings, email A
     Already in WAITING_7_DAYS -> 7-day clock reset
  9. One RunLog row per webhook (runId webhook:<request id>, outcome in message)
```

The hourly scheduled run keeps doing P57 restores (time-based), retries and dashboards,
and still reads the report as a safety net for any webhook Momence fails to deliver.
Webhooks and scheduled runs never run at the same time (shared lock).

### Setup

1. Ask Momence support to enable outgoing webhooks (experimental feature) if
   Dashboard → Profile → Webhooks Configuration isn't visible.
2. Railway: Settings → Networking → Generate Domain for this service.
3. In Momence add webhook URL `https://<your-domain>/webhooks/momence` and copy the secret.
4. Set `MOMENCE_WEBHOOK_SECRET` and Momence API v2 auth (see `.env.example`), redeploy.
5. Check `GET https://<your-domain>/health` returns `{"ok":true}`.
6. Cancel a test booking late and check RunLog for a `webhook:` row.
7. Once the logs no longer show "signature missing or did not match", set
   `MOMENCE_WEBHOOK_ENFORCE_SIGNATURE=true`.

Outcomes written to RunLog: `LC7_TRIGGERED`, `BELOW_THRESHOLD (n …)`, `NOT_UNLIMITED_MEMBERSHIP`,
`ALREADY_IN_LC7`, `WAITING_PERIOD_RESET`, `MEMBERSHIP_UNKNOWN_DEFERRED_TO_SCHEDULED_RUN`.
