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
    return 'MRIP-APP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
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
        { matric: 'MDU/26/IDD/0001', fullName: 'Demo Student One', classLabel: 'الصف الثاني الإعدادي — Second Preparatory' },
        { matric: 'MDU/26/THN/0001', fullName: 'Demo Student Two', classLabel: 'الصف الأول الثانوي — First Secondary' }
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
      var section = selectedOption ? selectedOption.getAttribute('data-section') : 'TDR';
      var year = new Date().getFullYear();
      var email = fd.get('email').trim();
      var password = fd.get('password');

      waitForDb().then(function () {
        var fa = window.mripAuth;
        return fa.createUserWithEmailAndPassword(fa.auth, email, password);
      }).then(function (cred) {
        var uid = cred.user.uid;
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
          submittedAt: new Date().toISOString()
        };
        return fsSetDoc('applicants', uid, record).then(function () { return record; });
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

    var roleLabels = {
      applicant: 'Applicant Portal', student: 'Student Portal', parent: 'Parent Portal',
      teacher: 'Teacher Portal', classteacher: 'Class Teacher Portal', bursar: 'Bursar Portal', admin: 'Administrator Portal'
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
        document.getElementById('dashSubtext').textContent = 'Track your application status below.';
        var statusClass = profile.status === 'Verified' ? 'status-verified' : profile.status === 'Rejected' ? 'status-rejected' : 'status-pending';
        var paymentSummaryBtn = profile.status === 'Verified'
          ? '<div class="dash-card dash-card-wide" style="text-align:center;"><button class="btn btn-gold" type="button" id="viewPaymentSummaryBtn">View / Print Payment Summary</button></div>'
          : '';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Application Reference</h3><div class="dash-stat" style="font-size:1.15rem;">' + profile.ref + '</div></div>' +
          '<div class="dash-card"><h3>Payment Status</h3><span class="status-badge ' + statusClass + '">' + profile.status + '</span></div>' +
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
          paymentSummaryBtn +
          (profile.status === 'Pending Verification'
            ? '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Your admission fee payment is pending verification by the Bursar. Once approved, your permanent matric number will be issued.</div>'
            : '');

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

      } else {
        document.getElementById('dashSubtext').textContent = (roleLabels[role] || 'Staff') + ' — assigned classes and subjects below.';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Assigned Subjects</h3><div class="dash-stat" style="font-size:1rem;">' + ((profile.subjects || []).map(function (s) { return SUBJECT_LABELS[s] || s; }).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Assigned Classes</h3><div class="dash-stat" style="font-size:1rem;">' + ((profile.classes || []).map(function (c) { return CLASS_LABELS[c] || c; }).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results entry, and class rosters will appear here once connected to the school\'s academic records system.</div>';
      }
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

    function renderAdminDashboard() {
      Promise.all([fsGetAll('staffRequests'), fsGetAll('applicants')]).then(function (results) {
        var requests = results[0];
        var applicants = results[1];
        var pending = requests.filter(function (r) { return r.status === 'Pending Approval'; });
        var pendingApplicants = applicants.filter(function (a) { return a.status === 'Pending Verification'; });

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
              return '<tr data-app-id="' + a.id + '">' +
                '<td>' + a.fullName + '</td>' +
                '<td>' + a.email + '</td>' +
                '<td>' + a.classLabel + '</td>' +
                '<td>' + new Date(a.submittedAt).toLocaleDateString() + '</td>' +
                '<td style="white-space:nowrap;">' +
                  '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-view-app="' + a.id + '">View Details</button> ' +
                  '<button class="btn btn-gold" style="padding:6px 12px; font-size:0.78rem;" data-approve-app="' + a.id + '">Approve & Issue Matric No.</button> ' +
                  '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-reject-app="' + a.id + '">Reject</button>' +
                '</td></tr>';
            }).join('')
          : '<tr><td colspan="5" style="text-align:center; color:var(--ink-soft);">No pending applicants.</td></tr>';

        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Pending Access Requests' + notifBadge + '</h3><div class="dash-stat">' + pending.length + '</div><div class="dash-stat-label">Awaiting your review</div></div>' +
          '<div class="dash-card"><h3>Pending Admission Payments</h3><div class="dash-stat">' + pendingApplicants.length + '</div><div class="dash-stat-label">Awaiting verification</div></div>' +
          '<div class="dash-card"><h3>Total Applicants</h3><div class="dash-stat">' + applicants.length + '</div><div class="dash-stat-label">All time</div></div>' +
          '<div class="dash-card dash-card-wide">' +
            '<h3>Pending Applicants</h3>' +
            '<table class="dash-table" id="appTable">' +
              '<tr><th>Name</th><th>Email</th><th>Class Applied</th><th>Submitted</th><th>Action</th></tr>' +
              appRows +
            '</table>' +
          '</div>' +
          '<div class="dash-card dash-card-wide">' +
            '<h3>Record a Payment</h3>' +
            '<p style="font-size:0.85rem; color:var(--ink-soft); margin-bottom:16px;">Log a payment against a student\'s matric number — school fees, examination fees, graduation fees, certificate fees, or any other payment.</p>' +
            '<form id="recordPaymentForm">' +
              '<div class="field-row two-col">' +
                '<label class="field"><span>Student Matric Number <em>*</em></span><input type="text" name="matric" placeholder="e.g. MDU/26/IDD/0001" required><small class="field-error" id="payMatricError"></small></label>' +
                '<label class="field"><span>Payment Type <em>*</em></span><select name="paymentType" required>' +
                  '<option value="">Select type</option>' +
                  '<option value="School Fee">School Fee</option>' +
                  '<option value="Examination Fee">Examination Fee</option>' +
                  '<option value="Graduation Fee">Graduation Fee</option>' +
                  '<option value="Certificate Fee">Certificate Fee</option>' +
                  '<option value="Other">Other</option>' +
                '</select></label>' +
              '</div>' +
              '<div class="field-row two-col" style="margin-top:16px;">' +
                '<label class="field"><span>Amount (₦) <em>*</em></span><input type="number" name="amount" min="0" step="1" required></label>' +
                '<label class="field"><span>Payment Date <em>*</em></span><input type="date" name="paymentDate" required></label>' +
              '</div>' +
              '<label class="field" style="margin-top:16px;"><span>Description <small>(optional)</small></span><input type="text" name="description" placeholder="e.g. Second term school fees"></label>' +
              '<label class="field" style="margin-top:16px;"><span>Transaction Reference <small>(optional)</small></span><input type="text" name="reference"></label>' +
              '<button type="submit" class="btn btn-gold" style="margin-top:16px;">Record Payment</button>' +
            '</form>' +
          '</div>' +
          '<div class="dash-card dash-card-wide">' +
            '<h3>Staff Access Requests</h3>' +
            '<table class="dash-table" id="reqTable">' +
              '<tr><th>Role</th><th>Name</th><th>Email</th><th>Assignment</th><th>Submitted</th><th>Action</th></tr>' +
              reqRows +
            '</table>' +
          '</div>';

        var recordPaymentForm = document.getElementById('recordPaymentForm');
        if (recordPaymentForm) {
          recordPaymentForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var fd = new FormData(recordPaymentForm);
            var matric = (fd.get('matric') || '').trim().toUpperCase();
            var paymentType = fd.get('paymentType');
            var amount = Number(fd.get('amount'));
            var paymentDate = fd.get('paymentDate');
            var description = fd.get('description') || '';
            var reference = fd.get('reference') || '';
            var matricError = document.getElementById('payMatricError');
            matricError.textContent = '';

            if (!matric) { matricError.textContent = 'Matric number is required.'; return; }

            var submitBtn = recordPaymentForm.querySelector('button[type="submit"]');
            setBusy(submitBtn, true, 'Looking up student…');

            fsQueryEq('students', 'matric', matric).then(function (matches) {
              var student = matches[0];
              if (!student) {
                setBusy(submitBtn, false);
                matricError.textContent = 'No student found with that matric number.';
                return;
              }
              return fsAdd('payments', {
                studentMatric: matric,
                studentName: student.fullName,
                classLabel: student.classLabel,
                paymentType: paymentType,
                description: description || paymentType,
                amount: amount,
                currency: 'NGN',
                paymentDate: new Date(paymentDate).toISOString(),
                reference: reference,
                recordedBy: 'Administrator',
                recordedAt: new Date().toISOString()
              }).then(function () {
                alert('Payment recorded for ' + student.fullName + ' (' + matric + ').');
                recordPaymentForm.reset();
                setBusy(submitBtn, false);
              });
            }).catch(function (err) {
              setBusy(submitBtn, false);
              alert('Could not record payment: ' + err.message);
            });
          });
        }

        dashGrid.querySelectorAll('[data-view-req]').forEach(function (btn) {
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

        dashGrid.querySelectorAll('[data-view-app]').forEach(function (btn) {
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
              ['Submitted', new Date(a.submittedAt).toLocaleString()],
              ['Status', a.status]
            ]);
          });
        });

        dashGrid.querySelectorAll('[data-approve]').forEach(function (btn) {
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
        dashGrid.querySelectorAll('[data-reject]').forEach(function (btn) {
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

        dashGrid.querySelectorAll('[data-approve-app]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-approve-app');
            var applicant = applicants.find(function (a) { return a.id === id; });
            if (!applicant) return;
            btn.disabled = true;
            btn.textContent = 'Issuing…';

            // Matric number sequence increments independently per admission
            // year and per section, and never changes once issued. Counted
            // by matching the matric string prefix directly, so it works
            // correctly regardless of how older/seed records were stored.
            var prefix = 'MDU/' + applicant.matricYear + '/' + applicant.matricSection + '/';
            fsGetAll('students').then(function (allStudents) {
              var sameSectionYear = allStudents.filter(function (s) { return (s.matric || '').indexOf(prefix) === 0; });
              var seq = String(sameSectionYear.length + 1).padStart(4, '0');
              var matric = prefix + seq;

              return fsAdd('students', {
                matric: matric,
                fullName: applicant.fullName,
                classLabel: applicant.classLabel,
                matricSection: applicant.matricSection,
                matricYear: applicant.matricYear,
                issuedAt: new Date().toISOString()
              }).then(function () {
                return fsUpdate('applicants', id, { status: 'Verified', matric: matric, verifiedAt: new Date().toISOString() });
              }).then(function () {
                return fsAdd('payments', {
                  studentMatric: matric,
                  studentName: applicant.fullName,
                  classLabel: applicant.classLabel,
                  paymentType: 'Admission Fee',
                  description: 'Non-refundable admission fee',
                  amount: 10000,
                  currency: 'NGN',
                  paymentDate: applicant.submittedAt,
                  admissionDate: new Date().toISOString(),
                  reference: applicant.ref,
                  recordedBy: 'System (Admission Approval)',
                  recordedAt: new Date().toISOString()
                });
              }).then(function () {
                alert(
                  applicant.fullName + ' has been approved.\n\n' +
                  'Matric Number: ' + matric + '\n\n' +
                  'Share this with the applicant so they can activate their Student account on the Register page (no email service is connected yet, so this is not sent automatically).'
                );
                renderAdminDashboard();
              });
            }).catch(function (err) {
              alert('Could not approve this applicant: ' + err.message);
              btn.disabled = false;
              btn.textContent = 'Approve & Issue Matric No.';
            });
          });
        });
        dashGrid.querySelectorAll('[data-reject-app]').forEach(function (btn) {
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
        dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">Could not load dashboard data. Check your connection and refresh.</div>';
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
    var STAFF_ROLE_LABELS = { teacher: 'Teacher', classteacher: 'Class Teacher', bursar: 'Bursar', admin: 'Administrator' };
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
      var blockKey = ['teacher', 'classteacher', 'bursar'].indexOf(role) > -1 ? 'staff' : role;
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
            return fsSetDoc('users', cred.user.uid, { role: 'student', matric: matric, contactEmail: email, fullName: found.fullName, classLabel: found.classLabel });
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
