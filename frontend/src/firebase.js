import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics, isSupported } from "firebase/analytics";

// Replace the following with your app's Firebase project configuration
// You can find this in your Firebase Console: Project Settings > General > Your apps
const firebaseConfig = {
  apiKey: "AIzaSyAsYAXfceZl2g9c4se2z8o9LxPOJOo3RxY",
  authDomain: "game-recommendation-syst-d3934.firebaseapp.com",
  projectId: "game-recommendation-syst-d3934",
  storageBucket: "game-recommendation-syst-d3934.firebasestorage.app",
  messagingSenderId: "308000691973",
  appId: "1:308000691973:web:581f948e6e3fd0864a896c",
  measurementId: "G-NXQZZRKQR0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Services
export const auth = getAuth(app);
export const db = getFirestore(app);

// Optional: Initialize Analytics only if supported (e.g. not blocked by ad-blockers)
export let analytics;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});

export default app;
