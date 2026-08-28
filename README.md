# Juan Whey — travel research toolbelt (MCP server)

No chat interface. No LLM calls. No per-message billing.

Juan Whey is a **Model Context Protocol (MCP) server** — a set of deterministic tools
that plug directly into a Claude agent you already have (Claude Desktop, Claude Code,
Claude in the browser via a connector, etc). The AI reasoning and conversation happen
in your existing agent, for free/whatever you already pay. This server just gives it
real travel data and real arithmetic to work with. The only thing that costs anything
is calls to the Amadeus API, which has a generous free "test" tier.

## What it exposes

**Research (Amadeus, free tier):**
- `search_airports` — resolve a place name to an IATA code
- `search_flights` — priced flight offers for a route/date(s)
- `search_cheapest_dates` — scan a date range for the cheapest days to fly
- `search_hotels` — priced hotel offers for a city/date range
- `search_activities` — bookable tours/activities near a lat/lng
- `get_exchange_rate` — currency conversion (Frankfurter/ECB, free, no key needed)

**Deterministic math (no network calls at all):**
- `calculate_totals` — gross cost / what you front / what others owe / your eventual share
- `calculate_pto` — which candidate dates require a workday off
- `calculate_rewards` — implied cents-per-point value of a redemption

**Persistent state (plain JSON files in `data/`, nothing leaves your machine):**
- `get_traveler_profile` / `update_traveler_profile`
- `get_trip` / `update_trip` / `reset_trip`

## Setup

1. **Get free Amadeus API keys**
   Sign up at [developers.amadeus.com](https://developers.amadeus.com) → *My Self-Service
   Workspace* → *Create New App*. You get a Client ID and Client Secret for the free
   **test environment** — no credit card required. (Test-environment data has narrower
   route/hotel coverage than production and can lag real prices slightly — plenty good
   for research and estimates, always double-check before actually booking.)

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure**
   ```bash
   cp .env.example .env
   # then edit .env and paste in your Amadeus Client ID / Secret
   ```

4. **Sanity check**
   ```bash
   npm test
   ```
   This runs entirely offline — it checks the cost/PTO/rewards math and the JSON
   storage, and confirms the server boots and registers all 14 tools correctly. It
   does **not** call Amadeus (no network access needed to verify the server is sound).

5. **Connect it to your Claude agent**

   **Claude Desktop / Claude Code** — add to your MCP config
   (`claude_desktop_config.json` or `.mcp.json`):
   ```json
   {
     "mcpServers": {
       "juan-whey": {
         "command": "node",
         "args": ["/absolute/path/to/juan-whey/src/server.js"]
       }
     }
   }
   ```
   Restart the client. Juan's tools will show up alongside whatever else you've connected.

   **Claude Code CLI** — equivalently:
   ```bash
   claude mcp add juan-whey -- node /absolute/path/to/juan-whey/src/server.js
   ```

## Using it

Just talk to your Claude agent normally — "I'm thinking about somewhere warm with my
girlfriend in late November" — and it will call `get_traveler_profile`, `search_flights`,
`search_hotels`, `calculate_totals`, etc. as needed, the same way it'd use any other
connected tool. Nothing here decides tone or personality for you; if you want your agent
to talk like "Juan Whey" (address you as Señor, be a little cocky, budget-as-ceiling
philosophy, etc.), put that in your agent's own system prompt / project instructions —
this server only supplies data and math, cheaply.

## Cost

- Amadeus test tier: free, with a fairly generous daily quota per endpoint — plenty
  for personal trip planning. If you ever outgrow it, Amadeus's paid tier is
  pay-per-call and still far cheaper than running an LLM agent loop for the same research.
- Frankfurter (FX): free, unlimited for reasonable personal use.
- This server itself: $0 — it's just Node.js and JSON files on your machine.

## Notes / next steps

- `data/profile.json` and `data/trip.json` are created on first use and never leave
  your machine. Edit them by hand if you want, or just tell your agent what to change.
- This intentionally does not book anything — every tool here is research, search, or
  arithmetic. Booking stays a human (or a future, separately-scoped) action.
- If/when you build a larger multi-agent setup, this server's tool boundary is already
  the seam — another orchestrator can just be another MCP client pointed at the same
  process.
