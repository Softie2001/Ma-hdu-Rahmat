// ===========================================================
// FIREBASE INITIALIZATION
// Connects the site to the real, shared MRIP database AND
// real user authentication. Loaded as an ES module.
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
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA4bQlqVH05pBwTl72I-mbOTgtjjKtqUxk",
  authDomain: "mahdu-rahmat.firebaseapp.com",
  projectId: "mahdu-rahmat",
  storageBucket: "mahdu-rahmat.firebasestorage.app",
  messagingSenderId: "361805030903",
  appId: "1:361805030903:web:cef92a03cc59658db2faf2"
};

// --- Primary app: used for the currently signed-in visitor ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- Secondary app: used ONLY when an Administrator approves a staff
// request and needs to create that staff member's account. Using a
// second, separate Firebase app instance means creating that new
// account does NOT sign the Administrator out of their own session
// (Firebase Auth ties "who's signed in" to a specific app instance). ---
const secondaryApp = initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = getAuth(secondaryApp);

window.mripDb = {
  db,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, query, where
};

window.mripAuth = {
  auth,
  secondaryAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  deleteUser
};

window.dispatchEvent(new Event('mripDbReady'));
