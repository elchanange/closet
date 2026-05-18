#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

const missingConfig = [];
if (!Number.isFinite(SMTP_PORT)) missingConfig.push('SMTP_PORT');
if (!SMTP_USER || SMTP_USER.includes('your.email')) missingConfig.push('SMTP_USER');
if (!SMTP_PASS || SMTP_PASS.includes('your-16-char')) missingConfig.push('SMTP_PASS');
if (!NOTIFY_EMAIL || NOTIFY_EMAIL.includes('recipient@example.com')) missingConfig.push('NOTIFY_EMAIL');

if (missingConfig.length) {
  console.error(`Missing required email configuration: ${missingConfig.join(', ')}`);
  process.exit(1);
}

(async () => {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.verify();
  await transporter.sendMail({
    from: `"Chili Slot Checker" <${SMTP_USER}>`,
    to: NOTIFY_EMAIL,
    subject: 'Chili Slot Checker email test',
    text: 'Email alerts are configured correctly.',
  });

  console.log(`Test email sent to ${NOTIFY_EMAIL}`);
})().catch(err => {
  console.error('Email test failed:', err.message || err);
  process.exit(1);
});

