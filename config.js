// ─── Put Flow Viewer — Configuration ──────────────────────────────────────────
//
// SETUP STEPS:
//
// 1. Share your Google Sheet:
//    File → Share → Change to "Anyone with the link" → Viewer
//
// 2. Get a Google API key:
//    https://console.cloud.google.com/
//    → Create project → Enable "Google Sheets API"
//    → Credentials → Create API Key
//    → Restrict it to "Google Sheets API" only
//    → (Optional) Restrict HTTP referrer to your GitHub Pages URL
//
// 3. Paste your key below and set SHEET_NAME to match your tab name.
//
// ──────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  GOOGLE_SHEETS_ID: '11_KYNpbfuAwsiDehFZwhbQQ9ZPbpj_9i43Bt5CAdnhs',
  GOOGLE_API_KEY:   'YOUR_API_KEY_HERE',
  SHEET_NAME:       'Sheet1',   // Change to match your tab name exactly

  // CORS proxy for Yahoo Finance requests (browser can't call YF directly).
  // Alternatives if this one is slow:
  //   'https://api.allorigins.win/raw?url='
  //   'https://api.codetabs.com/v1/proxy?quest='
  CORS_PROXY: 'https://corsproxy.io/?',
};
