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

const puppeteer   = require('puppeteer');
const nodemailer  = require('nodemailer');
const fs          = require('fs');
const path        = require('path');

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

/**
 * Read the persisted "last-known scheduled date" from disk.
 */
function readStateDate() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const { scheduledDate } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return scheduledDate ? new Date(scheduledDate) : null;
    }
  } catch { /* ignore corrupt file */ }
  return null;
}

/**
 * Persist the current scheduled date to disk so future runs can use it even
 * if the site stops showing the date after a reschedule.
 */
function writeStateDate(date) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ scheduledDate: date.toISOString() }));
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
    const updateBtn = await page.$('button.update-btn, button[color="primary"]');
    if (!updateBtn) {
      // Maybe the page already moved on or layout changed — try text match.
      const [btn] = await page.$x("//button[contains(., 'עדכון')]");
      if (btn) await btn.click();
      else throw new Error('Could not find the "עדכון" (Update) button.');
    } else {
      await updateBtn.click();
    }
    console.log('🖱️  Clicked "Update" button.');
    await page.waitForTimeout(1500);

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

    await page.waitForTimeout(500);

    // Click "המשך" (Continue)
    try {
      const continueBtn =
        (await page.$x("//button[contains(., 'המשך')]"))[0] ||
        (await page.$('button.continue-btn'));
      if (continueBtn) {
        await continueBtn.click();
        console.log('🖱️  Clicked "Continue" button.');
      }
    } catch {
      console.log('ℹ️  No "Continue" button found — the calendar may already be visible.');
    }

    await page.waitForTimeout(2000);

    // ── Step 5: Open the datepicker / navigate months to find slots ────
    // Click the calendar icon to open the Material datepicker popup.
    try {
      const calendarToggle = await page.$(
        'mat-datepicker-toggle button, .mat-datepicker-toggle button, button[aria-label*="calendar"], button[aria-label*="תאריך"]'
      );
      if (calendarToggle) {
        await calendarToggle.click();
        console.log('📆 Opened datepicker.');
        await page.waitForTimeout(1000);
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
    const parsedSlots = [];
    for (const { label, day } of availableDates.dates) {
      // Try the simple D.M.YYYY inside the label
      const dmyMatch = label.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
      if (dmyMatch) {
        parsedSlots.push(new Date(+dmyMatch[3], +dmyMatch[2] - 1, +dmyMatch[1]));
        continue;
      }
      // Try English "Month DD, YYYY"
      const enMatch = label.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
      if (enMatch) {
        const d = new Date(`${enMatch[1]} ${enMatch[2]}, ${enMatch[3]}`);
        if (!isNaN(d)) { parsedSlots.push(d); continue; }
      }
      // Try "DD Month YYYY" (English)
      const enMatch2 = label.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (enMatch2) {
        const d = new Date(`${enMatch2[2]} ${enMatch2[1]}, ${enMatch2[3]}`);
        if (!isNaN(d)) { parsedSlots.push(d); continue; }
      }
    }

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
  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    console.error('❌ Email credentials missing. Set SMTP_USER, SMTP_PASS, NOTIFY_EMAIL.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const fmtDate = (d) => d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

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

// ---------------------------------------------------------------------------
//  Main execution
// ---------------------------------------------------------------------------

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Chili Delivery Slot Checker');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════');

  // ── Guard: required env vars ──────────────────────────────────────────
  if (!TRACKING_URL) {
    console.error('❌ TRACKING_URL environment variable is not set. Exiting.');
    process.exit(1);
  }

  try {
    // ── 1. Fetch data (browser or API) ─────────────────────────────────
    const { scheduledDate, availableSlots } =
      PARSING_MODE === 'api' ? await parseWithApi() : await parseWithBrowser();

    if (!availableSlots.length) {
      console.log('ℹ️  No available slots found. Nothing to compare.');
      process.exit(0);
    }

    // ── 2. Find the earliest available slot ────────────────────────────
    const earliestSlot = availableSlots.reduce(
      (min, d) => (d < min ? d : min),
      availableSlots[0],
    );

    console.log(`🏷️  Earliest available slot: ${earliestSlot.toLocaleDateString('en-GB')}`);

    // ── 3. Compare: alert only if strictly earlier ─────────────────────
    if (earliestSlot < scheduledDate) {
      console.log('🎉 Earlier slot detected! Sending notification …');
      await sendNotification(scheduledDate, earliestSlot);
    } else {
      console.log('😐 No earlier slot available. Current date is still the best.');
    }
  } catch (err) {
    console.error('❌ Error during execution:', err.message || err);
    process.exit(1);
  }
})();
