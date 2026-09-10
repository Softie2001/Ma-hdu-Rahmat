(function () {
  'use strict';

  /* ===================================================================
     FIREBASE-BACKED STORAGE + REAL AUTHENTICATION
     Every account (applicant, student, parent, staff, admin) is a real
     Firebase Authentication user. Their profile data lives in Firestore
     in a document whose ID is their real Auth UID — this is what lets
     the security rules verify "is this really you" instead of trusting
     the client.

     Students log in with a matric number, not an email — Firebase Auth
     requires an email format, so a matric number is silently converted
     to an internal email behind the scenes (e.g.
     "MDU/26/IDD/0001" -> "mdu-26-idd-0001@student.mrip.internal").
     The student never sees this; they only ever type their matric
     number.
  =================================================================== */

  function waitForDb() {
    return new Promise(function (resolve) {
      if (window.mripDb && window.mripAuth) { resolve(); return; }
      window.addEventListener('mripDbReady', function handler() {
        window.removeEventListener('mripDbReady', handler);
        resolve();
      });
    });
  }

  function matricToInternalEmail(matric) {
    var clean = matric.trim().toUpperCase().replace(/[^A-Z0-9]/g, '-');
    return clean + '@student.mrip.internal';
  }

  function genRef() {
    return 'MDU-APP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  function genTempPassword() {
    return 'Mrip-' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 100);
  }

  /* ---------- generic Firestore helpers ---------- */
  function fsGetAll(colName) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      return fb.getDocs(fb.collection(fb.db, colName)).then(function (snap) {
        var out = [];
        snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
        return out;
      });
    });
  }
  function fsQueryEq(colName, field, value) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      var q = fb.query(fb.collection(fb.db, colName), fb.where(field, '==', value));
      return fb.getDocs(q).then(function (snap) {
        var out = [];
        snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
        return out;
      });
    });
  }
  function fsAdd(colName, data) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      return fb.addDoc(fb.collection(fb.db, colName), data).then(function (ref) { return ref.id; });
    });
  }
  function fsUpdate(colName, docId, data) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      return fb.updateDoc(fb.doc(fb.db, colName, docId), data);
    });
  }
  function fsSetDoc(colName, docId, data) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      return fb.setDoc(fb.doc(fb.db, colName, docId), data);
    });
  }
  function fsGetDoc(colName, docId) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      return fb.getDoc(fb.doc(fb.db, colName, docId)).then(function (snap) {
        return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
      });
    });
  }
  function fsDelete(colName, docId) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      return fb.deleteDoc(fb.doc(fb.db, colName, docId));
    });
  }

  function uploadApplicantReceipt(uid, file) {
    var allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!file || !file.size) return Promise.reject(new Error('A payment receipt is required.'));
    if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error('The receipt must be 10 MB or smaller.'));
    if (allowedTypes.indexOf(file.type) === -1) return Promise.reject(new Error('Upload a PDF, JPG, PNG, or WEBP receipt.'));
    return waitForDb().then(function () {
      var fb = window.mripDb;
      var extension = (file.name.split('.').pop() || 'file').toLowerCase().replace(/[^a-z0-9]/g, '');
      var path = 'applicantReceipts/' + uid + '/' + Date.now() + '.' + extension;
      var ref = fb.storageRef(fb.storage, path);
      return fb.uploadBytes(ref, file, { contentType: file.type }).then(function () {
        return { path: path, name: file.name, contentType: file.type, size: file.size };
      });
    });
  }

  function isFinanceCleared(applicant) {
    return applicant.applicationFeeStatus === 'Payment Verified' ||
      applicant.applicationFeeStatus === 'Fee Exempt' ||
      applicant.status === 'Verified'; // compatibility with existing reviewed records
  }

  function reviewApplicantFinance(applicant, decision, reviewer, note) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      var applicantRef = fb.doc(fb.db, 'applicants', applicant.id);
      var paymentRef = fb.doc(fb.collection(fb.db, 'payments'));
      var now = new Date().toISOString();
      return fb.runTransaction(fb.db, function (transaction) {
        return transaction.get(applicantRef).then(function (snap) {
          if (!snap.exists()) throw new Error('The applicant record no longer exists.');
          var current = snap.data();
          if (isFinanceCleared(current)) throw new Error('This finance review has already been completed.');
          var update = {
            applicationFeeStatus: decision === 'verify' ? 'Payment Verified' : decision === 'exempt' ? 'Fee Exempt' : 'Payment Rejected',
            financeReviewedAt: now,
            financeReviewedBy: reviewer,
            financeReviewNote: note || ''
          };
          transaction.update(applicantRef, update);
          if (decision === 'verify') {
            transaction.set(paymentRef, {
              applicantId: applicant.id,
              studentMatric: '',
              studentName: applicant.fullName,
              classLabel: applicant.classLabel || '',
              paymentType: 'Application Fee',
              description: 'Verified application fee',
              amount: 10000,
              currency: 'NGN',
              paymentDate: applicant.submittedAt || now,
              reference: applicant.paymentReference || applicant.ref || '',
              status: 'Verified',
              receiptPath: applicant.paymentEvidence && applicant.paymentEvidence.path || '',
              recordedBy: reviewer,
              recordedAt: now
            });
          }
        });
      });
    });
  }

  // Atomic sequence allocation for permanent matric numbers.
  // The sequence document is updated in a Firestore transaction so two
  // applicants generating a matric number at the same time cannot receive
  // the same number.
  function allocateMatricNumber(year, section) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      var sequenceId = String(year) + '_' + String(section).toUpperCase();
      var sequenceRef = fb.doc(fb.db, 'matricSequences', sequenceId);

      return fb.runTransaction(fb.db, function (transaction) {
        return transaction.get(sequenceRef).then(function (snap) {
          var nextNumber = 1;
          if (snap.exists()) {
            var current = Number(snap.data().lastNumber || 0);
            nextNumber = current + 1;
          }
          transaction.set(sequenceRef, {
            year: String(year),
            section: String(section).toUpperCase(),
            lastNumber: nextNumber,
            updatedAt: new Date().toISOString()
          }, { merge: true });
          return nextNumber;
        });
      }).then(function (nextNumber) {
        return 'MDU/' + year + '/' + String(section).toUpperCase() + '/' + String(nextNumber).padStart(4, '0');
      });
    });
  }

  function generateMatricForApplicant(applicant) {
    return waitForDb().then(function () {
      var fb = window.mripDb;
      var applicantRef = fb.doc(fb.db, 'applicants', applicant.id);
      var year = String(applicant.matricYear || new Date().getFullYear().toString().slice(-2));
      var section = String(applicant.matricSection || SECTION_MAP[applicant.classApplied] || 'IDD').toUpperCase();
      var sequenceRef = fb.doc(fb.db, 'matricSequences', year + '_' + section);
      var studentRef = fb.doc(fb.collection(fb.db, 'students'));

      return fb.runTransaction(fb.db, function (transaction) {
        return transaction.get(applicantRef).then(function (applicantSnap) {
          if (!applicantSnap.exists()) throw new Error('Applicant record could not be found.');
          var current = applicantSnap.data();

          if (current.matric) return current.matric;

          if (current.status !== 'Admission Approved' && current.admissionStatus !== 'Approved') {
            throw new Error('Admission has not been approved yet.');
          }

          return transaction.get(sequenceRef).then(function (sequenceSnap) {
            var nextNumber = sequenceSnap.exists()
              ? Number(sequenceSnap.data().lastNumber || 0) + 1
              : 1;
            var matric = 'MDU/' + year + '/' + section + '/' + String(nextNumber).padStart(4, '0');

            transaction.set(sequenceRef, {
              year: year,
              section: section,
              lastNumber: nextNumber,
              updatedAt: new Date().toISOString()
            }, { merge: true });

            transaction.set(studentRef, {
              matric: matric,
              fullName: current.fullName,
              arabicName: current.arabicName || '',
              email: current.email || '',
              phone: current.phone || '',
              classLabel: current.classLabel || '',
              classCode: current.classApplied || '',
              matricSection: section,
              matricYear: year,
              currentSessionId: null,
              promotionDecision: null,
              sessionHistory: [],
              applicantUid: current.uid || applicant.id,
              issuedAt: new Date().toISOString()
            });

            transaction.update(applicantRef, {
              status: 'Matric Issued',
              matric: matric,
              matricIssuedAt: new Date().toISOString(),
              studentRecordId: studentRef.id
            });

            return matric;
          });
        });
      });
    });
  }

  var SECTION_MAP = { AwwalIdadi: 'IDD', ThaniIdadi: 'IDD', ThalithIdadi: 'IDD', RabiIdadi: 'IDD', ThanawiAwwal: 'THN', ThanawiThani: 'THN', ThanawiThalith: 'THN' };

  // Real subject curriculum per class level. The three Secondary years
  // share one combined curriculum, per the school's structure.
  var CLASS_SUBJECTS = {
    AwwalIdadi: ['الإملاء', 'الفقه الإسلامي', 'الأنشودة', 'الحديث', 'المحفوظات', 'العربية', 'الأخلاق', 'التوحيد', 'المطالعة', 'القرآن المجود', 'السيرة النبوية', 'التهجئة', 'الحساب', 'القراءة الببغاوية', 'الكتابة / الحط العربي', 'حفظ القرآن', 'القراءة'],
    ThaniIdadi: ['الفقه الإسلامي', 'التجويد', 'النحو', 'العربية', 'الأخلاق', 'الحديث', 'السيرة النبوية', 'المحفوظات', 'حفظ القرآن', 'التوحيد', 'الإنشاء', 'القراءة', 'القرآن المجود', 'الإملاء', 'الثقافة الإسلامية', 'التهذيب', 'المطالعة', 'القراءة العربية'],
    ThalithIdadi: ['النحو', 'المحفوظات', 'الإنشاء', 'حفظ القرآن', 'السيرة النبوية', 'التجويد', 'الصرف', 'التوحيد', 'تفسير القرآن', 'الفقه الإسلامي', 'العربية', 'الحديث', 'العلوم', 'الأخلاق', 'التهذيب', 'الإملاء', 'القرآن المجود', 'المطالعة', 'القراءة / الكتابة'],
    RabiIdadi: ['الحديث', 'النحو', 'المحفوظات', 'الفقه الإسلامي', 'الصرف', 'السيرة النبوية', 'العربية', 'التوحيد', 'التهذيب', 'تفسير القرآن', 'التجويد', 'القرآن المجود', 'الثقافة الإسلامية', 'المطالعة', 'أصول الحديث', 'العلوم', 'القراءة', 'حفظ القرآن', 'الإنشاء', 'الإملاء'],
    ThanawiAwwal: ['الصرف', 'الفقه الإسلامي', 'أصول التفسير', 'المطالعة', 'علم العروض', 'التوحيد', 'أصول الحديث', 'تفسير القرآن', 'النحو', 'الأدب العربي', 'الدعوة', 'التأريخ التشريعي', 'المنطق', 'الحديث', 'التأريخ الإسلامي', 'فقه اللغة', 'حفظ القرآن', 'الجغرافيا', 'الفكر الإسلامي', 'البلاغة', 'التعبير', 'أصول الفقه', 'علم الفرائض'],
    ThanawiThani: ['الصرف', 'الفقه الإسلامي', 'أصول التفسير', 'المطالعة', 'علم العروض', 'التوحيد', 'أصول الحديث', 'تفسير القرآن', 'النحو', 'الأدب العربي', 'الدعوة', 'التأريخ التشريعي', 'المنطق', 'الحديث', 'التأريخ الإسلامي', 'فقه اللغة', 'حفظ القرآن', 'الجغرافيا', 'الفكر الإسلامي', 'البلاغة', 'التعبير', 'أصول الفقه', 'علم الفرائض'],
    ThanawiThalith: ['الصرف', 'الفقه الإسلامي', 'أصول التفسير', 'المطالعة', 'علم العروض', 'التوحيد', 'أصول الحديث', 'تفسير القرآن', 'النحو', 'الأدب العربي', 'الدعوة', 'التأريخ التشريعي', 'المنطق', 'الحديث', 'التأريخ الإسلامي', 'فقه اللغة', 'حفظ القرآن', 'الجغرافيا', 'الفكر الإسلامي', 'البلاغة', 'التعبير', 'أصول الفقه', 'علم الفرائض']
  };

  function ensureSeedStudents() {
    return fsGetAll('students').then(function (list) {
      if (list.length > 0) return;
      var demo = [
        { matric: 'MDU/26/IDD/0001', fullName: 'Demo Student One', classLabel: 'الصف الثاني الإعدادي — Second Preparatory', classCode: 'ThaniIdadi' },
        { matric: 'MDU/26/THN/0001', fullName: 'Demo Student Two', classLabel: 'الصف الأول الثانوي — First Secondary', classCode: 'ThanawiAwwal' }
      ];
      return Promise.all(demo.map(function (s) { return fsAdd('students', s); }));
    }).catch(function () { /* ignore seed errors */ });
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = busyLabel || 'Please wait…';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      button.disabled = false;
    }
  }

  function friendlyAuthError(err) {
    var code = err && err.code ? err.code : '';
    if (code === 'auth/email-already-in-use') return 'An account with this email already exists. Try logging in instead.';
    if (code === 'auth/weak-password') return 'Password is too weak — use at least 8 characters.';
    if (code === 'auth/invalid-email') return 'That email address looks invalid.';
    if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') return 'Incorrect email/matric number or password.';
    if (code === 'auth/too-many-requests') return 'Too many attempts — please wait a moment and try again.';
    if (code === 'auth/network-request-failed') return 'Could not reach the server. Check your connection and try again.';
    return (err && err.message) ? err.message : 'Something went wrong. Please try again.';
  }

  /* ===================================================================
     ANNOUNCEMENTS — shared helpers used by both the Admin Communication
     Center and every role's dashboard feed.
  =================================================================== */
  var ANN_MAX_ATTACHMENT_BYTES = 700 * 1024; // stay well under Firestore's 1MB per-document limit

  // Status is never flipped by a background job (no server to run one) —
  // instead it's always computed live from the stored dates, so
  // "automatic" publish/expiry just falls out of this function.
  function getEffectiveStatus(a) {
    var now = new Date();
    if (a.status === 'draft') return 'draft';
    if (a.expiryDate && new Date(a.expiryDate) <= now) return 'archived';
    if (a.status === 'archived') return 'archived';
    if (a.scheduledDate && new Date(a.scheduledDate) > now) return 'scheduled';
    return 'published';
  }

  var AUDIENCE_ROLE_MAP = {
    applicant: 'applicants', student: 'students', parent: 'parents',
    teacher: 'staff', classteacher: 'staff', bursar: 'staff', examofficer: 'staff', admin: 'staff'
  };

  function announcementMatchesUser(a, role, classCode) {
    var aud = a.audience || [];
    if (aud.indexOf('everyone') > -1) {
      // still respect a class filter if one is set and this user is a student
      if (role === 'student' && a.classFilter && a.classFilter.length && classCode) {
        return a.classFilter.indexOf(classCode) > -1;
      }
      return true;
    }
    var myAudienceKey = AUDIENCE_ROLE_MAP[role];
    if (aud.indexOf(myAudienceKey) === -1) return false;
    if (role === 'student' && a.classFilter && a.classFilter.length && classCode) {
      return a.classFilter.indexOf(classCode) > -1;
    }
    return true;
  }

  function stripHtml(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || tmp.innerText || '').trim();
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  /* ===================================================================
     APPLY PAGE — Applicant self-registration via real Firebase Auth
  =================================================================== */
  var applyForm = document.getElementById('applyForm');
  if (applyForm) {
    var STEP_COUNT = 5;
    var currentStep = 1;
    var stepEls = document.querySelectorAll('.apply-step');
    var panelEls = document.querySelectorAll('.apply-panel[data-panel]');

    var previousYearSelect = document.getElementById('previousYearSelect');
    if (previousYearSelect) {
      var thisYear = new Date().getFullYear();
      for (var y = thisYear; y >= thisYear - 19; y--) {
        var opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        previousYearSelect.appendChild(opt);
      }
    }

    function showStep(n) {
      currentStep = n;
      panelEls.forEach(function (p) {
        p.classList.toggle('is-active', Number(p.getAttribute('data-panel')) === n);
      });
      stepEls.forEach(function (s) {
        var stepNum = Number(s.getAttribute('data-step'));
        s.classList.toggle('is-active', stepNum === n);
        s.classList.toggle('is-done', stepNum < n);
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (n === 5) buildReview();
    }

    function currentPanel() {
      return document.querySelector('.apply-panel[data-panel="' + currentStep + '"]');
    }

    function validatePanel(panel) {
      var valid = true;
      var fields = panel.querySelectorAll('input[required], select[required]');
      fields.forEach(function (f) {
        var errorEl = f.closest('.field') ? f.closest('.field').querySelector('.field-error') : null;
        var msg = '';
        if (f.type === 'checkbox') {
          if (!f.checked) { msg = 'This is required.'; }
        } else if (f.type === 'radio') {
          // validated as a group elsewhere
        } else if (!f.value || !f.value.trim()) {
          msg = 'This field is required.';
        } else if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value)) {
          msg = 'Enter a valid email address.';
        } else if (f.name === 'password' && f.value.length < 8) {
          msg = 'Password must be at least 8 characters.';
        } else if (f.name === 'confirmPassword') {
          var pw = panel.querySelector('input[name="password"]');
          if (pw && f.value !== pw.value) { msg = 'Passwords do not match.'; }
        }
        if (msg) {
          valid = false;
          f.classList.add('has-error');
          if (errorEl) errorEl.textContent = msg;
        } else {
          f.classList.remove('has-error');
          if (errorEl) errorEl.textContent = '';
        }
      });
      return valid;
    }

    document.querySelectorAll('[data-next]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panel = currentPanel();
        if (!validatePanel(panel)) return;
        if (currentStep < STEP_COUNT) showStep(currentStep + 1);
      });
    });
    document.querySelectorAll('[data-prev]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (currentStep > 1) showStep(currentStep - 1);
      });
    });

    var existingRadios = applyForm.querySelectorAll('input[name="existingStudent"]');
    var existingBlock = document.getElementById('existingStudentBlock');
    existingRadios.forEach(function (r) {
      r.addEventListener('change', function () {
        existingBlock.classList.toggle('is-shown', r.value === 'yes' && r.checked);
      });
    });

    var feeRouteChoices = applyForm.querySelectorAll('input[name="feeRoute"]');
    var paymentEvidenceFields = document.getElementById('paymentEvidenceFields');
    var exemptionReasonField = document.getElementById('exemptionReasonField');
    var receiptInput = applyForm.querySelector('input[name="receipt"]');
    var exemptionReasonInput = applyForm.querySelector('textarea[name="exemptionReason"]');
    function applyFeeRoute(route) {
      var isExemption = route === 'exemption';
      paymentEvidenceFields.style.display = isExemption ? 'none' : '';
      exemptionReasonField.style.display = isExemption ? '' : 'none';
      receiptInput.required = !isExemption;
      exemptionReasonInput.required = isExemption;
    }
    feeRouteChoices.forEach(function (choice) {
      choice.addEventListener('change', function () { applyFeeRoute(choice.value); });
    });
    applyFeeRoute('payment');

    function buildReview() {
      var grid = document.getElementById('reviewGrid');
      var fd = new FormData(applyForm);
      var classSelect = document.getElementById('classApplied');
      var classLabel = classSelect.options[classSelect.selectedIndex] ? classSelect.options[classSelect.selectedIndex].text : '—';
      var rows = [
        ['Full Name', fd.get('fullName')],
        ['Email', fd.get('email')],
        ['Phone', fd.get('phone')],
        ['Gender', fd.get('gender')],
        ['Date of Birth', fd.get('dob')],
        ['Address', fd.get('address')],
        ["Father's Name", fd.get('fatherName') || '—'],
        ["Guardian Phone", fd.get('guardianPhone')],
        ['Class Applying For', classLabel],
        ['Previously Enrolled?', fd.get('existingStudent') === 'yes' ? 'Yes' : 'No']
      ];
      grid.innerHTML = rows.map(function (r) {
        return '<div class="review-item"><dt>' + r[0] + '</dt><dd>' + (r[1] || '—') + '</dd></div>';
      }).join('');
    }

    applyForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var panel = currentPanel();
      if (!validatePanel(panel)) return;

      var submitBtn = panel.querySelector('button[type="submit"]');
      setBusy(submitBtn, true, 'Creating your account…');

      var fd = new FormData(applyForm);
      var classSelect = document.getElementById('classApplied');
      var selectedOption = classSelect.options[classSelect.selectedIndex];
      var section = selectedOption ? selectedOption.getAttribute('data-section') : 'IDD';
      var year = new Date().getFullYear();
      var email = fd.get('email').trim();
      var password = fd.get('password');
      var feeRoute = fd.get('feeRoute');
      var receiptFile = fd.get('receipt');

      waitForDb().then(function () {
        var fa = window.mripAuth;
        return fa.createUserWithEmailAndPassword(fa.auth, email, password);
      }).then(function (cred) {
        var uid = cred.user.uid;
        var paymentEvidence = feeRoute === 'payment'
          ? uploadApplicantReceipt(uid, receiptFile)
          : Promise.resolve(null);
        return paymentEvidence.then(function (evidence) {
        var record = {
          uid: uid,
          ref: genRef(),
          fullName: fd.get('fullName'),
          email: email,
          phone: fd.get('phone'),
          arabicName: fd.get('arabicName') || '',
          gender: fd.get('gender'),
          dob: fd.get('dob'),
          address: fd.get('address'),
          fatherName: fd.get('fatherName') || '',
          motherName: fd.get('motherName') || '',
          guardianPhone: fd.get('guardianPhone'),
          classApplied: fd.get('classApplied'),
          classLabel: selectedOption ? selectedOption.text : '',
          existingStudent: fd.get('existingStudent'),
          matricSection: section,
          matricYear: String(year).slice(-2),
          status: 'Pending Verification',
          applicationFeeStatus: feeRoute === 'payment' ? 'Payment Submitted' : 'Fee Exemption Requested',
          paymentEvidence: evidence,
          paymentReference: feeRoute === 'payment' ? (fd.get('txRef') || '').trim() : '',
          exemptionReason: feeRoute === 'exemption' ? (fd.get('exemptionReason') || '').trim() : '',
          financeReviewedAt: null,
          financeReviewedBy: null,
          submittedAt: new Date().toISOString()
        };
        return fsSetDoc('applicants', uid, record).then(function () { return record; });
        });
      }).then(function (record) {
        document.getElementById('successRef').textContent = 'Reference: ' + record.ref;
        panelEls.forEach(function (p) { p.classList.remove('is-active'); });
        document.getElementById('applySteps').style.display = 'none';
        document.getElementById('successPanel').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(function (err) {
        setBusy(submitBtn, false);
        var emailField = panel.querySelector('input[name="email"]');
        if (err.code === 'auth/email-already-in-use' && emailField) {
          showStep(1);
          emailField.classList.add('has-error');
          var box = emailField.closest('.field').querySelector('.field-error');
          if (box) box.textContent = 'An account with this email already exists. Try logging in instead.';
        } else {
          alert(friendlyAuthError(err));
        }
      });
    });

    showStep(1);
  }

  /* ===================================================================
     LOGIN PAGE — real Firebase Authentication sign-in
  =================================================================== */
  var loginForm = document.getElementById('loginForm');
  if (loginForm) {
    var roleTabs = document.querySelectorAll('.role-tab');
    var selectedRole = 'applicant';
    var loginIdLabel = document.getElementById('loginIdLabel');
    var loginIdInput = document.getElementById('loginIdInput');
    var roleHint = document.getElementById('roleHint');
    var loginFooter = document.getElementById('loginFooter');

    var ROLE_CONFIG = {
      applicant: { idLabel: 'Email Address', idType: 'email', hint: "Log in with the email and password you used to register your applicant account.", footer: 'New applicant? <a href="apply.html">Start your application</a>' },
      student: { idLabel: 'Matric Number', idType: 'text', hint: 'Students log in with their permanent matric number (e.g. MDU/26/IDD/0001), issued after admission approval.', footer: "Haven't activated your account? <a href=\"register.html?role=student\">Activate it here</a>" },
      parent: { idLabel: 'Email Address', idType: 'email', hint: "Log in with the email and password you used when registering as a parent.", footer: 'New parent account? <a href="register.html?role=parent">Register here</a>' },
      teacher: { idLabel: 'Email Address', idType: 'email', hint: 'Teacher accounts are issued by the Administrator — you cannot self-register.', footer: "Don't have an account? <a href=\"register.html?role=teacher\">Request access</a>" },
      classteacher: { idLabel: 'Email Address', idType: 'email', hint: 'Class Teacher accounts are issued by the Administrator — you cannot self-register.', footer: "Don't have an account? <a href=\"register.html?role=classteacher\">Request access</a>" },
      bursar: { idLabel: 'Email Address', idType: 'email', hint: 'Bursar accounts are issued by the Super Administrator.', footer: "Don't have an account? <a href=\"register.html?role=bursar\">Request access</a>" },
      examofficer: { idLabel: 'Email Address', idType: 'email', hint: 'Examination Officer accounts are issued by the Administrator — you cannot self-register.', footer: "Don't have an account? <a href=\"register.html?role=examofficer\">Request access</a>" },
      admin: { idLabel: 'Email Address', idType: 'email', hint: 'Administrator accounts are issued by the Super Administrator.', footer: "Don't have an account? <a href=\"register.html?role=admin\">Request access</a>" }
    };

    function applyRole(role) {
      selectedRole = role;
      roleTabs.forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-role') === role); });
      var cfg = ROLE_CONFIG[role];
      loginIdLabel.textContent = cfg.idLabel;
      loginIdInput.type = cfg.idType;
      roleHint.textContent = cfg.hint;
      loginFooter.innerHTML = cfg.footer;
      document.getElementById('loginError').classList.remove('is-shown');
    }

    roleTabs.forEach(function (tab) {
      tab.addEventListener('click', function () { applyRole(tab.getAttribute('data-role')); });
    });

    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(loginForm);
      var loginId = (fd.get('loginId') || '').trim();
      var password = fd.get('password') || '';
      var errorBox = document.getElementById('loginError');
      errorBox.classList.remove('is-shown');

      if (!loginId || !password) {
        errorBox.textContent = 'Please enter your credentials.';
        errorBox.classList.add('is-shown');
        return;
      }

      var submitBtn = loginForm.querySelector('button[type="submit"]');
      setBusy(submitBtn, true, 'Signing in…');

      var emailToUse = selectedRole === 'student' ? matricToInternalEmail(loginId) : loginId;

      waitForDb().then(function () {
        var fa = window.mripAuth;
        return fa.signInWithEmailAndPassword(fa.auth, emailToUse, password);
      }).then(function () {
        try { localStorage.setItem('mrip_role_hint', selectedRole); } catch (err) { /* ignore */ }
        window.location.href = 'dashboard.html';
      }).catch(function (err) {
        setBusy(submitBtn, false);
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          var roleLinks = {
            student: 'register.html?role=student', parent: 'register.html?role=parent',
            teacher: 'register.html?role=teacher', classteacher: 'register.html?role=classteacher',
            bursar: 'register.html?role=bursar', admin: 'register.html?role=admin', applicant: 'apply.html'
          };
          errorBox.innerHTML = 'No matching account found. <a href="' + roleLinks[selectedRole] + '" class="text-link">Create one here</a>.';
        } else {
          errorBox.textContent = friendlyAuthError(err);
        }
        errorBox.classList.add('is-shown');
      });
    });

    applyRole('applicant');
    var params = new URLSearchParams(window.location.search);
    var requestedRole = params.get('role');
    if (requestedRole && ROLE_CONFIG[requestedRole]) {
      applyRole(requestedRole);
    }
  }

  /* ===================================================================
     DASHBOARD PAGE — identity comes from Firebase Auth, not a
     locally-trusted session object.
  =================================================================== */
  var dashGrid = document.getElementById('dashGrid');
  if (dashGrid) {
    dashGrid.innerHTML = '<div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading your dashboard…</div>';

    waitForDb().then(function () {
      var fa = window.mripAuth;
      fa.onAuthStateChanged(fa.auth, function (user) {
        if (!user) {
          window.location.href = 'login.html';
          return;
        }
        resolveProfile(user.uid).then(function (result) {
          if (!result) {
            dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">We could not find a profile for your account. Please contact the school office.</div>';
            return;
          }
          renderDashboard(result.role, result.profile);
          renderAnnouncementFeed(result.role, result.profile, user.uid);
        }).catch(function () {
          dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">Could not load your dashboard. Check your connection and refresh.</div>';
        });
      });
    });

    function resolveProfile(uid) {
      return Promise.all([
        fsGetDoc('applicants', uid).catch(function () { return null; }),
        fsGetDoc('users', uid).catch(function () { return null; }),
        fsGetDoc('staffAccounts', uid).catch(function () { return null; }),
        fsGetDoc('config', 'admin').catch(function () { return null; })
      ]).then(function (results) {
        var applicant = results[0], userDoc = results[1], staffDoc = results[2], adminDoc = results[3];
        if (adminDoc && adminDoc.uid === uid) return { role: 'admin', profile: adminDoc };
        if (applicant) return { role: 'applicant', profile: applicant };
        if (userDoc) return { role: userDoc.role, profile: userDoc };
        if (staffDoc) return { role: staffDoc.role, profile: staffDoc };
        return null;
      });
    }

    var ANN_PRIORITY_LABEL = { normal: 'Normal', important: 'Important', urgent: 'Urgent' };

    function renderAnnouncementFeed(role, profile, uid) {
      var section = document.getElementById('annFeedSection');
      var list = document.getElementById('annFeedList');
      var badge = document.getElementById('annUnreadBadge');
      if (!section) return;

      Promise.all([
        fsGetAll('announcements'),
        fsQueryEq('announcementReads', 'userId', uid)
      ]).then(function (results) {
        var all = results[0];
        var myReads = results[1];
        var readIds = {};
        myReads.forEach(function (r) { readIds[r.announcementId] = true; });

        var classCode = role === 'student' ? profile.classCode : null;
        var relevant = all.filter(function (a) {
          return getEffectiveStatus(a) === 'published' && announcementMatchesUser(a, role, classCode);
        }).sort(function (a, b) { return new Date(b.publishDate || b.createdAt) - new Date(a.publishDate || a.createdAt); });

        if (relevant.length === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        var unreadCount = relevant.filter(function (a) { return !readIds[a.id]; }).length;
        badge.innerHTML = unreadCount > 0
          ? '<span class="status-badge status-pending">' + unreadCount + ' new</span>'
          : '';

        var shown = relevant.slice(0, 5);
        list.innerHTML = shown.map(function (a) {
          var isUnread = !readIds[a.id];
          var preview = stripHtml(a.content).slice(0, 140);
          return '<div class="ann-feed-card" data-ann-id="' + a.id + '">' +
            '<div class="ann-feed-head">' +
              (isUnread ? '<span class="ann-unread-dot"></span>' : '') +
              '<span class="priority-badge priority-' + a.priority + '">' + ANN_PRIORITY_LABEL[a.priority] + '</span>' +
            '</div>' +
            '<h4>' + escapeHtml(a.title) + '</h4>' +
            '<p>' + escapeHtml(preview) + (preview.length >= 140 ? '…' : '') + '</p>' +
            '<div class="ann-feed-foot">' +
              '<span class="ann-feed-date">' + new Date(a.publishDate || a.createdAt).toLocaleDateString() + '</span>' +
              '<button class="btn btn-ghost" type="button" style="padding:6px 14px; font-size:0.78rem;" data-read-more="' + a.id + '">Read More</button>' +
            '</div>' +
          '</div>';
        }).join('');

        list.querySelectorAll('[data-read-more]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-read-more');
            var a = relevant.find(function (x) { return x.id === id; });
            if (!a) return;
            showAnnouncementDetail(a, uid, role, readIds[id]);
            if (!readIds[id]) {
              fsAdd('announcementReads', { announcementId: id, userId: uid, role: role, readAt: new Date().toISOString() }).then(function () {
                renderAnnouncementFeed(role, profile, uid); // refresh unread state
              }).catch(function () { /* non-critical */ });
            }
          });
        });
      }).catch(function () {
        section.style.display = 'none';
      });
    }

    function showAnnouncementDetail(a, uid, role, alreadyRead) {
      var existing = document.querySelector('.detail-modal-overlay');
      if (existing) existing.remove();

      var attachmentsHtml = (a.attachments || []).map(function (att) {
        return '<a href="' + att.dataUrl + '" download="' + escapeHtml(att.name) + '" class="attach-chip" style="text-decoration:none;">📎 ' + escapeHtml(att.name) + '</a>';
      }).join(' ');

      var overlay = document.createElement('div');
      overlay.className = 'detail-modal-overlay';
      overlay.innerHTML =
        '<div class="detail-modal">' +
          '<div class="detail-modal-head"><h2>' + escapeHtml(a.title) + '</h2><button class="detail-modal-close" type="button" aria-label="Close">×</button></div>' +
          '<div class="ann-detail-meta">' +
            '<span class="priority-badge priority-' + a.priority + '">' + ANN_PRIORITY_LABEL[a.priority] + '</span>' +
            '<span>Posted ' + new Date(a.publishDate || a.createdAt).toLocaleDateString() + '</span>' +
            (a.createdBy ? '<span>By ' + escapeHtml(a.createdBy) + '</span>' : '') +
          '</div>' +
          '<div class="ann-detail-body">' + a.content + '</div>' +
          (attachmentsHtml ? '<div class="attach-list">' + attachmentsHtml + '</div>' : '') +
          '<div class="detail-modal-actions"><button class="btn btn-ghost" type="button" data-close-modal>Close</button></div>' +
        '</div>';
      document.body.appendChild(overlay);

      function close() { overlay.remove(); }
      overlay.querySelector('.detail-modal-close').addEventListener('click', close);
      overlay.querySelector('[data-close-modal]').addEventListener('click', close);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    var roleLabels = {
      applicant: 'Applicant Portal', student: 'Student Portal', parent: 'Parent Portal',
      teacher: 'Teacher Portal', classteacher: 'Class Teacher Portal', bursar: 'Bursar Portal',
      examofficer: 'Examination Officer Portal', admin: 'Administrator Portal'
    };

    document.getElementById('logoutLink').addEventListener('click', function (e) {
      e.preventDefault();
      waitForDb().then(function () {
        var fa = window.mripAuth;
        return fa.signOut(fa.auth);
      }).then(function () {
        try { localStorage.removeItem('mrip_role_hint'); } catch (err) { /* ignore */ }
        window.location.href = 'login.html';
      });
    });

    var SUBJECT_LABELS = {
      'القرآن المجود': 'القرآن المجود — Qur\'an (with Tajweed)', 'حفظ القرآن': 'حفظ القرآن — Qur\'an Memorization',
      'التجويد': 'التجويد — Tajweed', 'تفسير القرآن': 'تفسير القرآن — Tafsir', 'أصول التفسير': 'أصول التفسير — Principles of Tafsir',
      'الحديث': 'الحديث — Hadith', 'أصول الحديث': 'أصول الحديث — Principles of Hadith',
      'الفقه الإسلامي': 'الفقه الإسلامي — Islamic Fiqh', 'أصول الفقه': 'أصول الفقه — Principles of Fiqh', 'علم الفرائض': 'علم الفرائض — Islamic Inheritance Law',
      'التوحيد': 'التوحيد — Tawhid', 'السيرة النبوية': 'السيرة النبوية — Seerah', 'الأخلاق': 'الأخلاق — Islamic Ethics', 'التهذيب': 'التهذيب — Moral Refinement',
      'الثقافة الإسلامية': 'الثقافة الإسلامية — Islamic Culture', 'الفكر الإسلامي': 'الفكر الإسلامي — Islamic Thought',
      'التأريخ الإسلامي': 'التأريخ الإسلامي — Islamic History', 'التأريخ التشريعي': 'التأريخ التشريعي — Legislative History', 'الدعوة': 'الدعوة — Da\'wah',
      'النحو': 'النحو — Arabic Grammar', 'الصرف': 'الصرف — Morphology', 'البلاغة': 'البلاغة — Rhetoric', 'علم العروض': 'علم العروض — Prosody',
      'المنطق': 'المنطق — Logic', 'فقه اللغة': 'فقه اللغة — Philology',
      'العربية': 'العربية — Arabic Language', 'الأدب العربي': 'الأدب العربي — Arabic Literature', 'القراءة العربية': 'القراءة العربية — Arabic Reading',
      'الإنشاء': 'الإنشاء — Composition', 'التعبير': 'التعبير — Expression', 'الإملاء': 'الإملاء — Dictation', 'التهجئة': 'التهجئة — Spelling',
      'الكتابة / الحط العربي': 'الكتابة / الحط العربي — Handwriting / Arabic Script', 'المطالعة': 'المطالعة — Reading / Study', 'القراءة': 'القراءة — Reading',
      'القراءة الببغاوية': 'القراءة الببغاوية — Parrot Reading', 'القراءة / الكتابة': 'القراءة / الكتابة — Reading / Writing',
      'المحفوظات': 'المحفوظات — Memorization', 'الأنشودة': 'الأنشودة — Nasheed', 'الحساب': 'الحساب — Arithmetic',
      'العلوم': 'العلوم — Science', 'الجغرافيا': 'الجغرافيا — Geography'
    };
    var CLASS_LABELS = {
      AwwalIdadi: 'الصف الأول الإعدادي — First Preparatory', ThaniIdadi: 'الصف الثاني الإعدادي — Second Preparatory',
      ThalithIdadi: 'الصف الثالث الإعدادي — Third Preparatory', RabiIdadi: 'الصف الرابع الإعدادي — Fourth Preparatory',
      ThanawiAwwal: 'الصف الأول الثانوي — First Secondary', ThanawiThani: 'الصف الثاني الثانوي — Second Secondary',
      ThanawiThalith: 'الصف الثالث الثانوي — Third Secondary'
    };

    function renderDashboard(role, profile) {
      document.getElementById('dashRoleLabel').textContent = roleLabels[role] || 'Dashboard';
      document.getElementById('dashUserName').textContent = profile.fullName || profile.childName || '';
      document.getElementById('dashWelcome').textContent = 'Welcome, ' + (profile.fullName || '').split(' ')[0];

      if (role === 'applicant') {
        document.getElementById('dashSubtext').textContent = 'Track your application, admission decision, and matriculation below.';

        var statusClass = profile.status === 'Verified' || profile.status === 'Matric Issued'
          ? 'status-verified'
          : profile.status === 'Rejected'
            ? 'status-rejected'
            : 'status-pending';

        var paymentSummaryBtn = profile.applicationFeeStatus === 'Payment Verified'
          ? '<div class="dash-card dash-card-wide" style="text-align:center;"><button class="btn btn-gold" type="button" id="viewPaymentSummaryBtn">View / Print Payment Summary</button></div>'
          : '';

        var matricSection = '';
        if (profile.matric) {
          matricSection =
            '<div class="dash-card dash-card-wide">' +
              '<h3>Permanent Matric Number</h3>' +
              '<div class="dash-stat" style="font-size:1.35rem; letter-spacing:0.03em;">' + profile.matric + '</div>' +
              '<p style="margin:8px 0 0; color:var(--ink-soft); font-size:0.86rem;">Keep this number safe. You will use it to activate and access your Student Portal.</p>' +
            '</div>';
        } else if (profile.status === 'Admission Approved' || profile.admissionStatus === 'Approved') {
          matricSection =
            '<div class="dash-card dash-card-wide notice notice-info">' +
              '<h3 style="margin-top:0;">Generate Your Matric Number</h3>' +
              '<p>Your admission has been approved. Generate your permanent matric number when you are ready. It will remain linked to your admission record.</p>' +
              '<button class="btn btn-gold" type="button" id="generateMatricBtn">Generate Matric Number</button>' +
            '</div>';
        }

        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Application Reference</h3><div class="dash-stat" style="font-size:1.15rem;">' + profile.ref + '</div></div>' +
          '<div class="dash-card"><h3>Application Status</h3><span class="status-badge ' + statusClass + '">' + profile.status + '</span></div>' +
          '<div class="dash-card"><h3>Application Fee</h3><span class="status-badge ' + (isFinanceCleared(profile) ? 'status-verified' : profile.applicationFeeStatus === 'Payment Rejected' ? 'status-rejected' : 'status-pending') + '">' + (profile.applicationFeeStatus || 'Review required') + '</span></div>' +
          '<div class="dash-card"><h3>Class Applied For</h3><div class="dash-stat" style="font-size:1.15rem;">' + profile.classLabel + '</div></div>' +
          '<div class="dash-card dash-card-wide">' +
            '<h3>Application Summary</h3>' +
            '<table class="dash-table">' +
              '<tr><th>Full Name</th><td>' + profile.fullName + '</td></tr>' +
              '<tr><th>Email</th><td>' + profile.email + '</td></tr>' +
              '<tr><th>Phone</th><td>' + profile.phone + '</td></tr>' +
              '<tr><th>Submitted</th><td>' + new Date(profile.submittedAt).toLocaleString() + '</td></tr>' +
              (profile.matric ? '<tr><th>Matric Number</th><td>' + profile.matric + '</td></tr>' : '') +
            '</table>' +
          '</div>' +
          matricSection +
          paymentSummaryBtn +
          (profile.status === 'Pending Verification'
            ? '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Your application is awaiting review. The Bursar must first verify payment or approve an exemption; the Administrator can then review admission.</div>'
            : '');

        var generateMatricBtn = document.getElementById('generateMatricBtn');
        if (generateMatricBtn) {
          generateMatricBtn.addEventListener('click', function () {
            if (!window.confirm('Generate your permanent matric number now? This number will be permanent and cannot be changed later.')) return;
            setBusy(generateMatricBtn, true, 'Generating…');

            generateMatricForApplicant(profile).then(function (matric) {
              alert('Your permanent matric number is: ' + matric + '\n\nYou can return to this Applicant Portal at any time to view it.');
              window.location.reload();
            }).catch(function (err) {
              alert('Could not generate your matric number: ' + err.message);
              setBusy(generateMatricBtn, false);
            });
          });
        }

        var summaryBtn = document.getElementById('viewPaymentSummaryBtn');
        if (summaryBtn) {
          summaryBtn.addEventListener('click', function () {
            showPaymentReceipt({
              studentName: profile.fullName,
              studentMatric: profile.matric,
              classLabel: profile.classLabel,
              paymentType: 'Admission Fee',
              description: 'Non-refundable admission fee',
              amount: 10000,
              paymentDate: profile.submittedAt,
              admissionDate: profile.verifiedAt,
              reference: profile.ref
            });
          });
        }

      } else if (role === 'student') {
        document.getElementById('dashSubtext').textContent = 'Welcome back to your student dashboard.';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Matric Number</h3><div class="dash-stat" style="font-size:1.15rem;">' + profile.matric + '</div></div>' +
          '<div class="dash-card"><h3>Current Class</h3><div class="dash-stat" style="font-size:1.15rem;">' + (profile.classLabel || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Fee Status</h3><span class="status-badge status-pending">Pending Verification</span></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results, and timetable modules will appear here once connected to the school\'s academic records system.</div>' +
          '<div class="dash-card dash-card-wide"><h3>Payment History</h3><div id="paymentHistoryBody" style="margin-top:12px; color:var(--ink-soft); font-size:0.9rem;">Loading payment history…</div></div>';

        fsQueryEq('payments', 'studentMatric', profile.matric).then(function (payments) {
          var body = document.getElementById('paymentHistoryBody');
          if (!body) return;
          if (payments.length === 0) {
            body.innerHTML = 'No payments on record yet.';
            return;
          }
          payments.sort(function (a, b) { return new Date(b.paymentDate) - new Date(a.paymentDate); });
          body.innerHTML =
            '<table class="dash-table">' +
              '<tr><th>Type</th><th>Description</th><th>Amount</th><th>Date</th><th>Reference</th><th></th></tr>' +
              payments.map(function (p, i) {
                return '<tr>' +
                  '<td>' + p.paymentType + '</td>' +
                  '<td>' + p.description + '</td>' +
                  '<td>₦' + Number(p.amount || 0).toLocaleString() + '</td>' +
                  '<td>' + new Date(p.paymentDate).toLocaleDateString() + '</td>' +
                  '<td>' + (p.reference || '—') + '</td>' +
                  '<td><button class="btn btn-ghost" style="padding:5px 10px; font-size:0.76rem;" data-print-payment="' + i + '">View / Print</button></td>' +
                '</tr>';
              }).join('') +
            '</table>';
          body.querySelectorAll('[data-print-payment]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var idx = Number(btn.getAttribute('data-print-payment'));
              showPaymentReceipt(payments[idx]);
            });
          });
        }).catch(function () {
          var body = document.getElementById('paymentHistoryBody');
          if (body) body.innerHTML = 'Could not load payment history. Check your connection and refresh.';
        });

      } else if (role === 'parent') {
        document.getElementById('dashSubtext').textContent = "Following " + (profile.childName || 'your child') + "'s progress.";
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Child</h3><div class="dash-stat" style="font-size:1.15rem;">' + (profile.childName || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Matric Number</h3><div class="dash-stat" style="font-size:1.15rem;">' + (profile.childMatric || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Fee Status</h3><span class="status-badge status-pending">Pending Verification</span></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results, and fee receipts will appear here once connected to the school\'s records system.</div>';

      } else if (role === 'admin') {
        renderAdminDashboard();

      } else if (role === 'bursar') {
        renderBursarDashboard(profile);

      } else if (role === 'examofficer') {
        document.getElementById('dashSubtext').textContent = 'Examination Officer Portal — classes you oversee for results and promotion decisions.';
        dashGrid.innerHTML =
          '<div class="dash-card dash-card-wide"><h3>Classes You Oversee</h3><div class="dash-stat" style="font-size:1rem;">' + ((profile.classes || []).map(function (c) { return CLASS_LABELS[c] || c; }).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Result entry and promotion decisions will appear here once the Result Center is connected.</div>';

      } else {
        document.getElementById('dashSubtext').textContent = (roleLabels[role] || 'Staff') + ' — assigned classes and subjects below.';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Assigned Subjects</h3><div class="dash-stat" style="font-size:1rem;">' + ((profile.subjects || []).map(function (s) { return SUBJECT_LABELS[s] || s; }).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Assigned Classes</h3><div class="dash-stat" style="font-size:1rem;">' + ((profile.classes || []).map(function (c) { return CLASS_LABELS[c] || c; }).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results entry, and class rosters will appear here once connected to the school\'s academic records system.</div>';
      }
    }

    function renderBursarDashboard(profile) {
      document.getElementById('dashSubtext').textContent = 'Review application-fee evidence and fee-exemption requests.';
      dashGrid.innerHTML = '<div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading finance review queue…</div>';
      fsGetAll('applicants').then(function (applicants) {
        var queue = applicants.filter(function (a) {
          return a.applicationFeeStatus === 'Payment Submitted' || a.applicationFeeStatus === 'Fee Exemption Requested';
        }).sort(function (a, b) { return new Date(a.submittedAt) - new Date(b.submittedAt); });
        var rows = queue.length ? queue.map(function (a) {
          var isExemption = a.applicationFeeStatus === 'Fee Exemption Requested';
          var evidence = !isExemption && a.paymentEvidence && a.paymentEvidence.path
            ? '<button class="btn btn-ghost" style="padding:4px 8px; font-size:0.76rem;" data-open-receipt="' + a.id + '">Open receipt</button>'
            : isExemption ? 'Exemption request' : 'Receipt unavailable';
          return '<tr><td>' + escapeHtml(a.fullName) + '</td><td>' + escapeHtml(a.ref || '—') + '</td><td>' + escapeHtml(a.applicationFeeStatus) + '</td><td>' + evidence + '</td><td>' + new Date(a.submittedAt).toLocaleDateString() + '</td><td style="white-space:nowrap;">' +
            (isExemption
              ? '<button class="btn btn-gold" data-finance-action="exempt" data-applicant-id="' + a.id + '">Approve Exemption</button> '
              : '<button class="btn btn-gold" data-finance-action="verify" data-applicant-id="' + a.id + '">Verify Payment</button> ') +
            '<button class="btn btn-ghost" data-finance-action="reject" data-applicant-id="' + a.id + '">Reject</button></td></tr>';
        }).join('') : '<tr><td colspan="6" style="text-align:center; color:var(--ink-soft);">No finance items are awaiting review.</td></tr>';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Awaiting Review</h3><div class="dash-stat">' + queue.length + '</div><div class="dash-stat-label">Payment evidence or exemption requests</div></div>' +
          '<div class="dash-card dash-card-wide"><h3>Application Fee Review</h3><p style="font-size:0.85rem; color:var(--ink-soft); margin-bottom:16px;">Verify transfer evidence or approve a documented exemption. Admission approval remains an Administrator action.</p><table class="dash-table"><tr><th>Applicant</th><th>Reference</th><th>Request</th><th>Evidence</th><th>Submitted</th><th>Action</th></tr>' + rows + '</table></div>';
        dashGrid.querySelectorAll('[data-finance-action]').forEach(function (button) {
          button.addEventListener('click', function () {
            var applicant = queue.find(function (a) { return a.id === button.getAttribute('data-applicant-id'); });
            var decision = button.getAttribute('data-finance-action');
            if (!applicant) return;
            var note = '';
            if (decision === 'reject') {
              note = window.prompt('State the reason for rejecting this payment or exemption request. This will be visible to the applicant.');
              if (note === null || !note.trim()) return;
            }
            var label = decision === 'verify' ? 'Verify this payment' : decision === 'exempt' ? 'Approve this exemption' : 'Reject this request';
            if (!window.confirm(label + ' for ' + applicant.fullName + '?')) return;
            setBusy(button, true, 'Saving…');
            reviewApplicantFinance(applicant, decision, profile.fullName || 'Bursar', note).then(function () {
              renderBursarDashboard(profile);
            }).catch(function (err) {
              alert('Could not complete the finance review: ' + err.message);
              setBusy(button, false);
            });
          });
        });
        dashGrid.querySelectorAll('[data-open-receipt]').forEach(function (button) {
          button.addEventListener('click', function () {
            var applicant = queue.find(function (a) { return a.id === button.getAttribute('data-open-receipt'); });
            if (!applicant || !applicant.paymentEvidence || !applicant.paymentEvidence.path) return;
            var popup = window.open('', '_blank', 'noopener');
            waitForDb().then(function () {
              var fb = window.mripDb;
              return fb.getDownloadURL(fb.storageRef(fb.storage, applicant.paymentEvidence.path));
            }).then(function (url) {
              if (popup) popup.location = url;
              else window.location.href = url;
            }).catch(function (err) {
              if (popup) popup.close();
              alert('Could not open the payment receipt: ' + err.message);
            });
          });
        });
      }).catch(function () {
        dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">Could not load the finance review queue. Check your access and connection.</div>';
      });
    }

    function showPaymentReceipt(record) {
      var existing = document.querySelector('.detail-modal-overlay');
      if (existing) existing.remove();

      var logoSrc = document.querySelector('.portal-brand img') ? document.querySelector('.portal-brand img').src : '';
      var amountFormatted = '₦' + Number(record.amount || 0).toLocaleString();
      var paymentDateFormatted = record.paymentDate ? new Date(record.paymentDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
      var admissionRow = record.admissionDate
        ? '<div class="full-row"><dt>Date of Admission</dt><dd>' + new Date(record.admissionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) + '</dd></div>'
        : '';

      var overlay = document.createElement('div');
      overlay.className = 'detail-modal-overlay';
      overlay.innerHTML =
        '<div class="detail-modal receipt-wrap">' +
          '<div class="detail-modal-head"><h2>Payment Summary</h2><button class="detail-modal-close" type="button" aria-label="Close">×</button></div>' +
          '<div class="receipt-sheet">' +
            '<div class="receipt-head">' +
              '<div class="receipt-head-left">' +
                (logoSrc ? '<img src="' + logoSrc + '" alt="">' : '') +
                '<div><h2>Ma\'hdu Rahmat Islamiyy Institute</h2><p>Rahmatu El-Islamiy Institute</p></div>' +
              '</div>' +
              '<div class="receipt-photo-box">Passport<br>Photograph</div>' +
            '</div>' +
            '<div class="receipt-title"><h1>Payment Summary</h1><p>Official record of payment</p></div>' +
            '<div class="receipt-grid">' +
              '<div><dt>Full Name</dt><dd>' + record.studentName + '</dd></div>' +
              '<div><dt>Matriculation Number</dt><dd>' + record.studentMatric + '</dd></div>' +
              '<div><dt>Class</dt><dd>' + (record.classLabel || '—') + '</dd></div>' +
              '<div><dt>Reference</dt><dd>' + (record.reference || '—') + '</dd></div>' +
              '<div><dt>Payment Description</dt><dd>' + record.description + '</dd></div>' +
              '<div><dt>Date of Payment</dt><dd>' + paymentDateFormatted + '</dd></div>' +
              admissionRow +
            '</div>' +
            '<div class="receipt-amount-box"><span class="label">Amount Paid</span><span class="value">' + amountFormatted + '</span></div>' +
            '<div class="receipt-signatures">' +
              '<div class="receipt-sig"><div class="sig-line"></div><span class="sig-label">Registrar\'s Signature</span></div>' +
              '<div class="receipt-sig"><div class="sig-line"></div><span class="sig-label">Bursary Signature</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="receipt-actions"><button class="btn btn-gold" type="button" id="printReceiptBtn">Print / Save as PDF</button><button class="btn btn-ghost" type="button" data-close-modal>Close</button></div>' +
        '</div>';
      document.body.appendChild(overlay);

      function close() { overlay.remove(); }
      overlay.querySelector('.detail-modal-close').addEventListener('click', close);
      overlay.querySelector('[data-close-modal]').addEventListener('click', close);
      overlay.querySelector('#printReceiptBtn').addEventListener('click', function () { window.print(); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    function showDetailModal(title, fields) {
      var existing = document.querySelector('.detail-modal-overlay');
      if (existing) existing.remove();

      var overlay = document.createElement('div');
      overlay.className = 'detail-modal-overlay';
      var rows = fields.map(function (f) {
        return '<div class="review-item"><dt>' + f[0] + '</dt><dd>' + (f[1] || '—') + '</dd></div>';
      }).join('');
      overlay.innerHTML =
        '<div class="detail-modal">' +
          '<div class="detail-modal-head"><h2>' + title + '</h2><button class="detail-modal-close" type="button" aria-label="Close">×</button></div>' +
          '<div class="review-grid">' + rows + '</div>' +
          '<div class="detail-modal-actions"><button class="btn btn-ghost" type="button" data-close-modal>Close</button></div>' +
        '</div>';
      document.body.appendChild(overlay);

      function close() { overlay.remove(); }
      overlay.querySelector('.detail-modal-close').addEventListener('click', close);
      overlay.querySelector('[data-close-modal]').addEventListener('click', close);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    var adminCurrentView = 'overview';
    var adminCurrentCommView = 'create';
    var adminCurrentSessionView = 'current';

    function renderAdminDashboard() {
      dashGrid.innerHTML = '<div id="adminContentArea"></div>';
      var adminShell = document.getElementById('adminSidebar');
      if (adminShell) adminShell.classList.add('is-visible');
      var shellNav = document.getElementById('adminNav');
      if (shellNav) {
        shellNav.querySelectorAll('[data-admin-shell-view]').forEach(function (btn) {
          btn.classList.toggle('is-active', btn.getAttribute('data-admin-shell-view') === adminCurrentView);
          btn.onclick = function () {
            var target = btn.getAttribute('data-admin-shell-view');
            /* Staffing is currently represented by the existing Admin overview.
               We keep the navigation item honest until a dedicated staff page exists. */
            adminCurrentView = target === 'staffing' ? 'overview' : target;
            renderAdminDashboard();
            shellNav.querySelectorAll('[data-admin-shell-view]').forEach(function (item) {
              item.classList.toggle('is-active', item === btn);
            });
            document.body.classList.remove('mr-admin-sidebar-open');
          };
        });
      }
      var mobileToggle = document.getElementById('adminMobileToggle');
      var overlay = document.getElementById('adminSidebarOverlay');
      if (mobileToggle && !mobileToggle.dataset.bound) {
        mobileToggle.dataset.bound = '1';
        mobileToggle.addEventListener('click', function () {
          var open = document.body.classList.toggle('mr-admin-sidebar-open');
          mobileToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      }
      if (overlay && !overlay.dataset.bound) {
        overlay.dataset.bound = '1';
        overlay.addEventListener('click', function () {
          document.body.classList.remove('mr-admin-sidebar-open');
          if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
        });
      }
      if (adminCurrentView === 'comm') {
        renderCommunicationCenter(adminCurrentCommView);
      } else if (adminCurrentView === 'sessions') {
        renderAcademicSessions(adminCurrentSessionView);
      } else {
        renderAdminOverview();
      }
    }

    function renderAdminOverview() {
      var contentArea = document.getElementById('adminContentArea');
      contentArea.innerHTML = '<div class="dash-grid"><div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading…</div></div>';

      Promise.all([fsGetAll('staffRequests'), fsGetAll('applicants')]).then(function (results) {
        var requests = results[0];
        var applicants = results[1];
        var pending = requests.filter(function (r) { return r.status === 'Pending Approval'; });
        var pendingApplicants = applicants.filter(function (a) { return a.status === 'Pending Verification'; });
        var financeQueue = pendingApplicants.filter(function (a) {
          return a.applicationFeeStatus === 'Payment Submitted' || a.applicationFeeStatus === 'Fee Exemption Requested';
        });

        document.getElementById('dashSubtext').textContent = pending.length
          ? 'You have ' + pending.length + ' access request' + (pending.length === 1 ? '' : 's') + ' waiting for review.'
          : 'No pending access requests right now.';

        var notifBadge = pending.length
          ? '<span class="status-badge status-pending" style="margin-inline-start:8px;">' + pending.length + ' new</span>'
          : '';

        var reqRows = pending.length
          ? pending.map(function (r) {
              var assignment = '';
              if (r.classes && r.classes.length) assignment += '<div><strong>Classes:</strong> ' + r.classes.map(function (c) { return CLASS_LABELS[c] || c; }).join(', ') + '</div>';
              if (r.subjects && r.subjects.length) assignment += '<div><strong>Subjects:</strong> ' + r.subjects.map(function (s) { return SUBJECT_LABELS[s] || s; }).join(', ') + '</div>';
              if (!assignment) assignment = '—';
              return '<tr data-req-id="' + r.id + '">' +
                '<td>' + r.roleLabel + '</td>' +
                '<td>' + r.fullName + '</td>' +
                '<td>' + r.email + '</td>' +
                '<td style="font-size:0.8rem;">' + assignment + '</td>' +
                '<td>' + new Date(r.submittedAt).toLocaleDateString() + '</td>' +
                '<td style="white-space:nowrap;">' +
                  '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-view-req="' + r.id + '">View Details</button> ' +
                  '<button class="btn btn-gold" style="padding:6px 12px; font-size:0.78rem;" data-approve="' + r.id + '">Approve</button> ' +
                  '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-reject="' + r.id + '">Reject</button>' +
                '</td></tr>';
            }).join('')
          : '<tr><td colspan="6" style="text-align:center; color:var(--ink-soft);">No pending requests.</td></tr>';

        var appRows = pendingApplicants.length
          ? pendingApplicants.map(function (a) {
              var financeCleared = isFinanceCleared(a);
              return '<tr data-app-id="' + a.id + '">' +
                '<td>' + a.fullName + '</td>' +
                '<td>' + a.email + '</td>' +
                '<td>' + a.classLabel + '</td>' +
                '<td>' + (a.applicationFeeStatus || 'Legacy record — review required') + '</td>' +
                '<td>' + new Date(a.submittedAt).toLocaleDateString() + '</td>' +
                '<td style="white-space:nowrap;">' +
                  '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-view-app="' + a.id + '">View Details</button> ' +
                  (financeCleared
                    ? '<button class="btn btn-gold" style="padding:6px 12px; font-size:0.78rem;" data-approve-app="' + a.id + '">Approve Admission</button> '
                    : '<span style="font-size:0.78rem; color:var(--ink-soft);">Awaiting Bursar review</span> ') +
                  '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-reject-app="' + a.id + '">Reject</button>' +
                '</td></tr>';
            }).join('')
          : '<tr><td colspan="6" style="text-align:center; color:var(--ink-soft);">No pending applicants.</td></tr>';

        contentArea.innerHTML = '<div class="dash-grid">' +
          '<div class="dash-card"><h3>Pending Access Requests' + notifBadge + '</h3><div class="dash-stat">' + pending.length + '</div><div class="dash-stat-label">Awaiting your review</div></div>' +
          '<div class="dash-card"><h3>Finance Reviews Pending</h3><div class="dash-stat">' + financeQueue.length + '</div><div class="dash-stat-label">Assigned to the Bursar</div></div>' +
          '<div class="dash-card"><h3>Total Applicants</h3><div class="dash-stat">' + applicants.length + '</div><div class="dash-stat-label">All time</div></div>' +
          '<div class="dash-card dash-card-wide">' +
            '<h3>Pending Applicants</h3>' +
            '<table class="dash-table" id="appTable">' +
              '<tr><th>Name</th><th>Email</th><th>Class Applied</th><th>Finance Status</th><th>Submitted</th><th>Action</th></tr>' +
              appRows +
            '</table>' +
          '</div>' +
          '<div class="dash-card dash-card-wide">' +
            '<h3>Staff Access Requests</h3>' +
            '<table class="dash-table" id="reqTable">' +
              '<tr><th>Role</th><th>Name</th><th>Email</th><th>Assignment</th><th>Submitted</th><th>Action</th></tr>' +
              reqRows +
            '</table>' +
          '</div>' +
          '</div>';

        contentArea.querySelectorAll('[data-view-req]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-view-req');
            var r = requests.find(function (x) { return x.id === id; });
            if (!r) return;
            showDetailModal(r.roleLabel + ' Request — ' + r.fullName, [
              ['Full Name', r.fullName],
              ['Email', r.email],
              ['Phone', r.phone],
              ['Employee ID', r.employeeId || '—'],
              ['Classes', (r.classes || []).map(function (c) { return CLASS_LABELS[c] || c; }).join(', ') || '—'],
              ['Subjects', (r.subjects || []).map(function (s) { return SUBJECT_LABELS[s] || s; }).join(', ') || '—'],
              ['Note to Administrator', r.note || '—'],
              ['Submitted', new Date(r.submittedAt).toLocaleString()],
              ['Status', r.status]
            ]);
          });
        });

        contentArea.querySelectorAll('[data-view-app]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-view-app');
            var a = applicants.find(function (x) { return x.id === id; });
            if (!a) return;
            showDetailModal('Applicant — ' + a.fullName, [
              ['Full Name', a.fullName],
              ['Arabic Name', a.arabicName || '—'],
              ['Gender', a.gender],
              ['Date of Birth', a.dob],
              ['Address', a.address],
              ['Email', a.email],
              ['Phone', a.phone],
              ["Father's Name", a.fatherName || '—'],
              ["Mother's Name", a.motherName || '—'],
              ['Guardian Phone', a.guardianPhone],
              ['Class Applying For', a.classLabel],
              ['Previously Enrolled?', a.existingStudent === 'yes' ? 'Yes' : 'No'],
              ['Application Reference', a.ref],
              ['Application Fee Status', a.applicationFeeStatus || 'Legacy record — review required'],
              ['Payment Reference', a.paymentReference || '—'],
              ['Exemption Reason', a.exemptionReason || '—'],
              ['Finance Review Note', a.financeReviewNote || '—'],
              ['Submitted', new Date(a.submittedAt).toLocaleString()],
              ['Status', a.status]
            ]);
          });
        });

        contentArea.querySelectorAll('[data-approve]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-approve');
            var req = requests.find(function (r) { return r.id === id; });
            if (!req) return;
            btn.disabled = true;
            btn.textContent = 'Approving…';

            var tempPassword = genTempPassword();
            var fa = window.mripAuth;
            fa.createUserWithEmailAndPassword(fa.secondaryAuth, req.email, tempPassword).then(function (cred) {
              var newUid = cred.user.uid;
              return fa.signOut(fa.secondaryAuth).then(function () {
                return fsSetDoc('staffAccounts', newUid, {
                  role: req.role, roleLabel: req.roleLabel, fullName: req.fullName, email: req.email,
                  phone: req.phone, employeeId: req.employeeId || '', subjects: req.subjects || [], classes: req.classes || [],
                  approvedAt: new Date().toISOString()
                });
              }).then(function () {
                return fsUpdate('staffRequests', id, { status: 'Approved' });
              }).then(function () {
                alert(
                  req.fullName + ' has been approved as ' + req.roleLabel + '.\n\n' +
                  'Temporary login:\nEmail: ' + req.email + '\nTemporary password: ' + tempPassword + '\n\n' +
                  'Share this with them securely (no email service is connected yet, so this is not sent automatically). ' +
                  'They should be advised to keep it private.'
                );
                renderAdminDashboard();
              });
            }).catch(function (err) {
              alert('Could not approve this request: ' + friendlyAuthError(err));
              btn.disabled = false;
              btn.textContent = 'Approve';
            });
          });
        });
        contentArea.querySelectorAll('[data-reject]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-reject');
            btn.disabled = true;
            btn.textContent = 'Rejecting…';
            fsUpdate('staffRequests', id, { status: 'Rejected' }).then(function () {
              renderAdminDashboard();
            }).catch(function (err) {
              alert('Could not reject this request: ' + err.message);
              btn.disabled = false;
              btn.textContent = 'Reject';
            });
          });
        });

        contentArea.querySelectorAll('[data-approve-app]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-approve-app');
            var applicant = applicants.find(function (a) { return a.id === id; });
            if (!applicant) return;

            if (!window.confirm('Approve admission for ' + applicant.fullName + '? The applicant will then be able to generate their permanent matric number.')) return;

            btn.disabled = true;
            btn.textContent = 'Approving…';

            var approvedAt = new Date().toISOString();
            if (!isFinanceCleared(applicant)) {
              alert('Admission cannot be approved until the Bursar verifies payment or approves a fee exemption.');
              btn.disabled = false;
              btn.textContent = 'Approve Admission';
              return;
            }
            fsUpdate('applicants', id, {
              status: 'Admission Approved',
              admissionStatus: 'Approved',
              approvedAt: approvedAt
            }).then(function () {
              alert(
                applicant.fullName + ' has been approved for admission.\n\n' +
                'The applicant can now log in to their Applicant Portal and use the Generate Matric Number section.'
              );
              renderAdminDashboard();
            }).catch(function (err) {
              alert('Could not approve this applicant: ' + err.message);
              btn.disabled = false;
              btn.textContent = 'Approve Admission';
            });
          });
        });

        contentArea.querySelectorAll('[data-reject-app]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-reject-app');
            btn.disabled = true;
            btn.textContent = 'Rejecting…';
            fsUpdate('applicants', id, { status: 'Rejected' }).then(function () {
              renderAdminDashboard();
            }).catch(function (err) {
              alert('Could not reject this applicant: ' + err.message);
              btn.disabled = false;
              btn.textContent = 'Reject';
            });
          });
        });
      }).catch(function () {
        contentArea.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">Could not load dashboard data. Check your connection and refresh.</div>';
      });
    }

    /* ================= COMMUNICATION CENTER ================= */

    var ANN_CLASS_OPTIONS = [
      ['AwwalIdadi', 'الصف الأول الإعدادي — First Preparatory'],
      ['ThaniIdadi', 'الصف الثاني الإعدادي — Second Preparatory'],
      ['ThalithIdadi', 'الصف الثالث الإعدادي — Third Preparatory'],
      ['RabiIdadi', 'الصف الرابع الإعدادي — Fourth Preparatory'],
      ['ThanawiAwwal', 'الصف الأول الثانوي — First Secondary'],
      ['ThanawiThani', 'الصف الثاني الثانوي — Second Secondary'],
      ['ThanawiThalith', 'الصف الثالث الثانوي — Third Secondary']
    ];

    function initRichTextEditor(toolbarEl, editorEl) {
      toolbarEl.querySelectorAll('[data-cmd]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          var cmd = btn.getAttribute('data-cmd');
          if (cmd === 'createLink') {
            var url = prompt('Enter the link URL:');
            if (url) document.execCommand('createLink', false, url);
          } else {
            document.execCommand(cmd, false, null);
          }
          editorEl.focus();
        });
      });
    }

    function renderCommunicationCenter(subview) {
      adminCurrentCommView = subview;
      var contentArea = document.getElementById('adminContentArea');
      document.getElementById('dashSubtext').textContent = 'Create and manage announcements sent to students, staff, parents, and applicants.';

      var subnav =
        '<div id="commWidget" class="dash-card dash-card-wide" style="margin-bottom:20px;"><h3>Announcement Overview</h3><div class="widget-row" style="margin-top:12px;"><div class="widget-cell"><div class="num">—</div><div class="lbl">Loading</div></div></div></div>' +
        '<div class="admin-subnav" style="margin-top:0;">' +
          ['create', 'all', 'drafts', 'scheduled', 'archived'].map(function (v) {
            var label = v === 'create' ? 'Create Announcement' : v.charAt(0).toUpperCase() + v.slice(1);
            if (v === 'all') label = 'All Announcements';
            return '<button class="admin-subnav-btn' + (subview === v ? ' is-active' : '') + '" type="button" data-comm-view="' + v + '">' + label + '</button>';
          }).join('') +
        '</div>' +
        '<div id="commBody"></div>';
      contentArea.innerHTML = subnav;
      contentArea.querySelectorAll('[data-comm-view]').forEach(function (btn) {
        btn.addEventListener('click', function () { renderCommunicationCenter(btn.getAttribute('data-comm-view')); });
      });

      Promise.all([fsGetAll('announcements'), fsGetAll('announcementReads'), fsGetAll('applicants'), fsGetAll('users'), fsGetAll('staffAccounts')]).then(function (results) {
        var all = results[0], allReads = results[1], applicants = results[2], users = results[3], staff = results[4];
        var counts = { draft: 0, scheduled: 0, published: 0, archived: 0 };
        all.forEach(function (a) { counts[getEffectiveStatus(a)]++; });

        // "Total Unread Users" = number of people (applicants, students,
        // parents, staff) who have never opened a single announcement,
        // among those with at least one published announcement to read.
        var hasPublished = all.some(function (a) { return getEffectiveStatus(a) === 'published'; });
        var everyoneReadUids = {};
        allReads.forEach(function (r) { everyoneReadUids[r.userId] = true; });
        var allPeopleUids = []
          .concat(applicants.map(function (a) { return a.id; }))
          .concat(users.map(function (u) { return u.id; }))
          .concat(staff.map(function (s) { return s.id; }));
        var unreadUserCount = hasPublished ? allPeopleUids.filter(function (uid) { return !everyoneReadUids[uid]; }).length : 0;

        var widget = document.getElementById('commWidget');
        if (widget) {
          widget.innerHTML =
            '<h3>Announcement Overview</h3>' +
            '<div class="widget-row" style="margin-top:12px;">' +
              '<div class="widget-cell"><div class="num">' + all.length + '</div><div class="lbl">Total</div></div>' +
              '<div class="widget-cell"><div class="num">' + counts.draft + '</div><div class="lbl">Drafts</div></div>' +
              '<div class="widget-cell"><div class="num">' + counts.scheduled + '</div><div class="lbl">Scheduled</div></div>' +
              '<div class="widget-cell"><div class="num">' + counts.published + '</div><div class="lbl">Published</div></div>' +
              '<div class="widget-cell"><div class="num">' + counts.archived + '</div><div class="lbl">Archived</div></div>' +
            '</div>' +
            '<p style="font-size:0.78rem; color:var(--ink-soft); margin-top:12px;">' + unreadUserCount + ' people have not opened any announcement yet.</p>';
        }
      }).catch(function () { /* widget is non-critical */ });

      var body = document.getElementById('commBody');
      if (subview === 'create') {
        renderCreateAnnouncementForm(body, null);
      } else {
        renderAnnouncementTable(body, subview);
      }
    }

    function renderCreateAnnouncementForm(body, editRecord) {
      var isEdit = !!editRecord;
      body.innerHTML =
        '<div class="dash-card dash-card-wide">' +
          '<h3>' + (isEdit ? 'Edit Announcement' : 'Create Announcement') + '</h3>' +
          '<form id="annForm" style="margin-top:16px;">' +
            '<label class="field"><span>Announcement Title <em>*</em></span><input type="text" name="title" required value="' + (isEdit ? escapeHtml(editRecord.title) : '') + '"><small class="field-error" id="annTitleError"></small></label>' +

            '<div class="field" style="margin-top:16px;"><span>Announcement Message <em>*</em></span>' +
              '<div class="rte-toolbar" id="rteToolbar">' +
                '<button type="button" class="rte-btn" data-cmd="bold" title="Bold"><b>B</b></button>' +
                '<button type="button" class="rte-btn" data-cmd="italic" title="Italic"><i>I</i></button>' +
                '<button type="button" class="rte-btn" data-cmd="underline" title="Underline"><u>U</u></button>' +
                '<button type="button" class="rte-btn" data-cmd="insertUnorderedList" title="Bullet list">•≡</button>' +
                '<button type="button" class="rte-btn" data-cmd="insertOrderedList" title="Numbered list">1≡</button>' +
                '<button type="button" class="rte-btn" data-cmd="createLink" title="Insert link">🔗</button>' +
              '</div>' +
              '<div class="rte-editor" id="rteEditor" contenteditable="true">' + (isEdit ? editRecord.content : '') + '</div>' +
              '<small class="field-error" id="annContentError"></small>' +
            '</div>' +

            '<label class="field" style="margin-top:16px;"><span>Attachments <small>(optional — PDF, DOCX, or images, up to ~700KB each)</small></span>' +
              '<div class="attach-drop" id="attachDrop">Tap to choose a file, or drag one here</div>' +
              '<input type="file" id="attachInput" accept=".pdf,.doc,.docx,image/*" style="display:none;">' +
              '<div class="attach-list" id="attachList"></div>' +
            '</label>' +

            '<div class="field-row two-col" style="margin-top:16px;">' +
              '<div class="field"><span>Audience <em>*</em></span>' +
                '<div class="audience-row">' +
                  ['students', 'staff', 'parents', 'applicants', 'everyone'].map(function (a) {
                    var checked = isEdit && editRecord.audience && editRecord.audience.indexOf(a) > -1 ? ' checked' : '';
                    return '<label class="tick-item" style="padding:6px 12px;"><input type="checkbox" name="audience" value="' + a + '"' + checked + '><span>' + a.charAt(0).toUpperCase() + a.slice(1) + '</span></label>';
                  }).join('') +
                '</div>' +
                '<small class="field-error" id="annAudienceError"></small>' +
              '</div>' +
              '<div class="field"><span>Priority <em>*</em></span>' +
                '<select name="priority" required>' +
                  '<option value="normal"' + (isEdit && editRecord.priority === 'normal' ? ' selected' : '') + '>Normal</option>' +
                  '<option value="important"' + (isEdit && editRecord.priority === 'important' ? ' selected' : '') + '>Important</option>' +
                  '<option value="urgent"' + (isEdit && editRecord.priority === 'urgent' ? ' selected' : '') + '>Urgent</option>' +
                '</select>' +
              '</div>' +
            '</div>' +

            '<div class="field" id="classFilterField" style="margin-top:16px; display:' + (isEdit && editRecord.audience && editRecord.audience.indexOf('students') > -1 ? 'block' : 'none') + ';">' +
              '<span>Class Filter <small>(optional — leave all unticked to reach every class)</small></span>' +
              '<div class="tick-grid" id="annClassGrid">' +
                ANN_CLASS_OPTIONS.map(function (c) {
                  var checked = isEdit && editRecord.classFilter && editRecord.classFilter.indexOf(c[0]) > -1 ? ' checked' : '';
                  return '<label class="tick-item"><input type="checkbox" name="classFilter" value="' + c[0] + '"' + checked + '><span>' + c[1] + '</span></label>';
                }).join('') +
              '</div>' +
            '</div>' +

            '<div class="field" style="margin-top:16px;"><span>Publish Options <em>*</em></span>' +
              '<div class="radio-row">' +
                '<label class="radio-pill"><input type="radio" name="publishOption" value="now"' + (!isEdit ? ' checked' : '') + '> Publish Now</label>' +
                '<label class="radio-pill"><input type="radio" name="publishOption" value="draft"> Save as Draft</label>' +
                '<label class="radio-pill"><input type="radio" name="publishOption" value="schedule"> Schedule</label>' +
              '</div>' +
            '</div>' +
            '<div class="field-row two-col" id="scheduleFields" style="margin-top:16px; display:none;">' +
              '<label class="field"><span>Date</span><input type="date" name="scheduleDate"></label>' +
              '<label class="field"><span>Time</span><input type="time" name="scheduleTime"></label>' +
            '</div>' +

            '<label class="field" style="margin-top:16px;"><span>Expiry Date <small>(optional — auto-archives after this date)</small></span><input type="date" name="expiryDate" value="' + (isEdit && editRecord.expiryDate ? editRecord.expiryDate.slice(0, 10) : '') + '"></label>' +

            '<div class="panel-actions">' +
              '<span></span>' +
              '<button type="submit" class="btn btn-gold">' + (isEdit ? 'Save Changes' : 'Save Announcement') + '</button>' +
            '</div>' +
          '</form>' +
        '</div>';

      var toolbar = document.getElementById('rteToolbar');
      var editor = document.getElementById('rteEditor');
      initRichTextEditor(toolbar, editor);

      var attachments = isEdit && editRecord.attachments ? editRecord.attachments.slice() : [];
      function renderAttachList() {
        document.getElementById('attachList').innerHTML = attachments.map(function (att, i) {
          return '<span class="attach-chip">📎 ' + escapeHtml(att.name) + ' <button type="button" data-remove-attach="' + i + '">×</button></span>';
        }).join('');
        document.querySelectorAll('[data-remove-attach]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            attachments.splice(Number(btn.getAttribute('data-remove-attach')), 1);
            renderAttachList();
          });
        });
      }
      renderAttachList();

      document.getElementById('attachDrop').addEventListener('click', function () {
        document.getElementById('attachInput').click();
      });
      document.getElementById('attachInput').addEventListener('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;
        if (file.size > ANN_MAX_ATTACHMENT_BYTES) {
          alert('That file is too large (' + Math.round(file.size / 1024) + 'KB). Please keep attachments under ' + Math.round(ANN_MAX_ATTACHMENT_BYTES / 1024) + 'KB.');
          e.target.value = '';
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          attachments.push({ name: file.name, type: file.type, size: file.size, dataUrl: reader.result });
          renderAttachList();
        };
        reader.readAsDataURL(file);
        e.target.value = '';
      });

      var audienceInputs = document.querySelectorAll('input[name="audience"]');
      audienceInputs.forEach(function (input) {
        input.addEventListener('change', function () {
          var studentsChecked = document.querySelector('input[name="audience"][value="students"]').checked;
          var everyoneChecked = document.querySelector('input[name="audience"][value="everyone"]').checked;
          document.getElementById('classFilterField').style.display = (studentsChecked || everyoneChecked) ? 'block' : 'none';
        });
      });

      document.querySelectorAll('input[name="publishOption"]').forEach(function (input) {
        input.addEventListener('change', function () {
          document.getElementById('scheduleFields').style.display = input.value === 'schedule' && input.checked ? 'grid' : 'none';
        });
      });

      document.getElementById('annForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        var title = (fd.get('title') || '').trim();
        var content = editor.innerHTML.trim();
        var audience = Array.from(document.querySelectorAll('input[name="audience"]:checked')).map(function (i) { return i.value; });
        var classFilter = Array.from(document.querySelectorAll('input[name="classFilter"]:checked')).map(function (i) { return i.value; });
        var priority = fd.get('priority');
        var publishOption = fd.get('publishOption');
        var expiryDate = fd.get('expiryDate') || null;

        var ok = true;
        document.getElementById('annTitleError').textContent = '';
        document.getElementById('annContentError').textContent = '';
        document.getElementById('annAudienceError').textContent = '';
        if (!title) { document.getElementById('annTitleError').textContent = 'Title is required.'; ok = false; }
        if (!content || content === '<br>') { document.getElementById('annContentError').textContent = 'Message is required.'; ok = false; }
        if (audience.length === 0) { document.getElementById('annAudienceError').textContent = 'Select at least one audience.'; ok = false; }
        if (!ok) return;

        var status = 'published';
        var publishDate = new Date().toISOString();
        var scheduledDate = null;
        if (publishOption === 'draft') {
          status = 'draft';
        } else if (publishOption === 'schedule') {
          var d = fd.get('scheduleDate'), t = fd.get('scheduleTime') || '00:00';
          if (!d) { alert('Choose a date to schedule this announcement.'); return; }
          scheduledDate = new Date(d + 'T' + t).toISOString();
          status = 'scheduled';
          publishDate = scheduledDate;
        }

        var submitBtn = e.target.querySelector('button[type="submit"]');
        setBusy(submitBtn, true, 'Saving…');

        var record = {
          title: title, content: content, audience: audience, classFilter: classFilter, priority: priority,
          attachments: attachments, status: status, publishDate: publishDate, scheduledDate: scheduledDate,
          expiryDate: expiryDate ? new Date(expiryDate).toISOString() : null,
          updatedAt: new Date().toISOString()
        };

        var savePromise;
        if (isEdit) {
          savePromise = fsUpdate('announcements', editRecord.id, record);
        } else {
          record.createdBy = document.getElementById('dashUserName').textContent || 'Administrator';
          record.createdAt = new Date().toISOString();
          savePromise = fsAdd('announcements', record);
        }

        savePromise.then(function () {
          alert(isEdit ? 'Announcement updated.' : 'Announcement saved.');
          renderCommunicationCenter('all');
        }).catch(function (err) {
          setBusy(submitBtn, false);
          alert('Could not save: ' + err.message);
        });
      });
    }

    var annTableState = { search: '', sortField: 'createdAt', sortDir: 'desc', page: 1 };
    var ANN_PAGE_SIZE = 10;

    function renderAnnouncementTable(body, filterView) {
      annTableState.search = '';
      annTableState.sortField = 'createdAt';
      annTableState.sortDir = 'desc';
      annTableState.page = 1;
      body.innerHTML = '<div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading…</div>';
      fsGetAll('announcements').then(function (all) {

        function getFiltered() {
          var base = filterView === 'all' ? all : all.filter(function (a) { return getEffectiveStatus(a) === filterView.slice(0, -1); });
          if (annTableState.search.trim()) {
            var q = annTableState.search.trim().toLowerCase();
            base = base.filter(function (a) { return (a.title || '').toLowerCase().indexOf(q) > -1; });
          }
          var field = annTableState.sortField;
          base = base.slice().sort(function (a, b) {
            var va, vb;
            if (field === 'title') { va = (a.title || '').toLowerCase(); vb = (b.title || '').toLowerCase(); }
            else if (field === 'priority') { va = a.priority || ''; vb = b.priority || ''; }
            else if (field === 'status') { va = getEffectiveStatus(a); vb = getEffectiveStatus(b); }
            else { va = new Date(a[field] || 0).getTime(); vb = new Date(b[field] || 0).getTime(); }
            if (va < vb) return annTableState.sortDir === 'asc' ? -1 : 1;
            if (va > vb) return annTableState.sortDir === 'asc' ? 1 : -1;
            return 0;
          });
          return base;
        }

        function draw() {
          var filtered = getFiltered();
          var totalPages = Math.max(1, Math.ceil(filtered.length / ANN_PAGE_SIZE));
          if (annTableState.page > totalPages) annTableState.page = totalPages;
          var pageItems = filtered.slice((annTableState.page - 1) * ANN_PAGE_SIZE, annTableState.page * ANN_PAGE_SIZE);

          var sortArrow = function (field) {
            if (annTableState.sortField !== field) return '';
            return annTableState.sortDir === 'asc' ? ' ▲' : ' ▼';
          };
          var sortableHeader = function (field, label) {
            return '<th style="cursor:pointer; user-select:none;" data-sort-field="' + field + '">' + label + sortArrow(field) + '</th>';
          };

          var rows = pageItems.length === 0
            ? '<tr><td colspan="8" style="text-align:center; color:var(--ink-soft); padding:24px;">No announcements match.</td></tr>'
            : pageItems.map(function (a) {
                var eff = getEffectiveStatus(a);
                return '<tr data-ann-row="' + a.id + '">' +
                  '<td>' + escapeHtml(a.title) + '</td>' +
                  '<td style="font-size:0.8rem;">' + (a.audience || []).join(', ') + '</td>' +
                  '<td><span class="priority-badge priority-' + a.priority + '">' + ANN_PRIORITY_LABEL[a.priority] + '</span></td>' +
                  '<td><span class="status-pill status-pill-' + eff + '">' + eff.charAt(0).toUpperCase() + eff.slice(1) + '</span></td>' +
                  '<td style="font-size:0.8rem;">' + (a.createdBy || '—') + '</td>' +
                  '<td style="font-size:0.8rem;">' + (a.publishDate ? new Date(a.publishDate).toLocaleDateString() : '—') + '</td>' +
                  '<td style="font-size:0.8rem;">' + (a.expiryDate ? new Date(a.expiryDate).toLocaleDateString() : '—') + '</td>' +
                  '<td style="white-space:nowrap;">' +
                    '<button class="btn btn-ghost" style="padding:5px 10px; font-size:0.76rem;" data-ann-view="' + a.id + '">View</button> ' +
                    '<button class="btn btn-ghost" style="padding:5px 10px; font-size:0.76rem;" data-ann-edit="' + a.id + '">Edit</button> ' +
                    '<button class="btn btn-ghost" style="padding:5px 10px; font-size:0.76rem;" data-ann-dup="' + a.id + '">Duplicate</button> ' +
                    (eff !== 'archived' ? '<button class="btn btn-ghost" style="padding:5px 10px; font-size:0.76rem;" data-ann-archive="' + a.id + '">Archive</button> ' : '') +
                    '<button class="btn btn-ghost" style="padding:5px 10px; font-size:0.76rem; color:var(--danger);" data-ann-delete="' + a.id + '">Delete</button>' +
                  '</td></tr>';
              }).join('');

          document.getElementById('annResultCount').textContent = filtered.length + ' result' + (filtered.length === 1 ? '' : 's');

          var tableWrap = document.getElementById('annTableWrap');
          tableWrap.innerHTML =
            '<table class="dash-table">' +
              '<tr>' + sortableHeader('title', 'Title') + '<th>Audience</th>' + sortableHeader('priority', 'Priority') + sortableHeader('status', 'Status') + '<th>Created By</th>' + sortableHeader('publishDate', 'Publish Date') + sortableHeader('expiryDate', 'Expiry') + '<th>Actions</th>' +
              '</tr>' +
              rows +
            '</table>' +
            (totalPages > 1
              ? '<div style="display:flex; justify-content:center; align-items:center; gap:14px; margin-top:16px;">' +
                  '<button class="btn btn-ghost" type="button" id="annPagePrev"' + (annTableState.page <= 1 ? ' disabled' : '') + '>← Prev</button>' +
                  '<span style="font-size:0.85rem; color:var(--ink-soft);">Page ' + annTableState.page + ' of ' + totalPages + '</span>' +
                  '<button class="btn btn-ghost" type="button" id="annPageNext"' + (annTableState.page >= totalPages ? ' disabled' : '') + '>Next →</button>' +
                '</div>'
              : '');

          wireRowActions(filtered);

          tableWrap.querySelectorAll('[data-sort-field]').forEach(function (th) {
            th.addEventListener('click', function () {
              var field = th.getAttribute('data-sort-field');
              if (annTableState.sortField === field) {
                annTableState.sortDir = annTableState.sortDir === 'asc' ? 'desc' : 'asc';
              } else {
                annTableState.sortField = field;
                annTableState.sortDir = 'asc';
              }
              draw();
            });
          });
          var prevBtn = document.getElementById('annPagePrev');
          var nextBtn = document.getElementById('annPageNext');
          if (prevBtn) prevBtn.addEventListener('click', function () { annTableState.page--; draw(); });
          if (nextBtn) nextBtn.addEventListener('click', function () { annTableState.page++; draw(); });
        }

        function wireRowActions(filtered) {
          body.querySelectorAll('[data-ann-view]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var a = filtered.find(function (x) { return x.id === btn.getAttribute('data-ann-view'); });
              if (a) showAnnouncementAdminView(a);
            });
          });
          body.querySelectorAll('[data-ann-edit]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var a = filtered.find(function (x) { return x.id === btn.getAttribute('data-ann-edit'); });
              if (a) { renderCommunicationCenter('create'); setTimeout(function () { renderCreateAnnouncementForm(document.getElementById('commBody'), a); }, 0); }
            });
          });
          body.querySelectorAll('[data-ann-dup]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var a = filtered.find(function (x) { return x.id === btn.getAttribute('data-ann-dup'); });
              if (!a) return;
              var copy = Object.assign({}, a);
              delete copy.id;
              copy.title = a.title + ' (Copy)';
              copy.status = 'draft';
              copy.createdAt = new Date().toISOString();
              copy.createdBy = document.getElementById('dashUserName').textContent || 'Administrator';
              fsAdd('announcements', copy).then(function () {
                alert('Duplicated as a new draft.');
                renderCommunicationCenter('drafts');
              });
            });
          });
          body.querySelectorAll('[data-ann-archive]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var id = btn.getAttribute('data-ann-archive');
              fsUpdate('announcements', id, { status: 'archived', updatedAt: new Date().toISOString() }).then(function () {
                fsGetAll('announcements').then(function (refreshed) { all = refreshed; draw(); });
              });
            });
          });
          body.querySelectorAll('[data-ann-delete]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              if (!confirm('Delete this announcement permanently? This cannot be undone.')) return;
              fsDelete('announcements', btn.getAttribute('data-ann-delete')).then(function () {
                fsGetAll('announcements').then(function (refreshed) { all = refreshed; draw(); });
              }).catch(function (err) {
                alert('Could not delete: ' + err.message);
              });
            });
          });
        }

        if (all.length === 0) {
          body.innerHTML = '<div class="ann-empty">No announcements here yet.</div>';
          return;
        }

        body.innerHTML =
          '<div class="dash-card dash-card-wide">' +
            '<div style="display:flex; gap:12px; align-items:center; margin-bottom:16px; flex-wrap:wrap;">' +
              '<input type="text" id="annSearchInput" placeholder="Search by title…" style="flex:1; min-width:200px; padding:9px 12px; border:1px solid var(--line); border-radius:var(--radius-sm); font-size:0.88rem;">' +
              '<span id="annResultCount" style="font-size:0.8rem; color:var(--ink-soft);"></span>' +
            '</div>' +
            '<div id="annTableWrap"></div>' +
          '</div>';

        document.getElementById('annSearchInput').addEventListener('input', function (e) {
          annTableState.search = e.target.value;
          annTableState.page = 1;
          draw();
        });

        draw();
      }).catch(function () {
        body.innerHTML = '<div class="ann-empty">Could not load announcements. Check your connection and refresh.</div>';
      });
    }

    function showAnnouncementAdminView(a) {
      var existing = document.querySelector('.detail-modal-overlay');
      if (existing) existing.remove();

      Promise.all([
        fsGetAll('announcementReads'),
        fsGetAll('applicants'),
        fsGetAll('users'),
        fsGetAll('staffAccounts')
      ]).then(function (results) {
        var allReads = results[0].filter(function (r) { return r.announcementId === a.id; });
        var applicants = results[1];
        var users = results[2];
        var staff = results[3];

        var students = users.filter(function (u) { return u.role === 'student'; });
        var parents = users.filter(function (u) { return u.role === 'parent'; });

        function eligibleCount(audienceKey, list, matchFn) {
          var aud = a.audience || [];
          if (aud.indexOf('everyone') === -1 && aud.indexOf(audienceKey) === -1) return null;
          return matchFn ? list.filter(matchFn).length : list.length;
        }

        var classMatch = a.classFilter && a.classFilter.length
          ? function (s) { return a.classFilter.indexOf(s.classCode) > -1; }
          : null;

        var groups = [
          { key: 'students', label: 'Students', total: eligibleCount('students', students, classMatch), readRole: 'student' },
          { key: 'staff', label: 'Staff', total: eligibleCount('staff', staff), readRole: null },
          { key: 'parents', label: 'Parents', total: eligibleCount('parents', parents), readRole: 'parent' },
          { key: 'applicants', label: 'Applicants', total: eligibleCount('applicants', applicants), readRole: 'applicant' }
        ].filter(function (g) { return g.total !== null; });

        var statsHtml = groups.map(function (g) {
          var readCount = g.key === 'staff'
            ? allReads.filter(function (r) { return ['teacher', 'classteacher', 'bursar', 'examofficer', 'admin'].indexOf(r.role) > -1; }).length
            : allReads.filter(function (r) { return r.role === g.readRole; }).length;
          var pct = g.total > 0 ? Math.round((readCount / g.total) * 100) : 0;
          return '<div class="read-stat-row">' +
            '<div class="read-stat-label"><span>' + g.label + '</span><span>' + readCount + ' / ' + g.total + ' (' + pct + '%)</span></div>' +
            '<div class="read-stat-bar"><div class="read-stat-fill" style="width:' + pct + '%;"></div></div>' +
          '</div>';
        }).join('');

        var attachmentsHtml = (a.attachments || []).map(function (att) {
          return '<a href="' + att.dataUrl + '" download="' + escapeHtml(att.name) + '" class="attach-chip" style="text-decoration:none;">📎 ' + escapeHtml(att.name) + '</a>';
        }).join(' ');

        var overlay = document.createElement('div');
        overlay.className = 'detail-modal-overlay';
        overlay.innerHTML =
          '<div class="detail-modal">' +
            '<div class="detail-modal-head"><h2>' + escapeHtml(a.title) + '</h2><button class="detail-modal-close" type="button" aria-label="Close">×</button></div>' +
            '<div class="ann-detail-meta">' +
              '<span class="priority-badge priority-' + a.priority + '">' + ANN_PRIORITY_LABEL[a.priority] + '</span>' +
              '<span class="status-pill status-pill-' + getEffectiveStatus(a) + '">' + getEffectiveStatus(a) + '</span>' +
            '</div>' +
            '<div class="ann-detail-body">' + a.content + '</div>' +
            (attachmentsHtml ? '<div class="attach-list" style="margin-bottom:20px;">' + attachmentsHtml + '</div>' : '') +
            '<h3 style="font-size:0.95rem; color:var(--pine); margin-bottom:12px;">Read Statistics</h3>' +
            (statsHtml || '<p style="font-size:0.85rem; color:var(--ink-soft);">No audience selected.</p>') +
            '<div class="detail-modal-actions"><button class="btn btn-ghost" type="button" data-close-modal>Close</button></div>' +
          '</div>';
        document.body.appendChild(overlay);

        function close() { overlay.remove(); }
        overlay.querySelector('.detail-modal-close').addEventListener('click', close);
        overlay.querySelector('[data-close-modal]').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      });
    }

    /* ================= ACADEMIC SESSION MANAGEMENT ================= */

    // Ordered progression through the 7 classes. A student who is
    // "Promoted" moves to the next entry; a student in the last class
    // (Thanawī Thālith / Third Secondary) who is "Graduated" leaves the
    // active roster. There is deliberately no "next class" past the end
    // — graduating is a status change, not a class change.
    var CLASS_SEQUENCE = ['AwwalIdadi', 'ThaniIdadi', 'ThalithIdadi', 'RabiIdadi', 'ThanawiAwwal', 'ThanawiThani', 'ThanawiThalith'];
    function getNextClassCode(code) {
      var idx = CLASS_SEQUENCE.indexOf(code);
      if (idx === -1 || idx === CLASS_SEQUENCE.length - 1) return null;
      return CLASS_SEQUENCE[idx + 1];
    }
    function classLabelFor(code) {
      var found = ANN_CLASS_OPTIONS.find(function (c) { return c[0] === code; });
      return found ? found[1] : code;
    }

    function renderAcademicSessions(view) {
      adminCurrentSessionView = view;
      var contentArea = document.getElementById('adminContentArea');
      document.getElementById('dashSubtext').textContent = 'Manage academic sessions and promote students between them.';

      var subnav =
        '<div class="admin-subnav" style="margin-top:0;">' +
          '<button class="admin-subnav-btn' + (view === 'current' ? ' is-active' : '') + '" type="button" data-session-view="current">Current Session</button>' +
          '<button class="admin-subnav-btn' + (view === 'create' ? ' is-active' : '') + '" type="button" data-session-view="create">Create New Session</button>' +
          '<button class="admin-subnav-btn' + (view === 'transition' ? ' is-active' : '') + '" type="button" data-session-view="transition">Start New Session</button>' +
        '</div>' +
        '<div id="sessionBody"></div>';
      contentArea.innerHTML = subnav;
      contentArea.querySelectorAll('[data-session-view]').forEach(function (btn) {
        btn.addEventListener('click', function () { renderAcademicSessions(btn.getAttribute('data-session-view')); });
      });

      var body = document.getElementById('sessionBody');
      if (view === 'create') {
        renderCreateSessionForm(body);
      } else if (view === 'transition') {
        renderTransitionSummary(body);
      } else {
        renderCurrentSessionView(body);
      }
    }

    function getActiveSession(allSessions) {
      return allSessions.find(function (s) { return s.status === 'active'; }) || null;
    }
    function getDraftSession(allSessions) {
      return allSessions.find(function (s) { return s.status === 'draft'; }) || null;
    }

    function renderCurrentSessionView(body) {
      body.innerHTML = '<div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading…</div>';
      Promise.all([fsGetAll('academicSessions'), fsGetAll('students')]).then(function (results) {
        var sessions = results[0];
        var students = results[1];
        var active = getActiveSession(sessions);
        var draft = getDraftSession(sessions);

        if (!active) {
          body.innerHTML =
            '<div class="ann-empty">No academic session has been created yet. Go to <strong>Create New Session</strong> to set up the first one.</div>';
          return;
        }

        var activeStudents = students.filter(function (s) { return s.currentSessionId === active.id && !s.graduated; });
        var byClass = {};
        activeStudents.forEach(function (s) {
          byClass[s.classCode] = (byClass[s.classCode] || 0) + 1;
        });
        var classRows = CLASS_SEQUENCE.map(function (code) {
          return '<tr><td>' + classLabelFor(code) + '</td><td>' + (byClass[code] || 0) + '</td></tr>';
        }).join('');

        body.innerHTML =
          '<div class="dash-grid">' +
            '<div class="dash-card"><h3>Active Session</h3><div class="dash-stat" style="font-size:1.2rem;">' + escapeHtml(active.name) + '</div><div class="dash-stat-label">Started ' + new Date(active.startedAt).toLocaleDateString() + '</div></div>' +
            '<div class="dash-card"><h3>Total Active Students</h3><div class="dash-stat">' + activeStudents.length + '</div></div>' +
            '<div class="dash-card"><h3>Next Session</h3><div class="dash-stat" style="font-size:1.1rem;">' + (draft ? escapeHtml(draft.name) + ' (draft)' : '—') + '</div></div>' +
            '<div class="dash-card dash-card-wide">' +
              '<h3>Students per Class</h3>' +
              '<table class="dash-table"><tr><th>Class</th><th>Students</th></tr>' + classRows + '</table>' +
            '</div>' +
          '</div>';
      }).catch(function () {
        body.innerHTML = '<div class="ann-empty">Could not load session data. Check your connection and refresh.</div>';
      });
    }

    function renderCreateSessionForm(body) {
      Promise.all([fsGetAll('academicSessions')]).then(function (results) {
        var sessions = results[0];
        var active = getActiveSession(sessions);
        var draft = getDraftSession(sessions);

        if (draft) {
          body.innerHTML =
            '<div class="dash-card dash-card-wide notice notice-info">' +
              'A next session ("' + escapeHtml(draft.name) + '") has already been created and is waiting to start. Go to <strong>Start New Session</strong> to review and activate it, or archive it from the Firestore console if you need to start over.' +
            '</div>';
          return;
        }

        body.innerHTML =
          '<div class="dash-card dash-card-wide">' +
            '<h3>Create the Next Academic Session</h3>' +
            '<p style="font-size:0.85rem; color:var(--ink-soft); margin:8px 0 16px;">This creates the session as a <strong>draft</strong> — it will not go live, and no students will move, until you review and confirm the transition in "Start New Session."</p>' +
            '<form id="createSessionForm">' +
              '<label class="field"><span>Session Name <em>*</em></span><input type="text" name="sessionName" placeholder="e.g. 2027/2028" required></label>' +
              '<div class="panel-actions"><span></span><button type="submit" class="btn btn-gold">Create Draft Session</button></div>' +
            '</form>' +
          '</div>';

        document.getElementById('createSessionForm').addEventListener('submit', function (e) {
          e.preventDefault();
          var name = (new FormData(e.target).get('sessionName') || '').trim();
          if (!name) return;
          var submitBtn = e.target.querySelector('button[type="submit"]');
          setBusy(submitBtn, true, 'Creating…');
          fsAdd('academicSessions', {
            name: name, status: 'draft', createdAt: new Date().toISOString(),
            createdBy: document.getElementById('dashUserName').textContent || 'Administrator',
            previousSessionId: active ? active.id : null
          }).then(function () {
            alert('Draft session "' + name + '" created. Go to "Start New Session" when you\'re ready to review the transition.');
            renderAcademicSessions('transition');
          }).catch(function (err) {
            setBusy(submitBtn, false);
            alert('Could not create session: ' + err.message);
          });
        });
      });
    }

    function renderTransitionSummary(body) {
      body.innerHTML = '<div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading…</div>';
      Promise.all([fsGetAll('academicSessions'), fsGetAll('students'), fsGetAll('staffAccounts')]).then(function (results) {
        var sessions = results[0];
        var allStudents = results[1];
        var allStaff = results[2];
        var active = getActiveSession(sessions);
        var draft = getDraftSession(sessions);

        if (!active) {
          body.innerHTML = '<div class="ann-empty">Create a session first under "Create New Session."</div>';
          return;
        }
        if (!draft) {
          body.innerHTML = '<div class="ann-empty">No draft session is waiting. Go to "Create New Session" to set up the next one before starting a transition.</div>';
          return;
        }

        var activeStudents = allStudents.filter(function (s) { return s.currentSessionId === active.id && !s.graduated; });
        var promoted = activeStudents.filter(function (s) { return s.promotionDecision === 'Promoted'; });
        var repeating = activeStudents.filter(function (s) { return s.promotionDecision === 'Repeat'; });
        var graduating = activeStudents.filter(function (s) { return s.promotionDecision === 'Graduated'; });
        var undecided = activeStudents.filter(function (s) { return !s.promotionDecision; });

        var classTeacherRows = allStaff.filter(function (s) { return s.role === 'classteacher'; }).map(function (t) {
          return '<tr><td>' + escapeHtml(t.fullName) + '</td><td>' + ((t.classes || []).map(function (c) { return classLabelFor(c); }).join(', ') || '—') + '</td></tr>';
        }).join('');

        function studentListHtml(list) {
          if (list.length === 0) return '<p style="font-size:0.85rem; color:var(--ink-soft);">None.</p>';
          return '<table class="dash-table"><tr><th>Name</th><th>Matric</th><th>Current Class</th><th>Next Class</th></tr>' +
            list.map(function (s) {
              var next = s.promotionDecision === 'Promoted' ? classLabelFor(getNextClassCode(s.classCode)) :
                         s.promotionDecision === 'Repeat' ? classLabelFor(s.classCode) + ' (repeat)' :
                         s.promotionDecision === 'Graduated' ? 'Graduating' : '—';
              return '<tr><td>' + escapeHtml(s.fullName) + '</td><td>' + escapeHtml(s.matric) + '</td><td style="font-size:0.82rem;">' + classLabelFor(s.classCode) + '</td><td style="font-size:0.82rem;">' + next + '</td></tr>';
            }).join('') +
          '</table>';
        }

        var undecidedWarning = undecided.length > 0
          ? '<div class="notice notice-error" style="margin-bottom:20px;">' +
              '<strong>' + undecided.length + ' student' + (undecided.length === 1 ? '' : 's') + ' have no promotion decision yet</strong> — these students will be <strong>kept in their current class unchanged</strong> if you proceed. Set their decision below, or via the Result Center, before starting the new session.' +
              '<div style="margin-top:12px;">' +
                undecided.map(function (s) {
                  return '<div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">' +
                    '<span style="font-size:0.85rem; flex:1;">' + escapeHtml(s.fullName) + ' (' + escapeHtml(s.matric) + ', ' + classLabelFor(s.classCode) + ')</span>' +
                    '<select data-set-decision="' + s.id + '" style="padding:6px 10px; border:1px solid var(--line); border-radius:var(--radius-sm); font-size:0.8rem;">' +
                      '<option value="">Choose…</option>' +
                      '<option value="Promoted">Promoted</option>' +
                      '<option value="Repeat">Repeat</option>' +
                      '<option value="Graduated">Graduated</option>' +
                    '</select>' +
                  '</div>';
                }).join('') +
              '</div>' +
            '</div>'
          : '';

        body.innerHTML =
          '<div class="dash-card dash-card-wide">' +
            '<h3>Transition Summary — ' + escapeHtml(active.name) + ' → ' + escapeHtml(draft.name) + '</h3>' +
            '<p style="font-size:0.85rem; color:var(--ink-soft); margin:8px 0 20px;">Review carefully before confirming — this moves real student records and cannot be undone from the portal.</p>' +
            undecidedWarning +
            '<div class="widget-row" style="margin-bottom:24px;">' +
              '<div class="widget-cell"><div class="num">' + promoted.length + '</div><div class="lbl">Promoted</div></div>' +
              '<div class="widget-cell"><div class="num">' + repeating.length + '</div><div class="lbl">Repeating</div></div>' +
              '<div class="widget-cell"><div class="num">' + graduating.length + '</div><div class="lbl">Graduating</div></div>' +
              '<div class="widget-cell"><div class="num">' + undecided.length + '</div><div class="lbl">Undecided</div></div>' +
              '<div class="widget-cell"><div class="num">' + activeStudents.length + '</div><div class="lbl">Total</div></div>' +
            '</div>' +
            '<h4 style="font-size:0.9rem; color:var(--pine); margin-bottom:8px;">Promoted (' + promoted.length + ')</h4>' + studentListHtml(promoted) +
            '<h4 style="font-size:0.9rem; color:var(--pine); margin:20px 0 8px;">Repeating (' + repeating.length + ')</h4>' + studentListHtml(repeating) +
            '<h4 style="font-size:0.9rem; color:var(--pine); margin:20px 0 8px;">Graduating (' + graduating.length + ')</h4>' + studentListHtml(graduating) +
            '<h4 style="font-size:0.9rem; color:var(--pine); margin:20px 0 8px;">Class Teacher Assignments Carried Forward</h4>' +
            (classTeacherRows ? '<table class="dash-table"><tr><th>Class Teacher</th><th>Class</th></tr>' + classTeacherRows + '</table>' : '<p style="font-size:0.85rem; color:var(--ink-soft);">No class teachers assigned yet.</p>') +
            '<h4 style="font-size:0.9rem; color:var(--pine); margin:20px 0 8px;">Archive Summary</h4>' +
            '<p style="font-size:0.85rem; color:var(--ink-soft);">"' + escapeHtml(active.name) + '" will be marked archived. Every student\'s current class and decision for this session is preserved in their permanent history — nothing is deleted.</p>' +
            '<div class="panel-actions">' +
              '<span></span>' +
              '<button class="btn btn-gold" type="button" id="confirmTransitionBtn">Confirm & Start New Session</button>' +
            '</div>' +
          '</div>';

        body.querySelectorAll('[data-set-decision]').forEach(function (sel) {
          sel.addEventListener('change', function () {
            var studentId = sel.getAttribute('data-set-decision');
            var val = sel.value;
            if (!val) return;
            sel.disabled = true;
            fsUpdate('students', studentId, { promotionDecision: val }).then(function () {
              renderTransitionSummary(body);
            });
          });
        });

        document.getElementById('confirmTransitionBtn').addEventListener('click', function () {
          if (undecided.length > 0) {
            if (!confirm(undecided.length + ' student(s) still have no decision and will stay in their current class unchanged. Continue anyway?')) return;
          }
          if (!confirm('This will move ' + activeStudents.length + ' student records into "' + draft.name + '" and archive "' + active.name + '". This cannot be undone from the portal. Continue?')) return;
          runSessionTransition(active, draft, activeStudents, promoted, repeating, graduating, undecided, allStaff, document.getElementById('confirmTransitionBtn'));
        });
      }).catch(function () {
        body.innerHTML = '<div class="ann-empty">Could not load transition data. Check your connection and refresh.</div>';
      });
    }

    function syncStudentAccountClass(seedRecord, newClassCode, newClassLabel) {
      if (seedRecord.userUid) {
        return fsUpdate('users', seedRecord.userUid, { classCode: newClassCode, classLabel: newClassLabel }).catch(function () { /* account doc may not exist */ });
      }
      // No known link yet — this student may have activated their
      // account before the link-back was recorded. Fall back to
      // looking their account up by matric number.
      return fsQueryEq('users', 'matric', seedRecord.matric).then(function (matches) {
        if (matches[0]) {
          return fsUpdate('users', matches[0].id, { classCode: newClassCode, classLabel: newClassLabel });
        }
      }).catch(function () { /* student likely hasn't activated an account yet — nothing to sync */ });
    }

    function runSessionTransition(active, draft, activeStudents, promoted, repeating, graduating, undecided, allStaff, btn) {
      setBusy(btn, true, 'Starting new session…');

      var writes = [];

      activeStudents.forEach(function (s) {
        var decision = s.promotionDecision || null;
        var historyEntry = { sessionId: active.id, sessionName: active.name, classCode: s.classCode, classLabel: s.classLabel, decision: decision || 'Unchanged' };
        var newHistory = (s.sessionHistory || []).concat([historyEntry]);

        if (decision === 'Promoted') {
          var nextCode = getNextClassCode(s.classCode);
          if (nextCode) {
            var nextLabel = classLabelFor(nextCode);
            writes.push(fsUpdate('students', s.id, { classCode: nextCode, classLabel: nextLabel, currentSessionId: draft.id, promotionDecision: null, sessionHistory: newHistory }));
            writes.push(syncStudentAccountClass(s, nextCode, nextLabel));
          } else {
            // Already at the final class with no further class to move to — treat as graduating.
            writes.push(fsUpdate('students', s.id, { graduated: true, currentSessionId: draft.id, promotionDecision: null, sessionHistory: newHistory }));
          }
        } else if (decision === 'Graduated') {
          writes.push(fsUpdate('students', s.id, { graduated: true, currentSessionId: draft.id, promotionDecision: null, sessionHistory: newHistory }));
        } else if (decision === 'Repeat') {
          writes.push(fsUpdate('students', s.id, { currentSessionId: draft.id, promotionDecision: null, sessionHistory: newHistory }));
        } else {
          // Undecided — kept unchanged in the same class, per instruction not to auto-promote.
          writes.push(fsUpdate('students', s.id, { currentSessionId: draft.id, sessionHistory: newHistory }));
        }
      });

      // Carry forward class teacher (and other staff) class/subject assignments
      // into the new session's assignment history, leaving their current
      // fields untouched (still correct, since class codes don't change on
      // the teacher's side — only which session they apply to).
      allStaff.forEach(function (t) {
        var sessionAssignments = t.sessionAssignments || {};
        sessionAssignments[draft.id] = { classes: t.classes || [], subjects: t.subjects || [] };
        writes.push(fsUpdate('staffAccounts', t.id, { sessionAssignments: sessionAssignments }));
      });

      var archiveSummary = {
        promotedCount: promoted.length, repeatingCount: repeating.length,
        graduatedCount: graduating.length, undecidedCount: undecided.length,
        totalCount: activeStudents.length, archivedAt: new Date().toISOString()
      };
      writes.push(fsUpdate('academicSessions', active.id, { status: 'archived', endedAt: new Date().toISOString(), archiveSummary: archiveSummary }));
      writes.push(fsUpdate('academicSessions', draft.id, { status: 'active', startedAt: new Date().toISOString() }));

      Promise.all(writes).then(function () {
        alert('New academic session "' + draft.name + '" is now active. "' + active.name + '" has been archived.');
        adminCurrentSessionView = 'current';
        renderAcademicSessions('current');
      }).catch(function (err) {
        setBusy(btn, false);
        alert('The transition partially failed: ' + err.message + '\n\nPlease check the Current Session view carefully — some records may have updated and others may not have. Contact support before retrying.');
      });
    }
  }

  /* ===================================================================
     REGISTER PAGE
  =================================================================== */
  var regRoleTabs = document.getElementById('regRoleTabs');
  if (regRoleTabs) {
    ensureSeedStudents();

    var regTabs = regRoleTabs.querySelectorAll('.role-tab');
    var regBlocks = document.querySelectorAll('.reg-block');
    var staffTitle = document.getElementById('staffRegTitle');
    var STAFF_ROLE_LABELS = { teacher: 'Teacher', classteacher: 'Class Teacher', bursar: 'Bursar', examofficer: 'Examination Officer', admin: 'Administrator' };
    var currentRegRole = 'applicant';

    var adminRegTab = document.getElementById('adminRegTab');
    fsGetDoc('config', 'admin').then(function (admin) {
      if (adminRegTab) adminRegTab.style.display = admin ? 'none' : 'inline-flex';
      var regParams = new URLSearchParams(window.location.search);
      var regRequestedRole = regParams.get('role');
      if (regRequestedRole) showRegBlock(regRequestedRole, !!admin);
    }).catch(function () {
      if (adminRegTab) adminRegTab.style.display = 'inline-flex';
    });

    function rebuildSubjectsGrid() {
      var grid = document.getElementById('subjectsTickGrid');
      if (!grid) return;
      var checkedClasses = Array.from(document.querySelectorAll('#classesTickGrid input:checked')).map(function (i) { return i.value; });

      if (checkedClasses.length === 0) {
        grid.innerHTML = '<p class="field-hint" id="subjectsPlaceholder">Select one or more classes above to see the subjects taught at that level.</p>';
        return;
      }

      // Union of subjects across every ticked class, in first-seen order,
      // deduplicated (classes share a lot of overlapping subjects).
      var seen = {};
      var union = [];
      checkedClasses.forEach(function (cls) {
        (CLASS_SUBJECTS[cls] || []).forEach(function (subj) {
          if (!seen[subj]) { seen[subj] = true; union.push(subj); }
        });
      });

      // Preserve any subjects the teacher already ticked before changing
      // class selection, so switching classes doesn't silently lose their picks.
      var previouslyChecked = {};
      grid.querySelectorAll('input:checked').forEach(function (i) { previouslyChecked[i.value] = true; });

      grid.innerHTML = union.map(function (subj) {
        var checkedAttr = previouslyChecked[subj] ? ' checked' : '';
        return '<label class="tick-item"><input type="checkbox" name="subjects" value="' + subj + '"' + checkedAttr + '><span>' + subj + '</span></label>';
      }).join('');
    }

    function configureStaffTickLists(role) {
      var subjectsField = document.getElementById('subjectsTickGrid') ? document.getElementById('subjectsTickGrid').closest('.field-row') : null;
      var classesField = document.getElementById('classesTickGrid') ? document.getElementById('classesTickGrid').closest('.field-row') : null;
      var classesLegend = document.getElementById('classesLegend');
      var subjectsLegend = document.getElementById('subjectsLegend');
      if (!subjectsField || !classesField) return;

      if (role === 'bursar') {
        subjectsField.style.display = 'none';
        classesField.style.display = 'none';
        return;
      }
      subjectsField.style.display = '';
      classesField.style.display = '';

      var classInputs = document.querySelectorAll('#classesTickGrid input');
      if (role === 'classteacher') {
        classInputs.forEach(function (input) { input.type = 'radio'; });
        classesLegend.innerHTML = 'Class you will manage <small>(choose one)</small>';
        subjectsField.style.display = 'none';
      } else if (role === 'examofficer') {
        classInputs.forEach(function (input) { input.type = 'checkbox'; });
        classesLegend.innerHTML = 'Classes you will oversee results for <small>(tick all that apply)</small>';
        subjectsField.style.display = 'none';
      } else {
        classInputs.forEach(function (input) { input.type = 'checkbox'; });
        classesLegend.innerHTML = 'Classes you teach <small>(tick all that apply)</small>';
        subjectsLegend.innerHTML = 'Subjects you teach <small>(tick classes above first)</small>';
        rebuildSubjectsGrid();
      }
    }

    // Rebuild the subjects list whenever a class checkbox changes. Uses
    // event delegation since #classesTickGrid's inner inputs are replaced
    // whenever the role tab switches.
    document.addEventListener('change', function (e) {
      if (e.target && e.target.closest && e.target.closest('#classesTickGrid')) {
        rebuildSubjectsGrid();
      }
    });

    function showRegBlock(role, adminAlreadyExists) {
      if (role === 'admin' && adminAlreadyExists) role = 'applicant';
      currentRegRole = role;
      document.getElementById('regSuccess').style.display = 'none';
      regTabs.forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-role') === role); });
      var blockKey = ['teacher', 'classteacher', 'bursar', 'examofficer'].indexOf(role) > -1 ? 'staff' : role;
      regBlocks.forEach(function (b) {
        b.style.display = b.getAttribute('data-block') === blockKey ? 'block' : 'none';
      });
      if (blockKey === 'staff') {
        staffTitle.textContent = 'Request ' + STAFF_ROLE_LABELS[role] + ' access';
        configureStaffTickLists(role);
      }
    }
    regTabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var role = tab.getAttribute('data-role');
        if (role === 'admin') {
          fsGetDoc('config', 'admin').then(function (admin) { showRegBlock(role, !!admin); });
        } else {
          showRegBlock(role, false);
        }
      });
    });
    showRegBlock('applicant', false);

    function showFieldError(input, msg) {
      var box = input.closest('.field') ? input.closest('.field').querySelector('.field-error') : null;
      if (msg) { input.classList.add('has-error'); if (box) box.textContent = msg; return false; }
      input.classList.remove('has-error'); if (box) box.textContent = '';
      return true;
    }

    function showRegSuccess(title, body) {
      regBlocks.forEach(function (b) { b.style.display = 'none'; });
      var s = document.getElementById('regSuccess');
      document.getElementById('regSuccessTitle').textContent = title;
      document.getElementById('regSuccessBody').textContent = body;
      s.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ---------- STUDENT ACTIVATION ----------
    var studentForm = document.getElementById('studentRegForm');
    if (studentForm) {
      studentForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(studentForm);
        var matric = (fd.get('matric') || '').trim().toUpperCase();
        var email = (fd.get('email') || '').trim();
        var password = fd.get('password') || '';
        var confirm = fd.get('confirmPassword') || '';

        var ok = true;
        ok = showFieldError(studentForm.querySelector('[name="matric"]'), matric ? '' : 'Matric number is required.') && ok;
        ok = showFieldError(studentForm.querySelector('[name="email"]'), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address.') && ok;
        ok = showFieldError(studentForm.querySelector('[name="password"]'), password.length >= 8 ? '' : 'At least 8 characters.') && ok;
        ok = showFieldError(studentForm.querySelector('[name="confirmPassword"]'), password === confirm ? '' : 'Passwords do not match.') && ok;
        if (!ok) return;

        var submitBtn = studentForm.querySelector('button[type="submit"]');
        setBusy(submitBtn, true, 'Checking…');

        fsQueryEq('students', 'matric', matric).then(function (seedMatches) {
          var found = seedMatches[0];
          if (!found) {
            setBusy(submitBtn, false);
            showFieldError(studentForm.querySelector('[name="matric"]'), 'We could not find that matric number. It may not have been issued yet.');
            return;
          }
          var internalEmail = matricToInternalEmail(matric);
          var fa = window.mripAuth;
          return fa.createUserWithEmailAndPassword(fa.auth, internalEmail, password).then(function (cred) {
            return Promise.all([
              fsSetDoc('users', cred.user.uid, { role: 'student', matric: matric, contactEmail: email, fullName: found.fullName, classLabel: found.classLabel, classCode: found.classCode || '' }),
              fsUpdate('students', found.id, { userUid: cred.user.uid }).catch(function () { /* non-critical link-back */ })
            ]);
          }).then(function () {
            showRegSuccess('Student account activated', 'You can now log in with your matric number and password.');
          });
        }).catch(function (err) {
          setBusy(submitBtn, false);
          if (err.code === 'auth/email-already-in-use') {
            showFieldError(studentForm.querySelector('[name="matric"]'), 'An account already exists for this matric number. Try logging in.');
          } else {
            alert(friendlyAuthError(err));
          }
        });
      });
    }

    // ---------- PARENT REGISTRATION ----------
    var parentForm = document.getElementById('parentRegForm');
    if (parentForm) {
      parentForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(parentForm);
        var fullName = (fd.get('fullName') || '').trim();
        var email = (fd.get('email') || '').trim();
        var phone = (fd.get('phone') || '').trim();
        var studentMatric = (fd.get('studentMatric') || '').trim().toUpperCase();
        var password = fd.get('password') || '';
        var confirm = fd.get('confirmPassword') || '';

        var ok = true;
        ok = showFieldError(parentForm.querySelector('[name="fullName"]'), fullName ? '' : 'Full name is required.') && ok;
        ok = showFieldError(parentForm.querySelector('[name="email"]'), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address.') && ok;
        ok = showFieldError(parentForm.querySelector('[name="phone"]'), phone ? '' : 'Phone number is required.') && ok;
        ok = showFieldError(parentForm.querySelector('[name="studentMatric"]'), studentMatric ? '' : "Child's matric number is required.") && ok;
        ok = showFieldError(parentForm.querySelector('[name="password"]'), password.length >= 8 ? '' : 'At least 8 characters.') && ok;
        ok = showFieldError(parentForm.querySelector('[name="confirmPassword"]'), password === confirm ? '' : 'Passwords do not match.') && ok;
        if (!ok) return;

        var submitBtn = parentForm.querySelector('button[type="submit"]');
        setBusy(submitBtn, true, 'Checking…');

        fsQueryEq('students', 'matric', studentMatric).then(function (seedMatches) {
          var childFound = seedMatches[0];
          if (!childFound) {
            setBusy(submitBtn, false);
            showFieldError(parentForm.querySelector('[name="studentMatric"]'), 'We could not find a student with that matric number.');
            return;
          }
          var fa = window.mripAuth;
          return fa.createUserWithEmailAndPassword(fa.auth, email, password).then(function (cred) {
            return fsSetDoc('users', cred.user.uid, { role: 'parent', fullName: fullName, email: email, phone: phone, childMatric: studentMatric, childName: childFound.fullName });
          }).then(function () {
            showRegSuccess('Parent account created', 'You can now log in with your email and password to follow ' + childFound.fullName + "'s progress.");
          });
        }).catch(function (err) {
          setBusy(submitBtn, false);
          if (err.code === 'auth/email-already-in-use') {
            showFieldError(parentForm.querySelector('[name="email"]'), 'An account with this email already exists. Try logging in.');
          } else {
            alert(friendlyAuthError(err));
          }
        });
      });
    }

    // ---------- STAFF REQUEST ACCESS (no account yet — Admin creates it on approval) ----------
    var staffForm = document.getElementById('staffRegForm');
    if (staffForm) {
      staffForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(staffForm);
        var fullName = (fd.get('fullName') || '').trim();
        var email = (fd.get('email') || '').trim();
        var phone = (fd.get('phone') || '').trim();

        var ok = true;
        ok = showFieldError(staffForm.querySelector('[name="fullName"]'), fullName ? '' : 'Full name is required.') && ok;
        ok = showFieldError(staffForm.querySelector('[name="email"]'), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address.') && ok;
        ok = showFieldError(staffForm.querySelector('[name="phone"]'), phone ? '' : 'Phone number is required.') && ok;

        var selectedSubjects = Array.from(staffForm.querySelectorAll('input[name="subjects"]:checked')).map(function (i) { return i.value; });
        var selectedClasses = Array.from(staffForm.querySelectorAll('input[name="classes"]:checked')).map(function (i) { return i.value; });

        var subjectsError = document.getElementById('subjectsError');
        var classesError = document.getElementById('classesError');
        if (subjectsError) subjectsError.textContent = '';
        if (classesError) classesError.textContent = '';

        var subjectsVisible = document.getElementById('subjectsTickGrid') && document.getElementById('subjectsTickGrid').closest('.field-row').style.display !== 'none';
        var classesVisible = document.getElementById('classesTickGrid') && document.getElementById('classesTickGrid').closest('.field-row').style.display !== 'none';

        if (subjectsVisible && selectedSubjects.length === 0) {
          if (subjectsError) subjectsError.textContent = 'Tick at least one subject.';
          ok = false;
        }
        if (classesVisible && selectedClasses.length === 0) {
          if (classesError) classesError.textContent = currentRegRole === 'classteacher' ? 'Choose the class you will manage.' : 'Tick at least one class.';
          ok = false;
        }
        if (!ok) return;

        var submitBtn = staffForm.querySelector('button[type="submit"]');
        setBusy(submitBtn, true, 'Submitting…');

        fsAdd('staffRequests', {
          role: currentRegRole,
          roleLabel: STAFF_ROLE_LABELS[currentRegRole],
          fullName: fullName, email: email, phone: phone,
          employeeId: fd.get('employeeId') || '',
          subjects: selectedSubjects,
          classes: selectedClasses,
          note: fd.get('note') || '',
          status: 'Pending Approval',
          submittedAt: new Date().toISOString()
        }).then(function () {
          showRegSuccess('Request submitted', 'Your request for ' + STAFF_ROLE_LABELS[currentRegRole] + ' access has been sent to the Administrator for approval.');
        }).catch(function (err) {
          setBusy(submitBtn, false);
          alert('Something went wrong: ' + err.message);
        });
      });
    }

    // ---------- ADMINISTRATOR ONE-TIME SETUP ----------
    var adminSetupForm = document.getElementById('adminSetupForm');
    if (adminSetupForm) {
      adminSetupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(adminSetupForm);
        var fullName = (fd.get('fullName') || '').trim();
        var email = (fd.get('email') || '').trim();
        var phone = (fd.get('phone') || '').trim();
        var password = fd.get('password') || '';
        var confirm = fd.get('confirmPassword') || '';

        var ok = true;
        ok = showFieldError(adminSetupForm.querySelector('[name="fullName"]'), fullName ? '' : 'Full name is required.') && ok;
        ok = showFieldError(adminSetupForm.querySelector('[name="email"]'), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address.') && ok;
        ok = showFieldError(adminSetupForm.querySelector('[name="phone"]'), phone ? '' : 'Phone number is required.') && ok;
        ok = showFieldError(adminSetupForm.querySelector('[name="password"]'), password.length >= 8 ? '' : 'At least 8 characters.') && ok;
        ok = showFieldError(adminSetupForm.querySelector('[name="confirmPassword"]'), password === confirm ? '' : 'Passwords do not match.') && ok;
        if (!ok) return;

        var submitBtn = adminSetupForm.querySelector('button[type="submit"]');
        setBusy(submitBtn, true, 'Creating…');

        fsGetDoc('config', 'admin').then(function (existing) {
          if (existing) {
            setBusy(submitBtn, false);
            showRegSuccess('Administrator already exists', 'An Administrator account has already been set up for this school. Please log in instead.');
            return;
          }
          var fa = window.mripAuth;
          var createdUid = null;
          return fa.createUserWithEmailAndPassword(fa.auth, email, password).then(function (cred) {
            createdUid = cred.user.uid;
            return fsSetDoc('config', 'admin', { fullName: fullName, email: email, phone: phone, uid: createdUid, createdAt: new Date().toISOString() });
          }).then(function () {
            showRegSuccess('Administrator account created', 'You can now log in as Administrator. This setup option will no longer appear for future visitors.');
          }).catch(function (err) {
            // Firestore rejected the write — most likely a race where someone
            // else's admin doc was created first. The Auth account still
            // exists but grants no admin capability without the doc.
            throw err;
          });
        }).catch(function (err) {
          setBusy(submitBtn, false);
          if (err.code === 'auth/email-already-in-use') {
            showFieldError(adminSetupForm.querySelector('[name="email"]'), 'An account with this email already exists.');
          } else if (err.code === 'permission-denied') {
            showRegSuccess('Administrator already exists', 'Someone else just completed this setup a moment ago. Please log in instead.');
          } else {
            alert(friendlyAuthError(err));
          }
        });
      });
    }
  }

})();
