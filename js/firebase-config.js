// ── FIREBASE CONFIGURATION ──────────────────────────────────────────────────
// Import Firebase modules via CDN — loaded as ES module in index.html
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDYlIN6BTNxTYQMh8yd7ZXNdzs-ICXwrpk",
  authDomain: "odc-golf.firebaseapp.com",
  databaseURL: "https://odc-golf-default-rtdb.firebaseio.com",
  projectId: "odc-golf",
  storageBucket: "odc-golf.firebasestorage.app",
  messagingSenderId: "141489352951",
  appId: "1:141489352951:web:8454833e8a5a7c64c1a3f2",
  measurementId: "G-Z5RPRB2C5S"
};

export const app = initializeApp(firebaseConfig);
export const db  = getDatabase(app);
