# Juan Whey — travel research MCP server

Juan Whey is a local, standards-compliant Model Context Protocol (MCP) server. An MCP-compatible AI host can discover and invoke its existing travel-research tools over standard input/output. Juan is research-only: no tool books, purchases, pays for, reserves, or cancels travel.

## Start locally

```bash
npm install
npm run mcp
```

The server communicates over **stdio**. Configure an MCP host to launch:

```json
{
  "mcpServers": {
    "juan-whey": {
      "command": "node",
      "args": ["/absolute/path/to/juan-whey/src/mcp-server.js"]
    }
  }
}
```

`npm start` remains available for the existing server entry point. This repository currently contains no Express application entry point.

## Local Streamable HTTP adapter

For local transport testing only, run:

```bash
npm run mcp:http
```

It exposes the MCP SDK's Streamable HTTP endpoint at `/mcp`, using the explicit `MCP_HTTP_*` configuration in `.env`. Host and Origin allowlists are mandatory; wildcard values are rejected. `MCP_AUTH_REQUIRED=false` is accepted only when binding to a loopback host.

This is **not public-deployment ready**: when `MCP_AUTH_REQUIRED=true`, requests without credentials receive `401`, while presented bearer tokens receive `503` until a real OAuth/OIDC resource-server validator is configured. The server never accepts an unverified token.

The initial HTTP adapter is intended for one authenticated owner, one running instance, and one durable private `data/` volume. JSON profile/trip storage and in-memory Trip Intent are not multi-user or horizontally scaled storage.

## Credentials

Provider credentials remain exclusively in `.env` (for example `SERPAPI_API_KEY`, `LETSFG_BEARER_TOKEN`, and `STAYINGAPI_KEY`). They are read by the existing providers, are never MCP tool inputs, and are never returned in MCP responses. See the environment example for supported configuration.

## MCP tools

The server exposes research and deterministic decision-support tools, including:

- Flight and hotel research: `search_flights`, `compare_flight_providers`, `search_hotels`, `compare_hotels`
- Traveler state: `get_traveler_profile`, `record_traveler_profile_fact`, `get_trip_intent`, `extract_trip_intent`, `save_trip_intent`
- Cost and decision support: `estimate_trip_cost`, `compare_trip_costs`, `recommend_trip_options`, `research_trip_options`
- Existing supporting research and calculation tools such as airport search, PTO, totals, and profile/trip state management

All tool schemas are discoverable through MCP. Flight, hotel, and destination data retain their provider provenance and uncertainty; estimates are not represented as confirmed prices.

## Verify

```bash
npm test
```

The test command includes stdio and Streamable HTTP MCP smoke tests. They use deterministic tools and safe missing-credential checks without making provider calls.
