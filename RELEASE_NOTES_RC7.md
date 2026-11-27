# Sharda Library RC.7 – Membership Expiry Actions

## Added
- Both **Overdue Students** and **Expires Today** lists provide **Renew Membership** and **End Membership** actions.
- Renewal asks the admin to confirm payment, records the current payment month/date, extends the due date by one month, and retains the existing seat. This is available when the due date is today or earlier.
- Ending membership asks for explicit confirmation, marks the student as `Completed`, records the end timestamp, releases the seat, and preserves the student record in Former Student History. This is available when the due date is today or earlier.
- Expired/overdue seat holders cannot be unassigned from the Seats modal; the admin must renew or end the membership from Membership Expiry.
- Non-overdue active memberships retain the existing seat-unassignment action, with a confirmation prompt.

## Data and compatibility
- Uses the existing student JSON payload fields and existing authenticated `/api/data` persistence flow.
- No database migration is required.
- No existing student records are intentionally deleted.

## Test notes
- Run `npm.cmd run test:api` from the project folder.
- This release has not yet been tested against the user's live Supabase data; test first with a disposable student record.
