// store.js — roster persistence.
//
// Rosters are GLOBAL and unauthenticated: everyone can see and load every list (by design).
// Creating/overwriting is gated client-side by the "cake" password in the UI — this is a
// soft deterrent, not real security. At the database level writes are open.
//
// Two backends, same async API:
//   • Firestore  — used when FIREBASE_CONFIG below is filled in with real credentials.
//   • localStorage — automatic fallback so the app is fully usable before Firebase is set up.
//
// ─────────────────────────────────────────────────────────────────────────────
//  TO ENABLE SHARED CLOUD STORAGE (Will):
//   1. Create a free Firebase project → https://console.firebase.google.com
//   2. Build → Firestore Database → Create database → Start in *test mode*.
//   3. Project settings → "Your apps" → Web app → copy the firebaseConfig values
//      into FIREBASE_CONFIG below.
//   4. (Later, for a little safety) tighten Firestore rules, e.g. allow read: if true;
//      writes from your domain only. The "cake" gate stays in the UI regardless.
//  Until step 3 is done, rosters are saved to this browser's localStorage only.
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC2cnbXZLVPeenP9VK7xx_3ye58mNeghLU',
  authDomain: 'mesbg-de8ce.firebaseapp.com',
  projectId: 'mesbg-de8ce',
  storageBucket: 'mesbg-de8ce.firebasestorage.app',
  messagingSenderId: '710856051629',
  appId: '1:710856051629:web:3f976e10b87dee8ba1ef24',
};

// Pinned Firebase SDK version (learn from the Trystero bug — never float a CDN dependency).
const FIREBASE_VERSION = '10.12.5';
const COLLECTION = 'rosters';
const LOCAL_KEY = 'mesbg2-rosters';

function configLooksReal(c) {
  return c && typeof c.apiKey === 'string' && !c.apiKey.startsWith('TODO') && !c.projectId.startsWith('TODO');
}

export const usingFirestore = configLooksReal(FIREBASE_CONFIG);

// ── Firestore backend (lazy-loaded) ──────────────────────────────────────────

let _fs = null;
// Lazy Firestore handle, shared by the roster store and the multiplayer room layer (room.js).
// Returns { db, ...firestoreSdk } so callers can destructure the functions they need.
export async function firestore() {
  if (_fs) return _fs;
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fb = await import(`${base}/firebase-firestore.js`);
  const app = initializeApp(FIREBASE_CONFIG);
  const db = fb.getFirestore(app);
  _fs = { db, ...fb };
  return _fs;
}

const firestoreBackend = {
  async list() {
    const { db, collection, getDocs, query, orderBy } = await firestore();
    const snap = await getDocs(query(collection(db, COLLECTION), orderBy('updatedAt', 'desc')));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async get(id) {
    const { db, doc, getDoc } = await firestore();
    const snap = await getDoc(doc(db, COLLECTION, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },
  async save(roster) {
    const { db, collection, addDoc, doc, setDoc, serverTimestamp } = await firestore();
    const now = serverTimestamp();
    if (roster.id) {
      const { id, ...rest } = roster;
      await setDoc(doc(db, COLLECTION, id), { ...rest, updatedAt: now }, { merge: true });
      return id;
    }
    const ref = await addDoc(collection(db, COLLECTION), { ...roster, createdAt: now, updatedAt: now });
    return ref.id;
  },
  async remove(id) {
    const { db, doc, deleteDoc } = await firestore();
    await deleteDoc(doc(db, COLLECTION, id));
  },
};

// ── localStorage backend ─────────────────────────────────────────────────────

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  } catch {
    return [];
  }
}
function writeLocal(rosters) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(rosters));
}

const localBackend = {
  async list() {
    return readLocal().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async get(id) {
    return readLocal().find((r) => r.id === id) || null;
  },
  async save(roster) {
    const all = readLocal();
    const now = Date.now();
    if (roster.id) {
      const i = all.findIndex((r) => r.id === roster.id);
      if (i >= 0) all[i] = { ...roster, updatedAt: now };
      else all.push({ ...roster, updatedAt: now, createdAt: now });
      writeLocal(all);
      return roster.id;
    }
    const id = `local_${now.toString(36)}_${Math.floor(now % 100000)}`;
    all.push({ ...roster, id, createdAt: now, updatedAt: now });
    writeLocal(all);
    return id;
  },
  async remove(id) {
    writeLocal(readLocal().filter((r) => r.id !== id));
  },
};

const backend = usingFirestore ? firestoreBackend : localBackend;

export const listRosters = (...a) => backend.list(...a);
export const getRoster = (...a) => backend.get(...a);
export const saveRoster = (...a) => backend.save(...a);
export const deleteRoster = (...a) => backend.remove(...a);

export function backendLabel() {
  return usingFirestore ? 'Cloud (shared)' : 'This device only — Firebase not configured yet';
}
