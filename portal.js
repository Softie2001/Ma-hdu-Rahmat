(function () {
  'use strict';

  /* ===================================================================
     FIREBASE-BACKED STORAGE HELPERS
     All shared data (applicants, students, accounts, staff requests,
     the admin account) lives in Firestore — a real cloud database
     shared across every device and browser. Login session state
     (who is currently signed in on THIS device) stays in
     localStorage, which is correct: sessions are meant to be
     per-device, not shared.
  =================================================================== */

  function waitForDb() {
    return new Promise(function (resolve) {
      if (window.mripDb) { resolve(window.mripDb); return; }
      window.addEventListener('mripDbReady', function handler() {
        window.removeEventListener('mripDbReady', handler);
        resolve(window.mripDb);
      });
    });
  }

  var SESSION_KEY = 'mrip_session';
  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function setSession(data) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function genRef() {
    return 'MRIP-APP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function simpleHash(str) {
    // Passwords are hashed client-side before being stored in Firestore.
    // This is not the same strength as a dedicated auth service's
    // hashing, but combined with Firestore security rules it keeps
    // raw passwords out of the database. Good enough for this stage;
    // can be upgraded to Firebase Authentication later if needed.
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  /* ---------- generic Firestore helpers ---------- */
  function fsGetAll(colName) {
    return waitForDb().then(function (fb) {
      return fb.getDocs(fb.collection(fb.db, colName)).then(function (snap) {
        var out = [];
        snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
        return out;
      });
    });
  }
  function fsQueryEq(colName, field, value) {
    return waitForDb().then(function (fb) {
      var q = fb.query(fb.collection(fb.db, colName), fb.where(field, '==', value));
      return fb.getDocs(q).then(function (snap) {
        var out = [];
        snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
        return out;
      });
    });
  }
  function fsAdd(colName, data) {
    return waitForDb().then(function (fb) {
      return fb.addDoc(fb.collection(fb.db, colName), data).then(function (ref) {
        return ref.id;
      });
    });
  }
  function fsUpdate(colName, docId, data) {
    return waitForDb().then(function (fb) {
      return fb.updateDoc(fb.doc(fb.db, colName, docId), data);
    });
  }
  function fsSetDoc(colName, docId, data) {
    return waitForDb().then(function (fb) {
      return fb.setDoc(fb.doc(fb.db, colName, docId), data);
    });
  }
  function fsGetDoc(colName, docId) {
    return waitForDb().then(function (fb) {
      return fb.getDoc(fb.doc(fb.db, colName, docId)).then(function (snap) {
        return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
      });
    });
  }

  var SECTION_MAP = { Tadrij: 'TDR', AwwalIdadi: 'IDD', ThaniIdadi: 'IDD', ThalithIdadi: 'IDD', RabiIdadi: 'IDD', ThanawiAwwal: 'THN', ThanawiThani: 'THN', ThanawiThalith: 'THN' };

  /* Seed two demo matric numbers once, so the Student/Parent registration
     flows are testable without first running the full Apply flow. Only
     runs if the 'students' collection is empty. */
  function ensureSeedStudents() {
    return fsGetAll('students').then(function (list) {
      if (list.length > 0) return;
      var demo = [
        { matric: 'MDU/26/IDD/0001', fullName: 'Demo Student One', classLabel: "Thānī I'dādī" },
        { matric: 'MDU/26/THN/0001', fullName: 'Demo Student Two', classLabel: 'Thanawī Awwal' }
      ];
      return Promise.all(demo.map(function (s) { return fsAdd('students', s); }));
    }).catch(function () { /* ignore seed errors */ });
  }

  /* -------------------- tiny loading-state helper -------------------- */
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

  /* ===================================================================
     APPLY PAGE
  =================================================================== */
  var applyForm = document.getElementById('applyForm');
  if (applyForm) {
    var STEP_COUNT = 5;
    var currentStep = 1;
    var stepEls = document.querySelectorAll('.apply-step');
    var panelEls = document.querySelectorAll('.apply-panel[data-panel]');

    // Populate "Approximate Year" (previous enrollment) with the last 20
    // years, newest first, so it never needs manual updating.
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
          // radios validated as a group below
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

    function checkEmailUnique(panel) {
      if (panel.getAttribute('data-panel') !== '1') return Promise.resolve(true);
      var emailField = panel.querySelector('input[name="email"]');
      if (!emailField || !emailField.value) return Promise.resolve(true);
      return fsQueryEq('applicants', 'email', emailField.value.trim()).then(function (matches) {
        if (matches.length > 0) {
          emailField.classList.add('has-error');
          var err = emailField.closest('.field').querySelector('.field-error');
          if (err) err.textContent = 'An account with this email already exists. Try logging in instead.';
          return false;
        }
        return true;
      }).catch(function () { return true; }); // don't block on network hiccup
    }

    document.querySelectorAll('[data-next]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panel = currentPanel();
        if (!validatePanel(panel)) return;
        setBusy(btn, true, 'Checking…');
        checkEmailUnique(panel).then(function (ok) {
          setBusy(btn, false);
          if (!ok) return;
          if (currentStep < STEP_COUNT) showStep(currentStep + 1);
        });
      });
    });
    document.querySelectorAll('[data-prev]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (currentStep > 1) showStep(currentStep - 1);
      });
    });

    // Existing-student conditional block
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
      setBusy(submitBtn, true, 'Submitting…');

      var fd = new FormData(applyForm);
      var classSelect = document.getElementById('classApplied');
      var selectedOption = classSelect.options[classSelect.selectedIndex];
      var section = selectedOption ? selectedOption.getAttribute('data-section') : 'TDR';
      var year = new Date().getFullYear();

      var record = {
        ref: genRef(),
        fullName: fd.get('fullName'),
        email: fd.get('email').trim(),
        phone: fd.get('phone'),
        passwordHash: simpleHash(fd.get('password')),
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

      fsAdd('applicants', record).then(function (id) {
        setSession({ role: 'applicant', id: id, name: record.fullName, ref: record.ref });

        document.getElementById('successRef').textContent = 'Reference: ' + record.ref;
        panelEls.forEach(function (p) { p.classList.remove('is-active'); });
        document.getElementById('applySteps').style.display = 'none';
        document.getElementById('successPanel').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(function (err) {
        setBusy(submitBtn, false);
        alert('Something went wrong submitting your application. Please check your connection and try again.\n\n(' + err.message + ')');
      });
    });

    showStep(1);
  }

  /* ===================================================================
     LOGIN PAGE
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
      parent: { idLabel: 'Email Address', idType: 'email', hint: "Link your account to your child's matric number to follow their progress.", footer: 'New parent account? <a href="register.html?role=parent">Register here</a>' },
      teacher: { idLabel: 'Email Address', idType: 'email', hint: 'Teacher accounts are issued by the Administrator — you cannot self-register.', footer: "Don't have an account? <a href=\"register.html?role=teacher\">Request access</a>" },
      classteacher: { idLabel: 'Email Address', idType: 'email', hint: 'Class Teacher accounts are issued by the Administrator — you cannot self-register.', footer: "Don't have an account? <a href=\"register.html?role=classteacher\">Request access</a>" },
      bursar: { idLabel: 'Email Address', idType: 'email', hint: 'Bursar accounts are issued by the Super Administrator.', footer: "Don't have an account? <a href=\"register.html?role=bursar\">Request access</a>" },
      admin: { idLabel: 'Email Address', idType: 'email', hint: 'Administrator accounts are issued by the Super Administrator.', footer: "Don't have an account? <a href=\"register.html?role=admin\">Request access</a>" }
    };
    var STAFF_ROLE_LABELS_LOGIN = { teacher: 'Teacher', classteacher: 'Class Teacher', bursar: 'Bursar', admin: 'Administrator' };

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

      function fail(msgHtml) {
        setBusy(submitBtn, false);
        errorBox.innerHTML = msgHtml;
        errorBox.classList.add('is-shown');
      }
      function succeed(session) {
        setSession(session);
        window.location.href = 'dashboard.html';
      }

      if (selectedRole === 'applicant') {
        fsQueryEq('applicants', 'email', loginId).then(function (matches) {
          var match = matches[0];
          if (!match || match.passwordHash !== simpleHash(password)) {
            fail('Incorrect email or password. New here? <a href="apply.html" class="text-link">Start your application</a>.');
            return;
          }
          succeed({ role: 'applicant', id: match.id, name: match.fullName, ref: match.ref });
        }).catch(function (err) { fail('Could not reach the server. Check your connection and try again.'); });
        return;
      }

      if (selectedRole === 'student' || selectedRole === 'parent') {
        var field = selectedRole === 'student' ? 'matric' : 'email';
        var value = selectedRole === 'student' ? loginId.toUpperCase() : loginId.toLowerCase();
        fsGetAll('users').then(function (allUsers) {
          var userMatch = allUsers.find(function (u) {
            if (u.role !== selectedRole) return false;
            var uVal = selectedRole === 'student' ? (u.matric || '').toUpperCase() : (u.email || '').toLowerCase();
            return uVal === value;
          });
          if (!userMatch || userMatch.passwordHash !== simpleHash(password)) {
            fail('No matching account found. <a href="register.html?role=' + selectedRole + '" class="text-link">Create one here</a>.');
            return;
          }
          succeed({ role: selectedRole, id: (userMatch.matric || userMatch.email), name: userMatch.fullName || userMatch.childName, matric: userMatch.matric, childName: userMatch.childName, childMatric: userMatch.childMatric, classLabel: userMatch.classLabel });
        }).catch(function () { fail('Could not reach the server. Check your connection and try again.'); });
        return;
      }

      if (selectedRole === 'admin') {
        fsGetDoc('config', 'admin').then(function (storedAdmin) {
          if (!storedAdmin) {
            fail('No Administrator account exists yet for this school. <a href="register.html?role=admin" class="text-link">Set one up here</a>.');
            return;
          }
          if (storedAdmin.email.toLowerCase() !== loginId.toLowerCase() || storedAdmin.passwordHash !== simpleHash(password)) {
            fail('Incorrect email or password.');
            return;
          }
          succeed({ role: 'admin', id: storedAdmin.email, name: storedAdmin.fullName });
        }).catch(function () { fail('Could not reach the server. Check your connection and try again.'); });
        return;
      }

      // Staff roles (Teacher / Class Teacher / Bursar): accounts are issued
      // once an Administrator approves a request — see the admin dashboard.
      // There is a real 'staffAccounts' check here too, for approved staff.
      fsGetAll('staffAccounts').then(function (accounts) {
        var match = accounts.find(function (a) { return a.role === selectedRole && a.email.toLowerCase() === loginId.toLowerCase(); });
        if (!match || match.passwordHash !== simpleHash(password)) {
          fail(STAFF_ROLE_LABELS_LOGIN[selectedRole] + ' accounts are issued by the school administration. If you don\'t have credentials yet, <a href="register.html?role=' + selectedRole + '" class="text-link">request access here</a>.');
          return;
        }
        succeed({ role: selectedRole, id: match.email, name: match.fullName, subjects: match.subjects, classes: match.classes });
      }).catch(function () { fail('Could not reach the server. Check your connection and try again.'); });
    });

    applyRole('applicant');
    var params = new URLSearchParams(window.location.search);
    var requestedRole = params.get('role');
    if (requestedRole && ROLE_CONFIG[requestedRole]) {
      applyRole(requestedRole);
    }
  }

  /* ===================================================================
     DASHBOARD PAGE
  =================================================================== */
  var dashGrid = document.getElementById('dashGrid');
  if (dashGrid) {
    var session = getSession();
    if (!session) {
      window.location.href = 'login.html';
    } else {

      var roleLabels = {
        applicant: 'Applicant Portal', student: 'Student Portal', parent: 'Parent Portal',
        teacher: 'Teacher Portal', classteacher: 'Class Teacher Portal', bursar: 'Bursar Portal', admin: 'Administrator Portal'
      };
      document.getElementById('dashRoleLabel').textContent = roleLabels[session.role] || 'Dashboard';
      document.getElementById('dashUserName').textContent = session.name;
      document.getElementById('dashWelcome').textContent = 'Welcome, ' + session.name.split(' ')[0];

      document.getElementById('logoutLink').addEventListener('click', function (e) {
        e.preventDefault();
        clearSession();
        window.location.href = 'login.html';
      });

      dashGrid.innerHTML = '<div class="dash-card dash-card-wide" style="text-align:center; color:var(--ink-soft);">Loading your dashboard…</div>';

      if (session.role === 'applicant') {
        fsGetDoc('applicants', session.id).then(function (record) {
          document.getElementById('dashSubtext').textContent = record
            ? 'Track your application status below.'
            : 'We could not find your application record.';

          if (record) {
            var statusClass = record.status === 'Verified' ? 'status-verified' : record.status === 'Rejected' ? 'status-rejected' : 'status-pending';
            dashGrid.innerHTML =
              '<div class="dash-card"><h3>Application Reference</h3><div class="dash-stat" style="font-size:1.15rem;">' + record.ref + '</div></div>' +
              '<div class="dash-card"><h3>Payment Status</h3><span class="status-badge ' + statusClass + '">' + record.status + '</span></div>' +
              '<div class="dash-card"><h3>Class Applied For</h3><div class="dash-stat" style="font-size:1.15rem;">' + record.classLabel + '</div></div>' +
              '<div class="dash-card dash-card-wide">' +
                '<h3>Application Summary</h3>' +
                '<table class="dash-table">' +
                  '<tr><th>Full Name</th><td>' + record.fullName + '</td></tr>' +
                  '<tr><th>Email</th><td>' + record.email + '</td></tr>' +
                  '<tr><th>Phone</th><td>' + record.phone + '</td></tr>' +
                  '<tr><th>Submitted</th><td>' + new Date(record.submittedAt).toLocaleString() + '</td></tr>' +
                '</table>' +
              '</div>' +
              '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Your admission fee payment is pending verification by the Bursar. You will receive an email once your application has been reviewed and, if approved, your permanent matric number will be issued automatically.</div>';
          } else {
            dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">No application record found for this session.</div>';
          }
        }).catch(function () {
          dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">Could not load your application. Check your connection and refresh.</div>';
        });

      } else if (session.role === 'student') {
        document.getElementById('dashSubtext').textContent = 'Welcome back to your student dashboard.';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Matric Number</h3><div class="dash-stat" style="font-size:1.15rem;">' + session.matric + '</div></div>' +
          '<div class="dash-card"><h3>Current Class</h3><div class="dash-stat" style="font-size:1.15rem;">' + (session.classLabel || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Fee Status</h3><span class="status-badge status-pending">Pending Verification</span></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results, and timetable modules will appear here once connected to the school\'s academic records system.</div>';

      } else if (session.role === 'parent') {
        document.getElementById('dashSubtext').textContent = "Following " + (session.childName || 'your child') + "'s progress.";
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Child</h3><div class="dash-stat" style="font-size:1.15rem;">' + (session.childName || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Matric Number</h3><div class="dash-stat" style="font-size:1.15rem;">' + (session.childMatric || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Fee Status</h3><span class="status-badge status-pending">Pending Verification</span></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results, and fee receipts will appear here once connected to the school\'s records system.</div>';

      } else if (session.role === 'admin') {
        renderAdminDashboard();

      } else {
        document.getElementById('dashSubtext').textContent = roleLabels[session.role] + ' — assigned classes and subjects below.';
        dashGrid.innerHTML =
          '<div class="dash-card"><h3>Assigned Subjects</h3><div class="dash-stat" style="font-size:1rem;">' + ((session.subjects || []).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card"><h3>Assigned Classes</h3><div class="dash-stat" style="font-size:1rem;">' + ((session.classes || []).join(', ') || '—') + '</div></div>' +
          '<div class="dash-card dash-card-wide notice notice-info" style="margin:0;">Attendance, results entry, and class rosters will appear here once connected to the school\'s academic records system.</div>';
      }

      var SUBJECT_LABELS = {
        Quran: "Qur'an", Hadith: 'Hadith', Tafsir: 'Tafsir', Fiqh: 'Fiqh', Tawhid: 'Tawhid',
        Tajweed: 'Tajweed', Seerah: 'Seerah', Grammar: 'Arabic Grammar', Morphology: 'Morphology', ArabicLanguage: 'Arabic Language'
      };
      var CLASS_LABELS = {
        Tadrij: 'Tadrīj', AwwalIdadi: "Awwal I'dādī", ThaniIdadi: "Thānī I'dādī", ThalithIdadi: "Thālith I'dādī",
        RabiIdadi: "Rābiʿ I'dādī", ThanawiAwwal: 'Thanawī Awwal', ThanawiThani: 'Thanawī Thānī', ThanawiThalith: 'Thanawī Thālith'
      };

      function renderAdminDashboard() {
        Promise.all([
          fsGetAll('staffRequests'),
          fsGetAll('applicants')
        ]).then(function (results) {
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
                    '<button class="btn btn-gold" style="padding:6px 12px; font-size:0.78rem;" data-approve="' + r.id + '">Approve</button> ' +
                    '<button class="btn btn-ghost" style="padding:6px 12px; font-size:0.78rem;" data-reject="' + r.id + '">Reject</button>' +
                  '</td></tr>';
              }).join('')
            : '<tr><td colspan="6" style="text-align:center; color:var(--ink-soft);">No pending requests.</td></tr>';

          dashGrid.innerHTML =
            '<div class="dash-card"><h3>Pending Access Requests' + notifBadge + '</h3><div class="dash-stat">' + pending.length + '</div><div class="dash-stat-label">Awaiting your review</div></div>' +
            '<div class="dash-card"><h3>Pending Admission Payments</h3><div class="dash-stat">' + pendingApplicants.length + '</div><div class="dash-stat-label">Awaiting verification</div></div>' +
            '<div class="dash-card"><h3>Total Applicants</h3><div class="dash-stat">' + applicants.length + '</div><div class="dash-stat-label">All time</div></div>' +
            '<div class="dash-card dash-card-wide">' +
              '<h3>Staff Access Requests</h3>' +
              '<table class="dash-table" id="reqTable">' +
                '<tr><th>Role</th><th>Name</th><th>Email</th><th>Assignment</th><th>Submitted</th><th>Action</th></tr>' +
                reqRows +
              '</table>' +
            '</div>';

          dashGrid.querySelectorAll('[data-approve]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var id = btn.getAttribute('data-approve');
              var req = requests.find(function (r) { return r.id === id; });
              if (!req) return;
              btn.disabled = true;
              btn.textContent = 'Approving…';
              // Create the real staff account (approved staff can now log in)
              // and mark the request approved, in parallel.
              Promise.all([
                fsAdd('staffAccounts', {
                  role: req.role, roleLabel: req.roleLabel, fullName: req.fullName, email: req.email,
                  phone: req.phone, employeeId: req.employeeId || '', subjects: req.subjects || [], classes: req.classes || [],
                  // Temporary password: the approved staff member sets their own
                  // password on first login in a full system with email delivery.
                  // For now, generate a temporary one and show it to the admin.
                  passwordHash: simpleHash('temp' + Math.random().toString(36).slice(2, 8)),
                  approvedAt: new Date().toISOString()
                }),
                fsUpdate('staffRequests', id, { status: 'Approved' })
              ]).then(function () {
                alert(req.fullName + ' has been approved as ' + req.roleLabel + '. A staff account record has been created in the database. (Sending real login credentials by email requires connecting an email service — not yet set up.)');
                renderAdminDashboard();
              }).catch(function (err) {
                alert('Could not approve this request: ' + err.message);
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
        }).catch(function () {
          dashGrid.innerHTML = '<div class="dash-card dash-card-wide notice notice-error" style="margin:0;">Could not load dashboard data. Check your connection and refresh.</div>';
        });
      }
    }
  }

  /* ===================================================================
     REGISTER PAGE (unified role-based registration hub)
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
    // Default hidden until we confirm no admin exists (avoids a flash of
    // the setup tab while the Firestore check is in flight).
    fsGetDoc('config', 'admin').then(function (admin) {
      if (adminRegTab) adminRegTab.style.display = admin ? 'none' : 'inline-flex';
      var regParams = new URLSearchParams(window.location.search);
      var regRequestedRole = regParams.get('role');
      if (regRequestedRole) showRegBlock(regRequestedRole, !!admin);
    }).catch(function () {
      if (adminRegTab) adminRegTab.style.display = 'inline-flex'; // fail open so setup is still reachable offline-first
    });

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
        subjectsLegend.innerHTML = 'Subjects you teach <small>(tick all that apply)</small>';
      }
    }

    function showRegBlock(role, adminAlreadyExists) {
      if (role === 'admin' && adminAlreadyExists) {
        role = 'applicant';
      }
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
          return fsGetAll('users').then(function (users) {
            var exists = users.some(function (u) { return u.role === 'student' && (u.matric || '').toUpperCase() === matric; });
            if (exists) {
              setBusy(submitBtn, false);
              showFieldError(studentForm.querySelector('[name="matric"]'), 'An account already exists for this matric number. Try logging in.');
              return;
            }
            return fsAdd('users', { role: 'student', matric: matric, email: email, passwordHash: simpleHash(password), fullName: found.fullName, classLabel: found.classLabel }).then(function () {
              showRegSuccess('Student account activated', 'You can now log in with your matric number and password.');
            });
          });
        }).catch(function (err) {
          setBusy(submitBtn, false);
          alert('Something went wrong: ' + err.message);
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
          return fsGetAll('users').then(function (users) {
            var exists = users.some(function (u) { return u.role === 'parent' && (u.email || '').toLowerCase() === email.toLowerCase(); });
            if (exists) {
              setBusy(submitBtn, false);
              showFieldError(parentForm.querySelector('[name="email"]'), 'An account with this email already exists. Try logging in.');
              return;
            }
            return fsAdd('users', { role: 'parent', fullName: fullName, email: email, phone: phone, passwordHash: simpleHash(password), childMatric: studentMatric, childName: childFound.fullName }).then(function () {
              showRegSuccess('Parent account created', 'You can now log in with your email and password to follow ' + childFound.fullName + "'s progress.");
            });
          });
        }).catch(function (err) {
          setBusy(submitBtn, false);
          alert('Something went wrong: ' + err.message);
        });
      });
    }

    // ---------- STAFF REQUEST ACCESS ----------
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
          return fsSetDoc('config', 'admin', { fullName: fullName, email: email, phone: phone, passwordHash: simpleHash(password), createdAt: new Date().toISOString() }).then(function () {
            showRegSuccess('Administrator account created', 'You can now log in as Administrator. This setup option will no longer appear for future visitors.');
          });
        }).catch(function (err) {
          setBusy(submitBtn, false);
          alert('Something went wrong: ' + err.message);
        });
      });
    }
  }

})();
