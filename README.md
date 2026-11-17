# Study Progress Tracker (fixed)

Static HTML frontend plus a Vercel Node.js serverless function.

## Deploy
1. Import this folder (the folder containing `index.html` and `api/`) into Vercel.
2. Set Framework Preset to **Other**. Leave Build Command and Output Directory empty.
3. Connect an Upstash Redis database to this Vercel project.
4. Add `EDIT_PASSWORD` as an environment variable for Production, Preview, and Development as needed. Enter your own password; do not put it in source code.
5. Confirm the Redis variables exist in the same project:
   - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or
   - `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
6. Redeploy after changing environment variables.

## Diagnostics
- Open `/api/progress` to test GET. A successful response is JSON with `updated` and `c`.
- Owner login now verifies the password with the server before enabling edit mode, and checks Redis with `PING` without changing progress.
- API failures return a JSON `code`, `error`, and (where useful) a `hint`.
- Password is held in page memory only; it is not saved in `sessionStorage` or hard-coded.

The Redis key remains `study-progress`; the existing chapter IDs and stored progress format are preserved.
