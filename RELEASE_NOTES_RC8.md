# Sharda Library RC.8 – Email OTP

## Added
- Forgot-password and change-password OTP can now be delivered by email (SMTP via nodemailer). This is the default (`OTP_CHANNEL=email`).
- `ADMIN_EMAIL` env var holds the recovery email. For RC8.1 Vercel/serverless persistence, also apply migration `002_serverless_state.sql`.
- `/api/health` now reports `otpChannel`; the admin UI adapts its labels automatically.
- MSG91 SMS OTP is unchanged and available with `OTP_CHANNEL=sms`.

## Notes
- Forgot-password requests now send `contact` (email or mobile). `email`/`mobile` keys are still accepted.
- Email resend issues a new code and invalidates the previous one.
- Real email delivery has not been tested against your SMTP account; test once with your Gmail App Password.
