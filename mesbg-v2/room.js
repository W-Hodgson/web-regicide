// room.js — Firestore-backed multiplayer rooms (replaces the WebRTC/Trystero approach,
// which couldn't traverse mobile-carrier NATs). A room is a `games/<CODE>` document; the
// host is authoritative and writes the game state, the guest reads it live via onSnapshot
// and submits its moves as docs in a `games/<CODE>/actions` subcollection.
//
// Lifecycle / cleanup:
//   • Host Leave  → deleteRoom() removes the doc + its actions.
//   • Host tab close → best-effort deleteRoom() on pagehide (see runner.js).
//   • Safety net → createRoom() sweeps any rooms older than STALE_MS so abandoned rooms
//     never accumulate.

import { firestore } from './store.js';

const ROOMS = 'games';
const STALE_MS = 12 * 60 * 60 * 1000; // 12h

export async function roomExists(code) {
  const { db, doc, getDoc } = await firestore();
  return (await getDoc(doc(db, ROOMS, code))).exists();
}

export async function createRoom(code, data) {
  const { db, doc, setDoc, serverTimestamp } = await firestore();
  await setDoc(doc(db, ROOMS, code), { ...data, status: 'lobby', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  sweepStaleRooms().catch(() => {});
}

export async function patchRoom(code, fields) {
  const { db, doc, updateDoc, serverTimestamp } = await firestore();
  await updateDoc(doc(db, ROOMS, code), { ...fields, updatedAt: serverTimestamp() });
}

// Subscribe to the room doc. cb receives the data object, or null if the room is gone.
export function watchRoom(code, cb) {
  let unsub = null, cancelled = false;
  firestore().then(({ db, doc, onSnapshot }) => {
    if (cancelled) return;
    unsub = onSnapshot(doc(db, ROOMS, code), (snap) => cb(snap.exists() ? snap.data() : null));
  });
  return () => { cancelled = true; if (unsub) unsub(); };
}

// Guest submits a move (action doc). `seq` (client-incremented) gives a stable order.
export async function sendAction(code, action) {
  const { db, collection, addDoc } = await firestore();
  await addDoc(collection(db, ROOMS, code, 'actions'), action);
}

// Host subscribes to incoming action docs in seq order; cb gets each new one.
export function watchActions(code, cb) {
  let unsub = null, cancelled = false;
  firestore().then(({ db, collection, query, orderBy, onSnapshot }) => {
    if (cancelled) return;
    unsub = onSnapshot(query(collection(db, ROOMS, code, 'actions'), orderBy('seq')), (snap) => {
      snap.docChanges().forEach((ch) => { if (ch.type === 'added') cb({ id: ch.doc.id, ...ch.doc.data() }); });
    });
  });
  return () => { cancelled = true; if (unsub) unsub(); };
}

export async function deleteAction(code, id) {
  const { db, doc, deleteDoc } = await firestore();
  await deleteDoc(doc(db, ROOMS, code, 'actions', id));
}

export async function deleteRoom(code) {
  const { db, doc, deleteDoc, collection, getDocs } = await firestore();
  try {
    const acts = await getDocs(collection(db, ROOMS, code, 'actions'));
    await Promise.all(acts.docs.map((d) => deleteDoc(d.ref)));
  } catch { /* ignore */ }
  await deleteDoc(doc(db, ROOMS, code));
}

async function sweepStaleRooms() {
  const { db, collection, query, where, getDocs, deleteDoc } = await firestore();
  const cutoff = new Date(Date.now() - STALE_MS);
  const snap = await getDocs(query(collection(db, ROOMS), where('updatedAt', '<', cutoff)));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}
