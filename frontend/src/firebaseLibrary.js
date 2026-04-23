import { db } from "./firebase.js";
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs 
} from "firebase/firestore";

/**
 * Upserts user data (or specific item like a game) into Firestore.
 * @param {string} userId - The Firebase user UID.
 * @param {object} data - The data object to store.
 */
export async function persistUserDataFS(userId, data) {
  if (!userId) return;
  try {
    const userRef = doc(db, "users", userId);
    await setDoc(userRef, data, { merge: true });
    console.log("Data persisted for user:", userId);
  } catch (error) {
    console.error("Error persisting user data:", error);
    throw error;
  }
}

/**
 * Fetches user data from Firestore.
 * @param {string} userId - The Firebase user UID.
 * @returns {Promise<object|null>} The user data or null if not found.
 */
export async function fetchUserDataFS(userId) {
  if (!userId) return null;
  try {
    const userRef = doc(db, "users", userId);
    const docSnap = await getDoc(userRef);
    if (docSnap.exists()) {
      return docSnap.data();
    } else {
      console.log("No such user document!");
      return null;
    }
  } catch (error) {
    console.error("Error fetching user data:", error);
    throw error;
  }
}

/**
 * Specialized helper to save a library item (like a game) to a subcollection.
 */
export async function persistLibraryItemFS(userId, item) {
  if (!userId || !item.game_id) return;
  try {
    // Storing in a subcollection 'library' under the user document
    const itemRef = doc(db, "users", userId, "library", String(item.game_id));
    await setDoc(itemRef, {
      ...item,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (error) {
    console.error("Error persisting library item:", error);
  }
}

/**
 * Fetches all library items for a user.
 */
export async function fetchLibraryFS(userId) {
  if (!userId) return [];
  try {
    const libRef = collection(db, "users", userId, "library");
    const q = query(libRef);
    const querySnapshot = await getDocs(q);
    const items = [];
    querySnapshot.forEach((doc) => {
      items.push(doc.data());
    });
    return items;
  } catch (error) {
    console.error("Error fetching library:", error);
    return [];
  }
}
/**
 * Saves DNA weights to the user's document in Firestore.
 */
export async function saveDNAWeightsFS(userId, weights) {
  return persistUserDataFS(userId, { dnaWeights: weights });
}
