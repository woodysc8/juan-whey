# Juan Gemini Backend

Server-side Express backend for Juan's browser UI. It calls Gemini Interactions and supplies a fresh Google service-account ID token to Juan's remote MCP endpoint. It is research-only and does not book or purchase travel.

## Required configuration

```text
PORT=8080
GEMINI_API_KEY=...
GEMINI_MODEL=...
JUAN_MCP_URL=https://juan-whey.onrender.com/mcp
JUAN_MCP_AUDIENCE=https://juan-whey.onrender.com/mcp
JUAN_MCP_ALLOWED_TOOLS=search_flights,search_hotels
```

`JUAN_MCP_ALLOWED_TOOLS` is mandatory. The server refuses to start with an empty allowlist rather than granting Gemini access to every MCP tool. `JUAN_UI_ALLOWED_ORIGINS` is optional; when omitted, the API emits no permissive CORS headers and is suitable for a same-origin UI.

## Cloud Run identity and secrets

Deploy with the `juan-gemini-caller@juan-whey.iam.gserviceaccount.com` Cloud Run service identity. `GoogleAuth.getIdTokenClient()` obtains a fresh ID token for `JUAN_MCP_AUDIENCE` through Cloud Run Application Default Credentials and the metadata server. No service-account JSON key or `GOOGLE_APPLICATION_CREDENTIALS` value is used or supported.

Inject `GEMINI_API_KEY` from Secret Manager as an environment variable at deployment. The application reads it only from `process.env`, never writes it to disk, returns it, or logs it.

## Local development

Copy `.env.example` to `.env`, provide placeholders sufficient for startup, and run `npm start`. `GET /health` works locally. `POST /api/chat` requires Cloud Run's metadata-server identity and therefore cannot mint the production MCP ID token on a normal local machine. This is intentional.

## Deployment

Build the included Node 22 Docker image and deploy to Cloud Run. Cloud Run supplies `PORT`; the server listens on `process.env.PORT || 8080`. Attach the dedicated service account and inject the Gemini API key from Secret Manager. Do not put keys or tokens in the image, source repository, browser, or Render service.
