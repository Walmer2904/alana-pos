// ============================================================
// firebase.js — Conexión con Firebase (Auth + Firestore)
// ------------------------------------------------------------
// Toda la app importa Firebase SOLO desde este archivo, así la
// versión del SDK (11.0.2) se cambia en un único lugar: las tres
// URLs de abajo (deben tener siempre la MISMA versión).
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// Configuración del proyecto alana-pos-358b9 (es pública por diseño:
// la seguridad real la dan las reglas de Firestore y Authentication).
const firebaseConfig = {
  apiKey: "AIzaSyDslw7ErRYCJKueRuEJqmBX3IbD39pVdQg",
  authDomain: "alana-pos-358b9.firebaseapp.com",
  projectId: "alana-pos-358b9",
  storageBucket: "alana-pos-358b9.firebasestorage.app",
  messagingSenderId: "1092261618348",
  appId: "1:1092261618348:web:1f62d90bebf2cd0671b509"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Reexportamos las funciones que usan las páginas para no repetir URLs.
export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
  runTransaction
};
