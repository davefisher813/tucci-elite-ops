/**
 * Tucci Elite Ops — Auto Backup Function
 * netlify/functions/backup.js
 *
 * Runs on a schedule (every 6 hours) via netlify.toml cron config.
 * Also callable manually: POST /.netlify/functions/backup
 *
 * What it does:
 *  1. Pulls current state from Google Sheets (source of truth)
 *  2. Saves a timestamped JSON snapshot to Netlify Blobs
 *  3. Keeps last 30 snapshots, deletes older ones
 *  4. Returns a manifest of available backups
 *
 * Storage: Netlify Blobs (free, included with Netlify, no setup needed)
 * Key format: backup_YYYY-MM-DD_HH-MM-SS
 */

const { getStore } = require('@netlify/blobs');

const MAX_BACKUPS   = 30;
const BACKUP_PREFIX = 'backup_';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoKey() {
  return BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // cron calls have no origin
  const allowed = [
    'https://polite-kulfi-5cab07.netlify.app',
    'https://tucci-elite-ops.netlify.app',
  ];
  if (/^https:\/\/[a-z0-9-]+--polite-kulfi-5cab07\.netlify\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--tucci-elite-ops\.netlify\.app$/.test(origin)) return true;
  return allowed.includes(origin);
}

// ── Pull current state from Google Sheets ────────────────────────────────────

async function pullFromSheets(endpoint) {
  if (!endpoint) throw new Error('SHEETS_ENDPOINT not configured');
  const res = await fetch(endpoint + '?action=pull', { cache: 'no-store' });
  if (!res.ok) throw new Error('Sheets pull failed: HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error('Sheets error: ' + data.error);
  return data;
}

// ── Manage backup store ───────────────────────────────────────────────────────

async function getBackupStore() {
  return getStore({
    name: 'tucci-backups',
    consistency: 'strong',
  });
}

async function listBackups(store) {
  const result = await store.list({ prefix: BACKUP_PREFIX });
  return result.blobs
    .map(b => b.key)
    .sort()
    .reverse(); // newest first
}

async function pruneOldBackups(store, keys) {
  if (keys.length <= MAX_BACKUPS) return;
  const toDelete = keys.slice(MAX_BACKUPS);
  await Promise.all(toDelete.map(k => store.delete(k)));
  return toDelete;
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const origin = (event.headers || {})['origin'] || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  isAllowedOrigin(origin) ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Auth check for manual calls (not needed for cron — no origin)
  if (event.httpMethod === 'POST' && origin && !isAllowedOrigin(origin)) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const sheetsEndpoint = process.env.SHEETS_ENDPOINT;

  try {
    const store = await getBackupStore();

    // ── LIST mode: GET /.netlify/functions/backup ──
    if (event.httpMethod === 'GET') {
      const keys = await listBackups(store);
      const manifests = await Promise.all(
        keys.slice(0, 10).map(async key => {
          try {
            const raw = await store.get(key);
            const snap = JSON.parse(raw);
            return {
              key,
              savedAt:   snap._savedAt || null,
              tasks:     (snap.tasks     || []).length,
              bookings:  (snap.bookings  || []).length,
              files:     (snap.files     || []).length,
              sizeKB:    Math.round(raw.length / 1024),
            };
          } catch {
            return { key, error: 'Could not read snapshot' };
          }
        })
      );
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ backups: manifests, total: keys.length }),
      };
    }

    // ── BACKUP mode: POST or cron ──
    let snapshot;

    // Option A: client POSTed the full state directly (faster, no Sheets round-trip)
    if (event.body) {
      try {
        snapshot = JSON.parse(event.body);
        // Validate it looks like real app state
        if (!snapshot.tasks && !snapshot.bookings) throw new Error('Invalid state shape');
      } catch {
        snapshot = null;
      }
    }

    // Option B: pull from Sheets (cron path, or fallback)
    if (!snapshot) {
      if (!sheetsEndpoint) {
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, message: 'SHEETS_ENDPOINT not set — skipping backup' }),
        };
      }
      snapshot = await pullFromSheets(sheetsEndpoint);
    }

    // Save snapshot
    const key = isoKey();
    snapshot._backupKey = key;
    snapshot._backupAt  = Date.now();
    await store.set(key, JSON.stringify(snapshot));

    // Prune old backups
    const allKeys = await listBackups(store);
    const pruned  = await pruneOldBackups(store, allKeys);

    console.log(`Backup saved: ${key} (${allKeys.length} total, ${(pruned||[]).length} pruned)`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok:        true,
        key,
        savedAt:   snapshot._backupAt,
        tasks:     (snapshot.tasks    || []).length,
        bookings:  (snapshot.bookings || []).length,
        total:     allKeys.length,
        pruned:    (pruned || []).length,
      }),
    };

  } catch (err) {
    console.error('Backup error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
