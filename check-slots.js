#!/usr/bin/env node
// ============================================================================
//  Chili Delivery-Slot Checker
// ============================================================================
//  Navigates to the Chili delivery-coordination page (Angular SPA), reads the
//  current scheduled date, walks through the reschedule wizard to reveal the
//  calendar, scrapes every highlighted (available) date, and emails you when
//  an earlier slot is found.
//
//  Env vars (all required in CI; locally you can use a .env file):
//    TRACKING_URL       – full Chili tracking URL (contains the token)
//    SMTP_HOST          – e.g. smtp.gmail.com
//    SMTP_PORT          – e.g. 465
//    SMTP_USER          – sender Gmail address
//    SMTP_PASS          – Gmail App Password (not your regular password)
//    NOTIFY_EMAIL       – recipient email address
//
//  Optional:
//    PARSING_MODE       – "browser" (default) | "api"
//                         "browser" uses Puppeteer to render the Angular SPA.
//                         "api" sends a plain HTTP GET and parses JSON
//                         (use this if you later discover a direct API).
// ============================================================================

const fs          = require('fs');
const path        = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const puppeteer   = require('puppeteer');
const nodemailer  = require('nodemailer');

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------
const TRACKING_URL = process.env.TRACKING_URL;
const SMTP_HOST    = process.env.SMTP_HOST  || 'smtp.gmail.com';
const SMTP_PORT    = Number(process.env.SMTP_PORT || 465);
const SMTP_USER    = process.env.SMTP_USER;
const SMTP_PASS    = process.env.SMTP_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const PARSING_MODE = (process.env.PARSING_MODE || 'browser').toLowerCase();
const DRY_RUN      = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const LIFE_SIGNAL_ENABLED = /^(1|true|yes)$/i.test(process.env.LIFE_SIGNAL_ENABLED || '');
const LIFE_SIGNAL_FORCE = /^(1|true|yes)$/i.test(process.env.LIFE_SIGNAL_FORCE || '');
const LIFE_SIGNAL_TZ = process.env.LIFE_SIGNAL_TZ || 'Asia/Jerusalem';
const LIFE_SIGNAL_HOUR = Number(process.env.LIFE_SIGNAL_HOUR || 10);
const LIFE_SIGNAL_MINUTE = Number(process.env.LIFE_SIGNAL_MINUTE || 0);
const LIFE_SIGNAL_WINDOW_MINUTES = Number(process.env.LIFE_SIGNAL_WINDOW_MINUTES || 15);

// Path to a tiny JSON file that persists the "last-known scheduled date"
// as a fallback when the site doesn't expose the current date directly.
const STATE_FILE = path.join(__dirname, '.last-known-date.json');

// ---------------------------------------------------------------------------
//  Utility helpers
// ---------------------------------------------------------------------------

/**
 * Parse a date string in DD/MM/YYYY or D.M.YYYY format → JS Date (midnight).
 */
function parseDate(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\./g, '/');          // 14.6.2026 → 14/6/2026
  const [d, m, y] = cleaned.split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);                            // months are 0-indexed
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }
  return {};
}

function writeState(updates) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...updates }, null, 2));
}

/**
 * Read the persisted "last-known scheduled date" from disk.
 */
function readStateDate() {
  const { scheduledDate } = readState();
  if (scheduledDate) {
    const date = new Date(scheduledDate);
    if (!isNaN(date)) return date;
  }
  return null;
}

/**
 * Persist the current scheduled date to disk so future runs can use it even
 * if the site stops showing the date after a reschedule.
 */
function writeStateDate(date) {
  writeState({ scheduledDate: date.toISOString() });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const UPDATE_BUTTON_TEXT = '\u05e2\u05d3\u05db\u05d5\u05df';
const CONTINUE_BUTTON_TEXT = '\u05d4\u05de\u05e9\u05da';

async function findButtonByText(page, expectedText) {
  const buttons = await page.$$('button');
  for (const button of buttons) {
    const text = await button.evaluate(el => el.textContent?.trim() || '');
    if (text.includes(expectedText)) return button;
    await button.dispose();
  }
  return null;
}

function extractScheduledDate(bodyText) {
  const patterns = [
    /\u05ea\u05d5\u05d0\u05de\u05d4\s+\u05dc\u05d9\u05d5\u05dd\s+\S+\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/,
    /\u05ea\u05d0\u05e8\u05d9\u05da[^\d]*(\d{1,2}[./]\d{1,2}[./]\d{4})/,
    /(\d{1,2}[./]\d{1,2}[./]\d{4})/,
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    const date = match ? parseDate(match[1]) : null;
    if (date) return date;
  }

  return null;
}

const HEBREW_MONTHS = new Map([
  ['\u05d9\u05e0\u05d5\u05d0\u05e8', 0],
  ['\u05e4\u05d1\u05e8\u05d5\u05d0\u05e8', 1],
  ['\u05de\u05e8\u05e5', 2],
  ['\u05d0\u05e4\u05e8\u05d9\u05dc', 3],
  ['\u05de\u05d0\u05d9', 4],
  ['\u05d9\u05d5\u05e0\u05d9', 5],
  ['\u05d9\u05d5\u05dc\u05d9', 6],
  ['\u05d0\u05d5\u05d2\u05d5\u05e1\u05d8', 7],
  ['\u05e1\u05e4\u05d8\u05de\u05d1\u05e8', 8],
  ['\u05d0\u05d5\u05e7\u05d8\u05d5\u05d1\u05e8', 9],
  ['\u05e0\u05d5\u05d1\u05de\u05d1\u05e8', 10],
  ['\u05d3\u05e6\u05de\u05d1\u05e8', 11],
]);

function parseCalendarLabel(label) {
  if (!label) return null;

  const numericMatch = label.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (numericMatch) {
    return new Date(+numericMatch[3], +numericMatch[2] - 1, +numericMatch[1]);
  }

  const enMonthFirst = label.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (enMonthFirst) {
    const date = new Date(`${enMonthFirst[1]} ${enMonthFirst[2]}, ${enMonthFirst[3]}`);
    return isNaN(date) ? null : date;
  }

  const enDayFirst = label.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (enDayFirst) {
    const date = new Date(`${enDayFirst[2]} ${enDayFirst[1]}, ${enDayFirst[3]}`);
    return isNaN(date) ? null : date;
  }

  const heDayFirst = label.match(/(\d{1,2})\s+([\u0590-\u05ff]+)\s+(\d{4})/);
  if (heDayFirst) {
    const month = HEBREW_MONTHS.get(heDayFirst[2]);
    if (month !== undefined) return new Date(+heDayFirst[3], month, +heDayFirst[1]);
  }

  return null;
}

function createEmailTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function fmtDate(date) {
  return date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function getLifeSignalTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LIFE_SIGNAL_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function isLifeSignalWindow(now = new Date()) {
  if (LIFE_SIGNAL_FORCE) return true;
  if (!LIFE_SIGNAL_ENABLED) return false;

  const current = getLifeSignalTime(now);
  const currentMinuteOfDay = current.hour * 60 + current.minute;
  const targetMinuteOfDay = LIFE_SIGNAL_HOUR * 60 + LIFE_SIGNAL_MINUTE;

  return (
    currentMinuteOfDay >= targetMinuteOfDay &&
    currentMinuteOfDay < targetMinuteOfDay + LIFE_SIGNAL_WINDOW_MINUTES
  );
}

// ---------------------------------------------------------------------------
//  Option A — Browser-based parsing (Puppeteer)
// ---------------------------------------------------------------------------

async function parseWithBrowser() {
  console.log('⏳ Launching headless browser …');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();

    // Modern Chrome UA to avoid basic bot-blocking.
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 900 });

    // ── Step 1: Load the tracking page ─────────────────────────────────
    console.log('🌐 Navigating to tracking URL …');
    await page.goto(TRACKING_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Wait for Angular to render the main content.
    // The scheduled date line contains text like "תואמה ליום ראשון 14/06/2026"
    await page.waitForSelector('app-root', { timeout: 15_000 });
    // Give Angular a moment to bootstrap and render the view.
    await page.waitForFunction(
      () => document.body.innerText.length > 100,
      { timeout: 15_000 },
    );

    // ── Step 2: Extract the current scheduled delivery date ────────────
    // ┌──────────────────────────────────────────────────────────────────┐
    // │ SELECTOR / TEXT TO UPDATE:                                      │
    // │ The page shows a line like "תואמה ליום ראשון 14/06/2026".       │
    // │ We extract the DD/MM/YYYY portion from the full body text.      │
    // └──────────────────────────────────────────────────────────────────┘
    const bodyText = await page.evaluate(() => document.body.innerText);
    const scheduledMatch = bodyText.match(/תואמה\s+ליום\s+\S+\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
    let scheduledDate = scheduledMatch ? parseDate(scheduledMatch[1]) : null;
    if (!scheduledDate) scheduledDate = extractScheduledDate(bodyText);

    if (!scheduledDate) {
      console.warn('⚠️  Could not extract scheduled date from page text. Trying state file …');
      scheduledDate = readStateDate();
    }

    if (!scheduledDate) {
      throw new Error(
        'Cannot determine the current scheduled delivery date. ' +
        'Neither the page text nor the state file contained a valid date.'
      );
    }

    // Persist it for next run (dynamic baseline update).
    writeStateDate(scheduledDate);
    console.log(`📅 Current scheduled date: ${scheduledDate.toLocaleDateString('en-GB')}`);

    // ── Step 3: Navigate to the reschedule calendar ────────────────────
    // Click the "עדכון" (Update) button.
    let updateBtn = await page.$('button.update-btn');
    if (!updateBtn) updateBtn = await findButtonByText(page, UPDATE_BUTTON_TEXT);
    if (!updateBtn) updateBtn = await page.$('button[color="primary"]');
    if (!updateBtn) throw new Error('Could not find the Update button.');
    await updateBtn.click();
    console.log('🖱️  Clicked "Update" button.');
    await sleep(1500);

    // ── Step 4: Accept the T&C checkbox and click "המשך" (Continue) ───
    // The T&C checkbox may be a mat-checkbox; click its inner input or the label.
    try {
      await page.waitForSelector('mat-checkbox, input[type="checkbox"]', { timeout: 5_000 });
      const checkbox = await page.$('mat-checkbox .mdc-checkbox__native-control, mat-checkbox input, input[type="checkbox"]');
      if (checkbox) {
        await checkbox.evaluate(el => el.click());
        console.log('☑️  Checked the T&C checkbox.');
      }
    } catch {
      console.log('ℹ️  No T&C checkbox found — skipping.');
    }

    await sleep(500);

    // Click "המשך" (Continue)
    try {
      const continueBtn =
        (await findButtonByText(page, CONTINUE_BUTTON_TEXT)) ||
        (await page.$('button.continue-btn'));
      if (continueBtn) {
        await continueBtn.click();
        console.log('🖱️  Clicked "Continue" button.');
      }
    } catch {
      console.log('ℹ️  No "Continue" button found — the calendar may already be visible.');
    }

    await sleep(2000);

    // ── Step 5: Open the datepicker / navigate months to find slots ────
    // Click the calendar icon to open the Material datepicker popup.
    try {
      const calendarToggle = await page.$(
        'mat-datepicker-toggle button, .mat-datepicker-toggle button, button[aria-label*="calendar"], button[aria-label*="תאריך"]'
      );
      if (calendarToggle) {
        await calendarToggle.click();
        console.log('📆 Opened datepicker.');
        await sleep(1000);
      }
    } catch {
      console.log('ℹ️  Datepicker toggle not found — calendar may be inline.');
    }

    // ── Step 6: Scrape available (highlighted) dates from the calendar ──
    // ┌──────────────────────────────────────────────────────────────────┐
    // │ SELECTORS TO UPDATE:                                            │
    // │ Available dates in Angular Material datepicker have the class   │
    // │ "highlighted-available-date" and an aria-label like "14 June…". │
    // │ We also inspect the fallback: standard mat-calendar cells that  │
    // │ are not disabled.                                               │
    // └──────────────────────────────────────────────────────────────────┘
    const availableDates = await page.evaluate(() => {
      const dates = [];

      // Primary: custom-highlighted cells
      document.querySelectorAll(
        '.highlighted-available-date, .mat-calendar-body-cell:not(.mat-calendar-body-disabled)'
      ).forEach(cell => {
        // aria-label is usually "June 10, 2026" or "10 ביוני 2026" etc.
        const label = cell.getAttribute('aria-label') || '';
        // The cell also embeds a data attribute or inner text with the day number.
        const dayText = cell.querySelector('.mat-calendar-body-cell-content')?.textContent?.trim();
        dates.push({ label, day: dayText });
      });

      // Also look for the input field itself which shows "D.M.YYYY"
      const dateInput = document.querySelector('input[matDatepicker], input[matInput]');
      const inputValue = dateInput?.value || '';

      return { dates, inputValue };
    });

    console.log(`🔍 Found ${availableDates.dates.length} calendar cells.`);

    // Parse each available date. The aria-label may follow several formats:
    //   "June 10, 2026" | "10 June 2026" | "10 ביוני 2026" | "10.6.2026"
    const parsedSlots = availableDates.dates
      .map(({ label }) => parseCalendarLabel(label))
      .filter(Boolean);

    console.log(`📋 Parsed ${parsedSlots.length} available slot date(s).`);

    return { scheduledDate, availableSlots: parsedSlots };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
//  Option B — Direct API / JSON parsing (fallback if a JSON endpoint exists)
// ---------------------------------------------------------------------------

async function parseWithApi() {
  // Using native fetch (Node 18+), or fall back to dynamic import.
  const fetchFn = globalThis.fetch ?? (await import('node-fetch')).default;

  console.log('🌐 Fetching API response …');
  const res = await fetchFn(TRACKING_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);
  const data = await res.json();

  // ┌──────────────────────────────────────────────────────────────────────┐
  // │ JSON KEYS TO UPDATE:                                                │
  // │ Adjust the property paths below to match the actual API response.   │
  // └──────────────────────────────────────────────────────────────────────┘
  // Example expected structure:
  // {
  //   "order": {
  //     "scheduledDate": "2026-06-14",          ← current delivery date
  //     "availableSlots": [                     ← open earlier windows
  //       { "date": "2026-06-10", "timeWindow": "10:00-14:00" },
  //       { "date": "2026-06-08", "timeWindow": "08:00-12:00" }
  //     ]
  //   }
  // }
  const scheduledRaw = data?.order?.scheduledDate;                    // ← UPDATE THIS KEY
  const slotsRaw     = data?.order?.availableSlots ?? [];             // ← UPDATE THIS KEY

  const scheduledDate = scheduledRaw ? new Date(scheduledRaw) : readStateDate();
  if (!scheduledDate) throw new Error('No scheduled date found in API response or state file.');

  writeStateDate(scheduledDate);

  const availableSlots = slotsRaw
    .map(s => new Date(s.date))                                       // ← UPDATE THIS KEY
    .filter(d => !isNaN(d));

  return { scheduledDate, availableSlots };
}

// ---------------------------------------------------------------------------
//  Email notification
// ---------------------------------------------------------------------------

async function sendNotification(scheduledDate, earliestSlot) {
  if (DRY_RUN) {
    console.log('DRY_RUN is enabled; skipping email notification.');
    return;
  }

  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    console.error('❌ Email credentials missing. Set SMTP_USER, SMTP_PASS, NOTIFY_EMAIL.');
    return;
  }

  const transporter = createEmailTransporter();

  const daysSaved = Math.round(
    (scheduledDate.getTime() - earliestSlot.getTime()) / (1000 * 60 * 60 * 24)
  );

  await transporter.sendMail({
    from: `"Chili Slot Checker" <${SMTP_USER}>`,
    to: NOTIFY_EMAIL,
    subject: `🚚 Earlier delivery slot found! (${daysSaved} day${daysSaved > 1 ? 's' : ''} earlier)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;
                  border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="color:#1e4db7;margin-top:0">Earlier Delivery Slot Available!</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr>
            <td style="padding:8px 0;color:#666">Current date:</td>
            <td style="padding:8px 0;font-weight:600">${fmtDate(scheduledDate)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666">Earliest open slot:</td>
            <td style="padding:8px 0;font-weight:600;color:#388e3c">${fmtDate(earliestSlot)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666">Days earlier:</td>
            <td style="padding:8px 0;font-weight:600;color:#1e4db7">${daysSaved}</td>
          </tr>
        </table>
        <p style="margin-top:16px">
          <a href="${TRACKING_URL}"
             style="display:inline-block;padding:10px 24px;background:#1e4db7;color:#fff;
                    border-radius:6px;text-decoration:none;font-weight:600">
            Open Tracking Page →
          </a>
        </p>
        <p style="font-size:12px;color:#999;margin-top:24px">
          This alert was sent by the automated Chili Slot Checker.
        </p>
      </div>
    `,
  });

  console.log(`📧 Email sent to ${NOTIFY_EMAIL}`);
}

async function sendLifeSignal(scheduledDate, earliestSlot, availableSlots) {
  if (DRY_RUN) {
    console.log('DRY_RUN is enabled; skipping life signal email.');
    return;
  }

  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    console.error('❌ Email credentials missing. Set SMTP_USER, SMTP_PASS, NOTIFY_EMAIL.');
    return;
  }

  const localTime = getLifeSignalTime();
  const transporter = createEmailTransporter();
  const earliestSlotText = earliestSlot ? fmtDate(earliestSlot) : 'No available slots were parsed';

  await transporter.sendMail({
    from: `"Chili Slot Checker" <${SMTP_USER}>`,
    to: NOTIFY_EMAIL,
    subject: `Chili Slot Checker life signal - ${localTime.date} ${String(localTime.hour).padStart(2, '0')}:${String(localTime.minute).padStart(2, '0')}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;
                  border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="color:#1e4db7;margin-top:0">Chili Slot Checker is running</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr>
            <td style="padding:8px 0;color:#666">Checked at:</td>
            <td style="padding:8px 0;font-weight:600">${localTime.date} ${String(localTime.hour).padStart(2, '0')}:${String(localTime.minute).padStart(2, '0')} ${LIFE_SIGNAL_TZ}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666">Current date:</td>
            <td style="padding:8px 0;font-weight:600">${fmtDate(scheduledDate)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666">Earliest open slot:</td>
            <td style="padding:8px 0;font-weight:600">${earliestSlotText}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#666">Available dates parsed:</td>
            <td style="padding:8px 0;font-weight:600">${availableSlots.length}</td>
          </tr>
        </table>
        <p style="font-size:12px;color:#999;margin-top:24px">
          This daily life signal means the scheduled GitHub Actions run completed.
        </p>
      </div>
    `,
  });

  console.log(`📧 Life signal email sent to ${NOTIFY_EMAIL}`);
}

// ---------------------------------------------------------------------------
//  Main execution
// ---------------------------------------------------------------------------

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Chili Delivery Slot Checker');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════');

  // ── Guard: required env vars ──────────────────────────────────────────
  const missingConfig = [];
  if (!TRACKING_URL || TRACKING_URL.includes('YOUR-TOKEN-HERE')) missingConfig.push('TRACKING_URL');
  if (LIFE_SIGNAL_ENABLED || LIFE_SIGNAL_FORCE) {
    if (!LIFE_SIGNAL_TZ) missingConfig.push('LIFE_SIGNAL_TZ');
    if (!Number.isInteger(LIFE_SIGNAL_HOUR) || LIFE_SIGNAL_HOUR < 0 || LIFE_SIGNAL_HOUR > 23) missingConfig.push('LIFE_SIGNAL_HOUR');
    if (!Number.isInteger(LIFE_SIGNAL_MINUTE) || LIFE_SIGNAL_MINUTE < 0 || LIFE_SIGNAL_MINUTE > 59) missingConfig.push('LIFE_SIGNAL_MINUTE');
    if (!Number.isInteger(LIFE_SIGNAL_WINDOW_MINUTES) || LIFE_SIGNAL_WINDOW_MINUTES < 1 || LIFE_SIGNAL_WINDOW_MINUTES > 60) missingConfig.push('LIFE_SIGNAL_WINDOW_MINUTES');
  }
  if (!DRY_RUN) {
    if (!Number.isFinite(SMTP_PORT)) missingConfig.push('SMTP_PORT');
    if (!SMTP_USER || SMTP_USER.includes('your.email')) missingConfig.push('SMTP_USER');
    if (!SMTP_PASS || SMTP_PASS.includes('your-16-char')) missingConfig.push('SMTP_PASS');
    if (!NOTIFY_EMAIL || NOTIFY_EMAIL.includes('recipient@example.com')) missingConfig.push('NOTIFY_EMAIL');
  }

  if (missingConfig.length) {
    console.error(`❌ Missing required configuration: ${missingConfig.join(', ')}`);
    console.error(`   Locally, fill ${path.join(__dirname, '.env')}.`);
    console.error('   In GitHub, add the same values as repository Actions secrets.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('DRY_RUN is enabled; email settings are optional for this run.');
  }

  try {
    // ── 1. Fetch data (browser or API) ─────────────────────────────────
    const { scheduledDate, availableSlots } =
      PARSING_MODE === 'api' ? await parseWithApi() : await parseWithBrowser();

    const earliestSlot = availableSlots.length
      ? availableSlots.reduce((min, d) => (d < min ? d : min), availableSlots[0])
      : null;

    if (earliestSlot) {
      console.log(`🏷️  Earliest available slot: ${earliestSlot.toLocaleDateString('en-GB')}`);
    } else {
      console.log('ℹ️  No available slots found. Nothing to compare.');
    }

    // ── 3. Compare: alert only if strictly earlier ─────────────────────
    if (earliestSlot && earliestSlot < scheduledDate) {
      console.log('🎉 Earlier slot detected! Sending notification …');
      await sendNotification(scheduledDate, earliestSlot);
    } else if (!earliestSlot) {
      console.log('No earlier slot can be evaluated because no slots were parsed.');
    } else {
      console.log('😐 No earlier slot available. Current date is still the best.');
    }

    if (isLifeSignalWindow()) {
      console.log('Daily life signal window matched. Sending status email …');
      await sendLifeSignal(scheduledDate, earliestSlot, availableSlots);
    } else if (LIFE_SIGNAL_ENABLED) {
      const localTime = getLifeSignalTime();
      console.log(
        `Life signal is enabled for ${String(LIFE_SIGNAL_HOUR).padStart(2, '0')}:${String(LIFE_SIGNAL_MINUTE).padStart(2, '0')} ${LIFE_SIGNAL_TZ}; current local time is ${String(localTime.hour).padStart(2, '0')}:${String(localTime.minute).padStart(2, '0')}.`
      );
    }
  } catch (err) {
    console.error('❌ Error during execution:', err.message || err);
    process.exit(1);
  }
})();
