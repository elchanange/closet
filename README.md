# Chili Slot Checker

Checks the Chili delivery coordination page and sends an email when an earlier delivery slot appears.

## Local Setup

1. Install dependencies:

   ```powershell
   npm ci
   ```

2. Fill the local environment file:

   ```powershell
   notepad .env
   ```

3. Run one check:

   ```powershell
   npm run check
   ```

4. Test only the email settings:

   ```powershell
   npm run test-email
   ```

## Required Values

`TRACKING_URL`

The full Chili delivery coordination URL. Get it from the SMS, WhatsApp message, or email Chili sent for coordinating the delivery. Open that link in your browser, then copy the full address from the browser address bar. It should look like:

```env
TRACKING_URL=https://web.chili.co.il/deliveryzCoordinateApp/app/...
```

Do not trim the token at the end of the URL.

`SMTP_USER`

The email address that will send alerts. For Gmail, this is your Gmail address.

```env
SMTP_USER=your.email@gmail.com
```

`SMTP_PASS`

For Gmail, use a Google App Password, not your normal Google password. Google says app passwords are 16-digit passcodes and require 2-Step Verification to be enabled.

Create one from your Google Account security settings, then paste the generated 16-character password here without spaces:

```env
SMTP_PASS=abcdefghijklmnop
```

Google help: https://support.google.com/mail/answer/185833

`NOTIFY_EMAIL`

The destination email address for alerts. It can be the same as `SMTP_USER`.

```env
NOTIFY_EMAIL=your.email@gmail.com
```

`SMTP_HOST` and `SMTP_PORT`

For Gmail, keep the defaults:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
```

`DRY_RUN`

Keep this enabled while testing the Chili page before email is configured:

```env
DRY_RUN=true
```

Set it to `false` after `npm run test-email` succeeds.

## Daily Life Signal

The checker can send one daily status email from the run that lands in the `10:00` to `10:14` Israel-time window. Keep these values:

```env
LIFE_SIGNAL_ENABLED=true
LIFE_SIGNAL_TZ=Asia/Jerusalem
LIFE_SIGNAL_HOUR=10
LIFE_SIGNAL_MINUTE=0
LIFE_SIGNAL_WINDOW_MINUTES=15
LIFE_SIGNAL_FORCE=false
```

The daily life signal is sent during that window even if the same run also finds an earlier slot. It reports how many earlier dates were found, not just how many calendar cells were parsed.

To test the life signal manually from GitHub Actions, run the workflow with the `life_signal` input enabled.

## Scan Window

Each browser run scans available calendar dates from the run's current Israel-time date through the current scheduled delivery date. It does not scan dates after the scheduled delivery date, because those are not sooner.

## GitHub Actions Setup

The workflow in `.github/workflows/check-slots.yml` runs every 30 minutes at `:07` and `:37`, and can also be started manually.

In the GitHub repository, add these repository secrets:

- `TRACKING_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `NOTIFY_EMAIL`

GitHub path: repository `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`.

GitHub docs: https://docs.github.com/actions/reference/encrypted-secrets?tool=webui
