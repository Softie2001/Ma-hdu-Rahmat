// ===========================================================
// FIREBASE INITIALIZATION
// This connects the site to the real, shared MRIP database.
// Loaded as an ES module — see the <script type="module"> tags
// in each HTML page.
// ===========================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA4bQlqVH05pBwTl72I-mbOTgtjjKtqUxk",
  authDomain: "mahdu-rahmat.firebaseapp.com",
  projectId: "mahdu-rahmat",
  storageBucket: "mahdu-rahmat.firebasestorage.app",
  messagingSenderId: "361805030903",
  appId: "1:361805030903:web:cef92a03cc59658db2faf2"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Expose a small helper surface on window so portal.js (a plain,
// non-module script) can use Firestore without every page needing
// to become a module itself.
window.mripDb = {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  query,
  where
};

// Let portal.js know Firebase is ready, since module scripts load
// asynchronously relative to regular scripts.
window.dispatchEvent(new Event('mripDbReady'));
