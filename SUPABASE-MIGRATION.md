# Ma'hdu Rahmat — Firebase → Supabase migration

## Current state

This build removes the Firebase SDK from the website and introduces a Supabase/PostgreSQL adapter. The existing portal UI is intentionally kept mostly intact while the data layer is migrated.

## 1. Create a NEW Supabase project

Do not delete the Firebase project yet.

In Supabase:

1. Create a new project for Ma'hdu Rahmat.
2. Open **SQL Editor**.
3. Run `supabase-schema.sql` completely.
4. Open **Settings → API Keys** and copy the project URL and publishable key.
5. Put those two values in `supabase-config.js`.

Never put a `service_role` key in browser code.

## 2. Authentication setting for this migration build

The current legacy portal assumes that a newly registered user receives an authenticated session immediately. For the first migration test, keep email confirmation disabled in Supabase Auth so the existing registration flow can complete.

We will later add the proper email-confirmation workflow rather than leaving this as a production shortcut.

## 3. Edge Function

Deploy:

`supabase/functions/create-staff-account/index.ts`

This function is required because creating another user's Auth account must happen server-side with the Supabase service-role key. The service-role key must never be exposed to the browser.

## 4. Test in this order

1. Create the first Administrator through `register.html?role=admin`.
2. Confirm the user appears in Supabase Auth and `public.users` with role `admin`.
3. Log in as Administrator.
4. Create an academic session.
5. Submit a test applicant.
6. Approve the applicant.
7. Applicant generates an MDU matric number.
8. Activate the Student account.
9. Test Parent registration.
10. Submit a staff access request.
11. Approve it from Admin and verify the Edge Function creates the staff account.
12. Test announcements.
13. Test payments with Admin/Bursar permissions.

## 5. Firebase cleanup

Only after all tests pass should Firebase data be deleted and the old Firebase project/config be retired.

Do not delete Firebase first. The old project is the fallback until Supabase is verified.
