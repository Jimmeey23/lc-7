# LC7 Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent LC-7 lifecycle automation that records state in a separate Google Sheet and performs each member action exactly once per lifecycle stage.

**Architecture:** The project separates Momence API calls, Google Sheets persistence, lifecycle rules, and the CLI runner. The `LC7Lifecycle` sheet is the source of truth for whether a member needs LC-7 tagging, booking cancellation, waiting, or P57 transition.

**Tech Stack:** Node.js 20+, axios, dotenv, google-spreadsheet, google-auth-library, node-cron, node:test.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `README.md`

- [x] Create package metadata, scripts, dependency list, and environment documentation.

### Task 2: Core Modules

**Files:**
- Create: `src/config.js`
- Create: `src/date-utils.js`
- Create: `src/lifecycle.js`
- Create: `src/momence-client.js`
- Create: `src/sheets-store.js`

- [x] Implement configuration validation, date parsing, state-machine decisions, API wrappers, and Google Sheets storage.

### Task 3: Runner

**Files:**
- Create: `src/run.js`
- Create: `src/scheduler.js`

- [x] Implement the orchestration sequence: report ingestion, LC-7 detection, immediate future booking cancellation for newly tagged members, and delayed P57 transition for waiting cycles.

### Task 4: Tests

**Files:**
- Create: `test/lifecycle.test.js`

- [x] Test rolling 7-day detection, strict P57 eligibility after 7 days, tag payload construction, and state transitions.

### Task 5: Verification

- [x] Run `npm test`.
- [x] Run `node --check src/run.js`.
- [x] Run `node --check src/scheduler.js`.
