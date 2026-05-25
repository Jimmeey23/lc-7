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
