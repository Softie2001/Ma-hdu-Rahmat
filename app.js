(function () {
  'use strict';

  var html = document.documentElement;
  var langSwitch = document.getElementById('langSwitch');
  var navToggle = document.getElementById('navToggle');
  var mainNav = document.getElementById('mainNav');

  /* -------------------- Language / Direction Switching -------------------- */
  function applyLang(lang) {
    html.setAttribute('lang', lang);
    html.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    html.setAttribute('data-lang', lang);

    document.querySelectorAll('[data-en]').forEach(function (el) {
      var text = lang === 'ar' ? el.getAttribute('data-ar') : el.getAttribute('data-en');
      if (text && text.length > 0) {
        el.textContent = text;
      }
    });

    try { localStorage.setItem('mrip-lang', lang); } catch (e) { /* storage unavailable */ }
  }

  function currentLang() {
    return html.getAttribute('data-lang') === 'ar' ? 'ar' : 'en';
  }

  if (langSwitch) {
    langSwitch.addEventListener('click', function () {
      var next = currentLang() === 'en' ? 'ar' : 'en';
      applyLang(next);
    });
  }

  // Restore saved language preference
  (function initLang() {
    var saved = null;
    try { saved = localStorage.getItem('mrip-lang'); } catch (e) { /* ignore */ }
    if (saved === 'ar' || saved === 'en') {
      applyLang(saved);
    }
  })();

  /* -------------------- Mobile Nav Toggle -------------------- */
  if (navToggle && mainNav) {
    navToggle.addEventListener('click', function () {
      var isOpen = mainNav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    mainNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        mainNav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* -------------------- Scroll Reveal -------------------- */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    revealEls.forEach(function (el, i) {
      el.style.transitionDelay = (i * 70) + 'ms';
      observer.observe(el);
    });
  } else {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* -------------------- Header shadow on scroll -------------------- */
  var header = document.getElementById('siteHeader');
  if (header) {
    var lastState = false;
    window.addEventListener('scroll', function () {
      var scrolled = window.scrollY > 12;
      if (scrolled !== lastState) {
        header.style.boxShadow = scrolled ? '0 4px 24px rgba(11,42,92,0.08)' : 'none';
        lastState = scrolled;
      }
    }, { passive: true });
  }

  /* -------------------- Graceful image fallback --------------------
     If an image file is missing (e.g. the images/ folder wasn't
     uploaded alongside the HTML), replace the broken-image icon with
     a clean placeholder instead of a jarring broken graphic. */
  document.querySelectorAll('img').forEach(function (img) {
    img.addEventListener('error', function () {
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = 'true';
      var box = document.createElement('div');
      box.className = 'img-fallback';
      box.style.width = '100%';
      box.style.height = '100%';
      box.setAttribute('aria-hidden', 'true');
      if (img.parentElement) {
        img.parentElement.style.position = img.parentElement.style.position || 'relative';
        img.replaceWith(box);
      }
    });
  });
})();
