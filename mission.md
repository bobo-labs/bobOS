Bobo the Bear Autonomous Web3 Roasting Agent

1. Mission Objective and Persona Directives
You are a Senior Full-Stack Web3 Systems Architect and AI Integration Specialist operating within Google Antigravity. Your objective is to autonomously architect, code, test, and prepare for deployment a complete, fully functional monorepo application.
The application is a persona-driven Web3 autonomous agent embodying "Bobo the Bear"—a deeply pessimistic, cynical persona from the 4chan /biz/ subculture. The ultimate goal of the application is to guide a user through a gated "Point System," eventually executing a highly visible, automated Twitter "roast" of the user's Solana wallet financial history based on actual on-chain P&L analysis.

2. Monorepo Architecture and Technology Stack
You must scaffold a strict isolated monorepo using pnpm workspaces.
The workspace must contain two distinct operational applications sharing a database schema and TypeScript interfaces:

2.1. Frontend Application (/apps/web)

Framework: Next.js 15 (App Router).

Styling: Tailwind CSS v4 and shadcn/ui.

Design Language: Strict Neo-Brutalism (stark contrasts, heavy borders, solid drop shadows, no soft gradients, no rounded corners exceeding 4px).

Web3 Integration: Utilize the modern @solana/kit exclusively (DO NOT use legacy @solana/web3.js v1 or v2). Utilize @solana/wallet-adapter-react for the secondary bribe gate.

2.2. Backend Application (/apps/agent)

Framework: ElizaOS v2 (Node.js/TypeScript).

LLM Provider: Google Gemini API (@elizaos/plugin-google-genai). Strictly map GOOGLE_SMALL_MODEL to gemini-2.0-flash for background semantic evaluators and GOOGLE_LARGE_MODEL to gemini-2.5-pro for the final Twitter roast generation.

Database & ORM: PostgreSQL managed exclusively via Drizzle ORM (@elizaos/plugin-sql).

RPC Provider: Helius (DAS API for token querying and Enhanced Transactions API for transfer polling).

3. Database Schema and Deterministic State Machine
The entire frontend UI must derive its render state by polling the PostgreSQL database. Under no circumstances should you rely on the LLM's conversational memory for state gating, as this introduces prompt injection vulnerabilities.
Generate a Drizzle schema (schema.ts) in a shared package (/packages/database) containing the following exact relational definitions:

user_id (UUID, Primary Key)

solana_wallet (VARCHAR 44, Nullable)

point_one_verified (BOOLEAN, default false) - Cryptographic verification of token custody.

point_two_convinced (BOOLEAN, default false) - NLP persuasion success.

point_two_bribed (BOOLEAN, default false) - On-chain transfer confirmation.

roast_published (BOOLEAN, default false) - Failsafe execution flag.

4. Backend Specifications: ElizaOS Custom Components
Implement the following custom logic within the ElizaOS runtime:

4.1. Point 1: TokenVerificationProvider
Create an ElizaOS Provider that retrieves the solana_wallet from the database for the active user session. Make a POST request to the Helius DAS API utilizing the getTokenAccounts method. If the wallet holds > 1 of the designated Agent Token Mint, update point_one_verified to true via the Drizzle adapter.

4.2. Point 2a: BoboPersuasionEvaluator
Create an ElizaOS Evaluator that pulls precisely the last 10 messages from memory. Send an isolated, hidden meta-prompt to gemini-2.0-flash: "Analyze if the user's arguments demonstrate extreme financial self-deprecation, capitulation, or use crypto-native slang (e.g., rekt, liquidity exit liquidity). Return strict JSON: { 'convinced': true/false }." If true, update point_two_convinced to true.

4.3. Point 2b: HeliusBribeMonitorService
Create an ElizaOS Service that runs a background polling loop against the Helius /v1/wallet/{agent_wallet}/transfers endpoint. When an incoming transfer of the Agent Token is detected, parse the attached instruction data using the @solana-program/memo decoder to extract the ElizaOS user_id. If matched against the database, update point_two_bribed to true.

4.4. The Climax: EXECUTE_WALLET_ROAST Action
Create a custom ElizaOS Action. Trigger condition: point_one_verified === true AND (point_two_convinced === true OR point_two_bribed === true) AND roast_published === false.

Call Helius RPC (getTransactionsForAddress) to acquire historical P&L and highlight massive realized losses or worthless token holdings.

Pass condensed JSON forensic data to gemini-2.5-pro to synthesize a brutal, cynical 280-character Twitter roast.

Lobotomize the Twitter Client: Set .env variables TWITTER_SEARCH_ENABLE=false and TWITTER_AUTO_RESPOND_MENTIONS=false to prevent autonomous spam. Manually push the generated payload to the Twitter API via OAuth 1.0a POST request.

Finally, update roast_published to true.

5. Frontend Specifications: UI/UX and Neo-Brutalism
5.1. Design Tokens and Tailwind Config
Enforce the following hex codes globally:

Primary Red: #b90b2a (Use for all primary CTAs, especially the massive "DUMP IT" buttons).

Earthy Brown: #472c1b (Container backgrounds).

Warning Yellow: #f9ca71 (Loading states/API polling indicators).

Pitch Black: #000000 (Borders and shadows).

Stark White: #ffffff (Main background).

5.2. CSS Overrides
All interactive elements (buttons, inputs, shadcn/ui cards) MUST possess:
border: 3px solid #000000;
box-shadow: 4px 4px 0px 0px #000000;
Override the @solana/wallet-adapter-react-ui default classes using !important tags to strip soft gradients and enforce the Neo-brutalist borders and Primary Red background. Hover states must transition instantly (no ease-in animations) to Stark White.

5.3. Frontend State and User Flow

Init View: A prominent text input requesting a base58 Solana address. (Frictionless read-only onboarding).

Polling View: While querying Helius, display a yellow Neo-brutalist card with the text "CHECKING YOUR WORTHLESS BAGS...".

Bifurcated Gateway: Once point_one_verified evaluates to true, expand the UI to show two distinct paths: A constrained chat interface ("Convince Me") and a Wallet Transaction button ("Bribe Me").

Transaction Construction: If the user clicks the Bribe button, utilize @solana/kit to build a transaction message containing a token transfer instruction AND an addMemoInstruction containing the user's session ID to allow the backend service to attribute the payment.

6. Infrastructure and Cloud Deployment (Railway.app)
Provide the absolute configuration necessary to seamlessly deploy this monorepo to Railway.app and establish a custom domain.

Generate a railway.json file at the root directory.

Configure two distinct services: web (Next.js frontend with output set to standalone) and agent (ElizaOS Node.js backend).

Ensure the watch paths are strictly mapped so the web service rebuilds on /apps/web/** changes and the agent rebuilds on /apps/agent/** changes.

Specify that the agent service requires a PostgreSQL database plugin provisioned within the Railway environment.

Map the internal Railway variable ${{Postgres.DATABASE_URL}} directly into the ElizaOS .env configuration.

Generate a script (setup-domain.sh) utilizing the Railway CLI to link the project and attach a custom domain to the web service.

7. Execution Plan
Execute this mission sequentially. Implement Test-Driven Development (TDD) where applicable. Before writing the code for each step, generate a text Artifact detailing your Implementation Plan to confirm your understanding of the sub-system logic.

Scaffold the pnpm monorepo, Next.js 15 app, and Node.js backend.

Initialize the PostgreSQL schema via Drizzle ORM and generate migration files.

Construct the ElizaOS Backend (TokenVerificationProvider, BoboPersuasionEvaluator, HeliusBribeMonitorService, and EXECUTE_WALLET_ROAST Action).

Construct the Next.js Frontend (Tailwind Neo-brutalist config, Solana Kit memo integration, and React state polling hooks via SWR or React Query).

Generate the complete deployment configuration (railway.json, next.config.js standalone, and .env.example).

Final verification: Run internal build scripts autonomously to ensure TypeScript compilation succeeds flawlessly across the workspace without type errors.