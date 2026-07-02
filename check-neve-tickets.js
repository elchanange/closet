#!/usr/bin/env node
// ============================================================================
//  Neve Schechter Ticket Checker
// ============================================================================
//  Fetches the event product page directly, compares availability and purchase
//  signals against the last run, and emails when tickets look available or the
//  ticketing surface changes materially.
// ============================================================================

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const nodemailer = require('nodemailer');

const DEFAULT_TICKET_URL = 'https://neve-schechter.org.il/product/moadon-64/';

const TICKET_URL = process.env.NEVE_TICKET_URL || DEFAULT_TICKET_URL;
const STATE_FILE = process.env.NEVE_STATE_FILE || path.join(__dirname, '.neve-ticket-state.json');
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const ALERT_ON_FIRST_RUN = /^(1|true|yes)$/i.test(process.env.NEVE_ALERT_ON_FIRST_RUN || '');
const LIFE_SIGNAL_ENABLED = /^(1|true|yes)$/i.test(process.env.NEVE_LIFE_SIGNAL_ENABLED || '');
const LIFE_SIGNAL_INTERVAL_HOURS = Number(process.env.NEVE_LIFE_SIGNAL_INTERVAL_HOURS || 3);

const EXPECTED = {
  title: '\u05de\u05d5\u05e2\u05d3\u05d5\u05df \u05db\u05ea\u05d1 64',
  price: '85',
  dateFragments: ['13.7', '\u05d1\u05e6\u05d5\u05d5\u05ea\u05d0'],
};

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Ignore corrupt state and start from a clean baseline.
  }
  return {};
}

function writeState(updates) {
  const nextState = { ...readState(), ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function decodeEscapedUnicode(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractFirst(text, pattern) {
  const match = text.match(pattern);
  return match ? stripTags(decodeHtmlEntities(decodeEscapedUnicode(match[1]))) : '';
}

function extractLinks(html) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtmlEntities(match[1]);
    const label = stripTags(decodeHtmlEntities(decodeEscapedUnicode(match[2])));
    links.push({ href, label });
  }
  return links;
}

function extractPurchaseLinks(html) {
  const links = extractLinks(html);
  return links
    .filter(({ href, label }) => {
      const haystack = `${href} ${label}`.toLowerCase();
      return (
        haystack.includes('eventbuzz.co.il') ||
        haystack.includes('add-to-cart') ||
        haystack.includes('cart') ||
        haystack.includes('checkout') ||
        label.includes('\u05dc\u05e8\u05db\u05d9\u05e9\u05d4') ||
        label.includes('\u05db\u05e8\u05d8\u05d9\u05e1')
      );
    })
    .map(({ href, label }) => `${label || 'link'} -> ${href}`);
}

function extractFormSignals(html) {
  return {
    hasAddToCartButton: /single_add_to_cart_button|name=["']add-to-cart["']|wc-ajax=add_to_cart/i.test(html),
    productId: extractFirst(html, /name=["']product_id["'][^>]*value=["']([^"']*)["']/i),
    variationId: extractFirst(html, /name=["']variation_id["'][^>]*value=["']([^"']*)["']/i),
  };
}

function parsePage(html, status, finalUrl) {
  const decoded = decodeEscapedUnicode(decodeHtmlEntities(html));
  const visibleText = stripTags(decoded);
  const lowerHtml = html.toLowerCase();
  const lowerDecoded = decoded.toLowerCase();
  const form = extractFormSignals(html);

  const title =
    extractFirst(decoded, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    extractFirst(decoded, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const canonical = extractFirst(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const purchaseLinks = unique(extractPurchaseLinks(decoded));

  const outOfStock = (
    lowerHtml.includes('out-of-stock') ||
    lowerDecoded.includes('out-of-stock') ||
    decoded.includes('\u05d4\u05de\u05dc\u05d0\u05d9 \u05d0\u05d6\u05dc') ||
    decoded.includes('\u05d0\u05d6\u05dc')
  );

  const rawInStock = (
    lowerHtml.includes('stock in-stock') ||
    lowerHtml.includes('is_in_stock&quot;:true') ||
    lowerHtml.includes('"is_in_stock":true') ||
    lowerHtml.includes('purchasable&quot;:true') ||
    lowerHtml.includes('"purchasable":true')
  );
  const inStock = rawInStock && !outOfStock;

  const hasExpectedDate = EXPECTED.dateFragments.every(fragment => visibleText.includes(fragment));
  const hasExpectedPrice = visibleText.includes(EXPECTED.price) && visibleText.includes('\u20aa');
  const disabledAddToCart = /single_add_to_cart_button[^>]*disabled|disabled[^>]*single_add_to_cart_button/i.test(html);
  const likelyAvailable = !outOfStock && (inStock || form.hasAddToCartButton || purchaseLinks.length > 0) && !disabledAddToCart;

  return {
    checkedAt: new Date().toISOString(),
    status,
    finalUrl,
    canonical,
    title,
    hasExpectedTitle: title.includes(EXPECTED.title),
    hasExpectedDate,
    hasExpectedPrice,
    outOfStock,
    inStock,
    rawInStock,
    disabledAddToCart,
    likelyAvailable,
    hasAddToCartButton: form.hasAddToCartButton,
    productId: form.productId,
    variationId: form.variationId,
    purchaseLinks,
  };
}

function signature(snapshot) {
  return {
    status: snapshot.status,
    finalUrl: snapshot.finalUrl,
    canonical: snapshot.canonical,
    title: snapshot.title,
    hasExpectedDate: snapshot.hasExpectedDate,
    hasExpectedPrice: snapshot.hasExpectedPrice,
    outOfStock: snapshot.outOfStock,
    inStock: snapshot.inStock,
    rawInStock: snapshot.rawInStock,
    disabledAddToCart: snapshot.disabledAddToCart,
    likelyAvailable: snapshot.likelyAvailable,
    productId: snapshot.productId,
    variationId: snapshot.variationId,
    purchaseLinks: snapshot.purchaseLinks,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function diffSnapshots(previous, current) {
  const findings = [];
  if (!previous) return findings;

  const checks = [
    ['status', 'HTTP status changed'],
    ['finalUrl', 'Final URL changed'],
    ['canonical', 'Canonical URL changed'],
    ['title', 'Event title changed'],
    ['hasExpectedDate', 'Expected date/location text changed'],
    ['hasExpectedPrice', 'Expected price text changed'],
    ['outOfStock', 'Out-of-stock marker changed'],
    ['inStock', 'In-stock marker changed'],
    ['disabledAddToCart', 'Add-to-cart disabled state changed'],
    ['likelyAvailable', 'Availability decision changed'],
    ['productId', 'Product ID changed'],
    ['variationId', 'Variation ID changed'],
  ];

  for (const [key, label] of checks) {
    if (stableStringify(previous[key]) !== stableStringify(current[key])) {
      findings.push(`${label}: ${previous[key]} -> ${current[key]}`);
    }
  }

  if (stableStringify(previous.purchaseLinks) !== stableStringify(current.purchaseLinks)) {
    findings.push('Purchase/ticket links changed');
  }

  return findings;
}

function buildReasons(previous, current) {
  const reasons = [];
  if (current.status < 200 || current.status >= 400) {
    reasons.push(`Page returned HTTP ${current.status}`);
  }
  if (current.finalUrl !== TICKET_URL) {
    reasons.push(`Final URL is ${current.finalUrl}`);
  }
  if (current.likelyAvailable) {
    reasons.push('Tickets look available');
  }
  if (previous?.outOfStock && !current.outOfStock) {
    reasons.push('The out-of-stock marker disappeared');
  }
  if (previous?.purchaseLinks && stableStringify(previous.purchaseLinks) !== stableStringify(current.purchaseLinks)) {
    reasons.push('Purchase/ticket links changed');
  }
  if (previous) {
    reasons.push(...diffSnapshots(previous, current));
  }
  if (!current.hasExpectedDate || !current.hasExpectedPrice || !current.hasExpectedTitle) {
    reasons.push('Expected event details changed or were not found');
  }
  return unique(reasons);
}

function createEmailTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendAlert(snapshot, reasons) {
  if (DRY_RUN) {
    console.log('DRY_RUN is enabled; skipping email notification.');
    return;
  }

  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    throw new Error('Email credentials missing. Set SMTP_USER, SMTP_PASS, and NOTIFY_EMAIL.');
  }

  const transporter = createEmailTransporter();
  const reasonItems = reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('');
  const linkItems = snapshot.purchaseLinks.length
    ? snapshot.purchaseLinks.map(link => `<li>${escapeHtml(link)}</li>`).join('')
    : '<li>No explicit external ticket link found yet.</li>';

  await transporter.sendMail({
    from: `"Neve Ticket Checker" <${SMTP_USER}>`,
    to: NOTIFY_EMAIL,
    subject: snapshot.likelyAvailable
      ? 'Neve Schechter tickets may be available'
      : 'Neve Schechter ticket page changed',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="margin-top:0;color:#1e4db7">Neve Schechter ticket monitor alert</h2>
        <p><a href="${escapeHtml(snapshot.finalUrl)}">Open ticket page</a></p>
        <h3>Why this alerted</h3>
        <ul>${reasonItems}</ul>
        <h3>Current signals</h3>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 0;color:#666">Title</td><td style="padding:6px 0;font-weight:600">${escapeHtml(snapshot.title)}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Out of stock</td><td style="padding:6px 0;font-weight:600">${snapshot.outOfStock}</td></tr>
          <tr><td style="padding:6px 0;color:#666">In stock</td><td style="padding:6px 0;font-weight:600">${snapshot.inStock}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Likely available</td><td style="padding:6px 0;font-weight:600">${snapshot.likelyAvailable}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Product ID</td><td style="padding:6px 0;font-weight:600">${escapeHtml(snapshot.productId)}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Variation ID</td><td style="padding:6px 0;font-weight:600">${escapeHtml(snapshot.variationId)}</td></tr>
        </table>
        <h3>Purchase links seen</h3>
        <ul>${linkItems}</ul>
      </div>
    `,
  });

  console.log(`Email sent to ${NOTIFY_EMAIL}`);
}

function shouldSendLifeSignal(state, now = new Date()) {
  if (!LIFE_SIGNAL_ENABLED) return false;

  const lastSentAt = state.lastLifeSignalAt ? Date.parse(state.lastLifeSignalAt) : NaN;
  if (!Number.isFinite(lastSentAt)) return true;

  const intervalMs = LIFE_SIGNAL_INTERVAL_HOURS * 60 * 60 * 1000;
  return now.getTime() - lastSentAt >= intervalMs;
}

async function sendLifeSignal(snapshot) {
  if (DRY_RUN) {
    console.log('DRY_RUN is enabled; skipping life signal email.');
    return;
  }

  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL) {
    throw new Error('Email credentials missing. Set SMTP_USER, SMTP_PASS, and NOTIFY_EMAIL.');
  }

  const transporter = createEmailTransporter();
  const linkItems = snapshot.purchaseLinks.length
    ? snapshot.purchaseLinks.map(link => `<li>${escapeHtml(link)}</li>`).join('')
    : '<li>No explicit external ticket link found yet.</li>';
  const statusText = snapshot.likelyAvailable
    ? 'Tickets may be available'
    : 'Still checking; tickets still look unavailable';

  await transporter.sendMail({
    from: `"Neve Ticket Checker" <${SMTP_USER}>`,
    to: NOTIFY_EMAIL,
    subject: `Neve ticket checker alive - ${statusText}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="margin-top:0;color:#1e4db7">Neve Schechter ticket monitor is running</h2>
        <p><a href="${escapeHtml(snapshot.finalUrl)}">Open ticket page</a></p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 0;color:#666">Checked at</td><td style="padding:6px 0;font-weight:600">${escapeHtml(snapshot.checkedAt)}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Title</td><td style="padding:6px 0;font-weight:600">${escapeHtml(snapshot.title)}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Out of stock</td><td style="padding:6px 0;font-weight:600">${snapshot.outOfStock}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Likely available</td><td style="padding:6px 0;font-weight:600">${snapshot.likelyAvailable}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Final URL</td><td style="padding:6px 0;font-weight:600">${escapeHtml(snapshot.finalUrl)}</td></tr>
        </table>
        <h3>Purchase links seen</h3>
        <ul>${linkItems}</ul>
      </div>
    `,
  });

  console.log(`Life signal email sent to ${NOTIFY_EMAIL}`);
}

async function fetchSnapshot() {
  const res = await fetch(TICKET_URL, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const html = await res.text();
  return parsePage(html, res.status, res.url);
}

(async () => {
  console.log('Neve Schechter Ticket Checker');
  console.log(new Date().toISOString());
  console.log(`Checking ${TICKET_URL}`);

  const missingConfig = [];
  if (!Number.isFinite(SMTP_PORT)) missingConfig.push('SMTP_PORT');
  if (!Number.isFinite(LIFE_SIGNAL_INTERVAL_HOURS) || LIFE_SIGNAL_INTERVAL_HOURS <= 0) {
    missingConfig.push('NEVE_LIFE_SIGNAL_INTERVAL_HOURS');
  }
  if (!DRY_RUN) {
    if (!SMTP_USER || SMTP_USER.includes('your.email')) missingConfig.push('SMTP_USER');
    if (!SMTP_PASS || SMTP_PASS.includes('your-16-char')) missingConfig.push('SMTP_PASS');
    if (!NOTIFY_EMAIL || NOTIFY_EMAIL.includes('recipient@example.com')) missingConfig.push('NOTIFY_EMAIL');
  }
  if (missingConfig.length) {
    throw new Error(`Missing required configuration: ${missingConfig.join(', ')}`);
  }

  const state = readState();
  const now = new Date();
  const previous = state.lastSignature || null;
  const snapshot = await fetchSnapshot();
  const currentSignature = signature(snapshot);
  const reasons = buildReasons(previous, snapshot);
  const firstRun = !previous;
  const firstRunProblem = firstRun && (
    snapshot.status < 200 ||
    snapshot.status >= 400 ||
    snapshot.finalUrl !== TICKET_URL ||
    !snapshot.hasExpectedTitle ||
    !snapshot.hasExpectedDate ||
    !snapshot.hasExpectedPrice
  );
  const shouldAlert = (
    snapshot.likelyAvailable ||
    firstRunProblem ||
    (!firstRun && reasons.length > 0) ||
    (firstRun && ALERT_ON_FIRST_RUN)
  );
  const alertKey = stableStringify({ likelyAvailable: snapshot.likelyAvailable, reasons, currentSignature });

  console.log(JSON.stringify(snapshot, null, 2));

  const stateUpdates = {
    lastSignature: currentSignature,
    lastCheckedAt: snapshot.checkedAt,
  };

  if (shouldAlert && state.lastAlertKey !== alertKey) {
    console.log(`Alert condition matched: ${reasons.join('; ') || 'first run requested'}`);
    await sendAlert(snapshot, reasons.length ? reasons : ['First run alert requested']);
    Object.assign(stateUpdates, {
      lastAlertKey: alertKey,
      lastAlertedAt: now.toISOString(),
      lastLifeSignalAt: now.toISOString(),
    });
  } else {
    console.log(firstRun
      ? 'Baseline saved; no alert because tickets still look unavailable.'
      : 'No material ticket-page change detected.');

    if (shouldSendLifeSignal(state, now)) {
      await sendLifeSignal(snapshot);
      stateUpdates.lastLifeSignalAt = now.toISOString();
    } else if (LIFE_SIGNAL_ENABLED) {
      console.log(`Life signal is enabled every ${LIFE_SIGNAL_INTERVAL_HOURS} hour(s); not due yet.`);
    }
  }

  writeState(stateUpdates);
})().catch(err => {
  console.error('Error during execution:', err.message || err);
  process.exit(1);
});
