/**
 * SIMULATED Google Drive connection (demo only — no real Google, no credentials).
 *
 * This mimics the connect / stay-connected / pick-a-file UX for stakeholder
 * demos without any OAuth, API keys, or backend. The "connected" state is kept
 * in localStorage so the user stays connected across reloads.
 *
 * NOTE: this is intentionally a front-end illusion. No real Google sign-in
 * happens and no password is ever requested or stored. To switch to the real
 * Google Picker later, swap this module back to the OAuth implementation and
 * gate it on VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY.
 */

const STORAGE_KEY = 'tvcad.gdrive'
const DEMO_EMAIL = 'praveer.kumar@ss-prophet.com'

// Always available in demo mode (no credentials required).
export function isDriveConfigured() {
  return true
}

export function getConnection() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return { connected: Boolean(s?.connected), email: s?.email || null }
  } catch {
    return { connected: false, email: null }
  }
}

// Simulate a sign-in (brief delay), then remember the connection.
export async function connectDrive() {
  await new Promise((resolve) => setTimeout(resolve, 800))
  const email = DEMO_EMAIL
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ connected: true, email }))
  return { email }
}

export function disconnectDrive() {
  localStorage.removeItem(STORAGE_KEY)
}

// Simulate uploading an array of File objects to Drive.
export async function uploadFilesToDrive(files) {
  await new Promise((resolve) => setTimeout(resolve, 800 + files.length * 300))
  return { uploaded: files.length }
}
