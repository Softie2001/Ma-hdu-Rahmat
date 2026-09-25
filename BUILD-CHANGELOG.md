# Ma’hdu Rahmat — Next Build

## Implemented in this build
- Applicant admission approval no longer immediately creates a matric number.
- Admin action changed from “Approve & Issue Matric No.” to “Approve Admission”.
- Approved applicants now receive a “Generate Matric Number” workflow in their Applicant Portal.
- Permanent matric numbers use the MDU/{YY}/{STAGE}/{####} format already established in the project.
- Added Firestore transaction support for atomic matric sequence allocation.
- Matric generation is atomic across the applicant record, sequence record, and student record.
- Once generated, the matric number is stored on the applicant and remains available when they return later.
- Student record is created automatically when the applicant generates the matric number.
- Existing older applicants with an already-issued matric number remain supported.

## Important
This is an incremental workflow foundation. Application-fee payment verification/exemption and full Bursar finance separation are not silently fabricated here; those remain the next finance workflow work.

- Connected the browser configuration to the user's Supabase project `ppykmtroiyihoxwxqecn`.
- Kept the Supabase publishable key only; no secret/service-role key was added.
- Firebase has NOT been deleted or retired yet.


## Supabase browser initialization fix — 2026-09-24
- Removed the ES-module import from `supabase-init.js` so the build can initialize reliably from the normal browser script loader/local development environment.
- The existing Supabase UMD browser library loaded by each page is now used via `window.supabase.createClient`.
- Converted all page references to `supabase-init.js` from `type=module` to a normal script.
- Added a 12-second initialization timeout to prevent registration/login from remaining on an endless spinner when the Supabase library fails to load.
- Firebase remains untouched.


## 2026-09-25 — Browser SDK loading fix
- Changed the Supabase CDN include from the package root to the explicit UMD browser build (`dist/umd/supabase.min.js`).
- Added a cache-busting version to `supabase-init.js` references so GitHub/browser caches do not keep the broken initializer.
- Firebase remains untouched.
