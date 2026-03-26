/**
 * Tucci Elite Ops — Restore Function
 * netlify/functions/restore.js
 *
 * GET  /.netlify/functions/restore?key=backup_2026-03-25_14-30-00
 *      → returns the full JSON snapshot for that key
 *
 * The app loads this, validates it, then writes it to localStorage
 * and optionally pushes it back to Sheets.
 */

const { getStore } = require('@netlify/blobs');

function isAllowedOrigin(origin) {
  if (!origin) return false;
  const allowed = [
    'https://polite-kulfi-5cab07.netlify.app',
    'https://tucci-elite-ops.netlify.app',
  ];
  if (/^https:\/\/[a-z0-9-]+--polite-kulfi-5cab07\.netlify\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--tucci-elite-ops\.netlify\.app$/.test(origin)) return true;
  return allowed.includes(origin);
}

exports.handler = async (event) => {
  const origin = (event.headers || {})['origin'] || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (!isAllowedOrigin(origin)) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const key = (event.queryStringParameters || {}).key;
  if (!key || !key.startsWith('backup_')) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing or invalid backup key' }),
    };
  }

  try {
    const store = getStore({ name: 'tucci-backups', consistency: 'strong' });
    const raw = await store.get(key);
    if (!raw) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Backup not found: ' + key }),
      };
    }

    // Validate it's real app state before returning
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== 'object') {
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Corrupt backup' }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
      body: raw, // return raw string — already valid JSON
    };

  } catch (err) {
    console.error('Restore error:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not load backup: ' + err.message }),
    };
  }
};
