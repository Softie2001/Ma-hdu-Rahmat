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
