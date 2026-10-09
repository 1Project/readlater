import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) initializeApp();

export const db = getFirestore();
try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  /* already set */
}
export const bucket = () => getStorage().bucket();
export const adminAuth = () => getAuth();
export const REGION = 'us-central1';
