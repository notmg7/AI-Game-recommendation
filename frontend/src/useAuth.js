import { useState, useEffect } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword as firebaseCreateUser,
  signInAnonymously,
  GoogleAuthProvider,
  signInWithPopup,
  getAdditionalUserInfo,
  deleteUser,
  sendEmailVerification,
  linkWithCredential,
  EmailAuthProvider
} from "firebase/auth";
import { auth } from "./firebase.js";

/**
 * Custom hook to manage Firebase Authentication state.
 */
export function useFirebaseUser() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Subscribe to auth state changes
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      console.log("Auth State Changed: ", firebaseUser ? `User: ${firebaseUser.uid}` : "Logged Out");
    });

    // Cleanup subscription on unmount
    return () => unsubscribe();
  }, []);

  return { user, loading };
}

/**
 * Helper to log in with email and password.
 */
export async function loginWithEmail(email, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    console.error("Login failed:", error.message);
    throw error;
  }
}

/**
 * Helper to log out.
 */
export async function logoutUser() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed:", error.message);
    throw error;
  }
}

/**
 * Helper for guest/anonymous login.
 */
export async function loginAsGuest() {
  try {
    const userCredential = await signInAnonymously(auth);
    return userCredential.user;
  } catch (error) {
    console.error("Guest login failed:", error.message);
    throw error;
  }
}

/**
 * Helper for Google login.
 */
export async function loginWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);

    // Enforce "Register First" policy
    const { isNewUser } = getAdditionalUserInfo(result);
    if (isNewUser) {
      const email = result.user.email;
      await deleteUser(result.user);
      const error = new Error('ACCOUNT_NOT_FOUND');
      error.email = email;
      throw error;
    }

    return result.user;
  } catch (error) {
    if (error.code === 'auth/account-exists-with-different-credential') {
      return { 
        linkRequired: true, 
        googleCred: GoogleAuthProvider.credentialFromError(error),
        email: error.customData?.email
      };
    }
    console.error("Google login failed:", error.message);
    throw error;
  }
}

/**
 * Helper to link Google credentials to an existing password account.
 */
export async function linkAccounts(email, password, googleCred) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    await linkWithCredential(userCredential.user, googleCred);
    return userCredential.user;
  } catch (error) {
    console.error("Linking failed:", error.message);
    throw error;
  }
}

/**
 * Helper to register a new user.
 */
export async function createUserWithEmailAndPassword(email, password) {
  try {
    const userCredential = await firebaseCreateUser(auth, email, password);
    // Removed sendEmailVerification because OTP handles it
    return userCredential.user;
  } catch (error) {
    console.error("Registration failed:", error.message);
    throw error;
  }
}

export const registerUser = createUserWithEmailAndPassword;

/**
 * Hook to manage OTP verification state and API requests.
 */
export function useOTP() {
  const [isVerified, setIsVerified] = useState(false);
  const [vToken, setVToken] = useState(null);

  const requestOTP = async (email) => {
    const res = await fetch("/api/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to send OTP");
    }
  };

  const confirmOTP = async (email, code) => {
    const res = await fetch("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Invalid OTP");
    }
    setIsVerified(true);
    setVToken(data.verificationToken);
    return data.verificationToken;
  };

  return { isVerified, vToken, requestOTP, confirmOTP, setIsVerified, setVToken };
}
