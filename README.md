# Polaris Revenue Intelligence V3

Clean V3 SaaS architecture for a hotel revenue intelligence platform.

## What this is
This is no longer a one-page audit tool. V3 is designed as a modular SaaS dashboard for hotels and hotel groups.

Modules included in this V3 foundation:

- Overview dashboard
- Website Intelligence
- Booking Journey
- OTA Intelligence
- Competitor Intelligence
- AI Visibility
- Review Intelligence
- Revenue Opportunities
- Historical Trends
- Reports
- Settings

## Structure

```text
frontend/   Static frontend dashboard, uploadable to /monitor-v3/ or similar
api/        Node/Express API, deployable on Render
```

## Deploy API on Render

Root Directory:

```text
api
```

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Environment variables:

```text
ALLOWED_ORIGIN=https://planetpolaris.com
OPENAI_API_KEY=optional
```

## Frontend config

Edit:

```text
frontend/config.js
```

Set:

```js
window.POLARIS_V3_CONFIG = {
  API_BASE_URL: 'https://your-render-api.onrender.com'
};
```

Upload the contents of `frontend/` to your webserver.

## Demo login

There is no authentication yet. This is a functional SaaS foundation and demo dashboard.

## Suggested next build steps

1. Add persistent database: PostgreSQL
2. Add hotel accounts and authentication
3. Store scans over time
4. Add real scheduled monitoring
5. Add real OTA connectors/crawlers
6. Add competitor tracking
7. Add PDF report generation
8. Add Stripe billing
9. Add agency/white-label accounts
