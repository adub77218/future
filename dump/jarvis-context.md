# CONTEXT: JARVIS — the Keeper's company
The Keeper (17, farm kid, founder) is building JARVIS: an AI office manager for family
businesses. Customer #001 = his family's poultry farm (~$6M/yr, ducks/quail/balut,
Asian-market wholesale). Key facts:
- 90% of orders arrive as TEXTS to the owner's personal phone. Single point of failure.
- Orders go onto a weekly ORDER SHEET → Packaging team ("the girls") → trucks.
- Pricing runs on supply/demand + weekly consistency. New customers get researched
  to avoid overlapping existing customers' territory (channel protection).
- The owner said yes to the product. ~20 main customers. Rollout is beginning.
- Product today: voice-first talk-to-file → orders/rolodex/binder/crew rooms,
  morning brief, printable order sheet, outbox drafts (human taps to send).
- Roadmap: text-line pipe (Twilio), email intake, invoicing, promotions room.
- Motto: "Run the business from your phone."

- TECH STACK (important for anyone building Jarvis features): Node.js + Express server (`server.js`), one single-file frontend (`public/index.html`, vanilla JS, no framework), books stored as JSON on the server, AI calls via the Anthropic SDK. New features must be Node/JS that plug into Express routes and that HTML file — not Python.
