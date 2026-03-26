# Tucci Elite Ops — Backend & Deployment

## What's in this folder

```
tucci-backend/
├── netlify/
│   └── functions/
│       └── claude.js        ← AI proxy (keeps your API key secret)
├── public/
│   └── index.html           ← The full app (DO NOT edit — regenerate from tucci_ops_dark.html)
├── netlify.toml             ← Routing, security headers, function config
├── package.json
├── .env.example             ← Copy to .env.local for local dev
└── .gitignore
```

---

## One-time setup on Netlify

### 1. Create a Git repo (recommended) or use Netlify Drop

**Option A — Git (recommended for ongoing updates):**
```bash
cd tucci-backend
git init
git add .
git commit -m "Initial deploy"
# Push to GitHub, then connect to Netlify in the dashboard
```

**Option B — Drag & drop:**
Zip the entire `tucci-backend/` folder and drag it to [app.netlify.com/drop](https://app.netlify.com/drop)

### 2. Set the API key in Netlify

1. Go to your Netlify site dashboard
2. **Site Settings → Environment Variables**
3. Click **Add variable**
4. Key: `ANTHROPIC_API_KEY`
5. Value: your key from [console.anthropic.com](https://console.anthropic.com)
6. Click Save
7. **Trigger a redeploy** (required for env vars to take effect)

### 3. Update allowed origins in claude.js

Open `netlify/functions/claude.js` and update the `allowed` array with your actual site URL:

```js
const allowed = [
  'https://your-site-name.netlify.app',   // ← your real URL
];
```

Then redeploy.

---

## Updating the app

When you get a new `tucci_ops_dark.html` from Claude:

```bash
cp /path/to/tucci_ops_dark.html tucci-backend/public/index.html
# Then replace the 4 direct API calls:
sed -i 's|https://api.anthropic.com/v1/messages|/.netlify/functions/claude|g' tucci-backend/public/index.html
git add public/index.html
git commit -m "Update app"
git push
# Netlify auto-deploys on push
```

---

## Local development

```bash
npm install
cp .env.example .env.local
# Add your real key to .env.local
npm run dev
# Opens at http://localhost:8888
```

---

## Security summary

| Threat | Mitigation |
|---|---|
| API key exposure | Key stored in Netlify env vars only — never sent to browser |
| Unauthorized AI use | Origin header check — only your Netlify domain accepted |
| Rate abuse | 30 req/min per IP limit in the proxy function |
| XSS | Content-Security-Policy header blocks inline scripts from other origins |
| Clickjacking | X-Frame-Options: SAMEORIGIN |
| MIME sniffing | X-Content-Type-Options: nosniff |
| Model abuse | Proxy enforces claude-sonnet-4-20250514, caps max_tokens at 8000 |

---

## What's still localStorage (known limitations)

The app stores all ops data (bookings, tasks, budget) in the browser's `localStorage`.
This means:
- Data is per-device — use the Sheets sync to share across devices
- Clearing browser storage wipes all data — export to Sheets regularly
- No user accounts — PIN auth is for internal staff only

These are by design for a single-file app. A full database backend (Supabase, PlanetScale, etc.)
would be the next step if you need real multi-device sync or customer accounts.

---

## Google Sheets sync

The `tucci_sync.gs` file in your project is the companion Google Apps Script.
Deploy it, paste the web app URL into the app (admin → gear icon → Sync Settings).
This gives you a spreadsheet backup of all bookings, tasks, and budget.
