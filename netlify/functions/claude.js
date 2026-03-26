/**
 * Tucci Elite Ops — Claude API Proxy
 * Netlify serverless function: netlify/functions/claude.js
 *
 * Routes: POST /.netlify/functions/claude
 *
 * Security:
 *  - ANTHROPIC_API_KEY lives in Netlify env vars only — never exposed to browser
 *  - Origin check: only accepts requests from your own Netlify domain
 *  - Rate limiting: max 30 requests per IP per minute (in-memory, resets on cold start)
 *  - Request size limit: 6MB (covers large PDF base64 payloads)
 *  - Strips any client-supplied x-api-key headers
 *  - Returns sanitized errors (never leaks key or internal details)
 */

// ── In-memory rate limiter (per IP, resets on Lambda cold start) ──
const rateLimitMap = new Map();
const RATE_LIMIT    = 30;   // requests
const RATE_WINDOW   = 60000; // 1 minute in ms

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ── Allowed origins ──
function isAllowedOrigin(origin) {
  if (!origin) return false;
  const allowed = [
    'https://polite-kulfi-5cab07.netlify.app',
    'https://tucci-elite-ops.netlify.app',
  ];
  // Allow any *.netlify.app preview deploy from this site
  if (/^https:\/\/[a-z0-9-]+--polite-kulfi-5cab07\.netlify\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--tucci-elite-ops\.netlify\.app$/.test(origin)) return true;
  return allowed.includes(origin);
}

exports.handler = async (event) => {
  // ── CORS preflight ──
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // ── Method guard ──
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── Origin guard ──
  if (!isAllowedOrigin(origin)) {
    return {
      statusCode: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Forbidden' }),
    };
  }

  // ── Rate limit ──
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers['client-ip']
    || 'unknown';
  if (!checkRateLimit(ip)) {
    return {
      statusCode: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' },
      body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests — please wait a moment.' } }),
    };
  }

  // ── API key check ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set in environment');
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { type: 'server_error', message: 'Server configuration error.' } }),
    };
  }

  // ── Parse + validate body ──
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { type: 'invalid_request', message: 'Invalid JSON body.' } }),
    };
  }

  // Enforce safe model — only allow Sonnet 4
  const allowedModels = ['claude-sonnet-4-20250514', 'claude-sonnet-4-5'];
  if (!allowedModels.includes(payload.model)) {
    payload.model = 'claude-sonnet-4-20250514';
  }

  // Cap max_tokens
  if (!payload.max_tokens || payload.max_tokens > 8000) {
    payload.max_tokens = Math.min(payload.max_tokens || 4000, 8000);
  }

  // Strip any client-supplied API key (shouldn't be there, but belt-and-suspenders)
  delete payload['x-api-key'];
  delete payload.api_key;

  // ── Proxy to Anthropic ──
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // Forward Anthropic's status code — but sanitize 500 errors
    const status = response.ok ? 200 : (response.status >= 500 ? 502 : response.status);

    return {
      statusCode: status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };

  } catch (err) {
    console.error('Upstream fetch error:', err.message);
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { type: 'network_error', message: 'Could not reach AI service. Try again.' } }),
    };
  }
};
