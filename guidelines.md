# BoboOS Project Guidelines

This file serves as the definitive reference for the architecture, mechanics, and design philosophy of the "Bobo the Bear" autonomous Web3 agent project. Any AI agent working on this codebase MUST read and strictly adhere to these guidelines to prevent breaking the intricate state machines and custom server architecture we have built.

## 1. Project Architecture (Monorepo)
We are using a `pnpm` workspace monorepo.
- `apps/web`: Next.js 15 frontend using Tailwind CSS.
- `apps/agent`: A custom, ultra-lightweight Express + TypeScript backend server.
- `packages/database`: Drizzle ORM schema + DB client shared across apps.
- **CRITICAL WARNING**: Early in development, we used `ElizaOS` core and direct-clients. They were highly unstable due to dependency version mismatches. **We have completely ripped ElizaOS out.** The agent backend is now a 100% custom Express routing application located in `apps/agent/src/index.ts`. Do **not** attempt to "re-integrate" or import ElizaOS plugins unless explicitly commanded to do so.

## 2. LLM Architecture (Gemini API)

### Model Routing by Purpose
Different tasks use different primary models, selected automatically via a `purpose` parameter:

| Purpose | Primary Model | Fallback 1 | Fallback 2 | Why |
|---------|---------------|------------|------------|-----|
| **Chat** (personality) | `gemini-3-flash-preview` | `gemini-3.1-flash-lite-preview` | `gemini-2.5-flash-preview` | Better character adherence |
| **Evaluator** (JSON) | `gemini-3.1-flash-lite-preview` | `gemini-3-flash-preview` | `gemini-2.5-flash-preview` | Fastest for structured true/false |
| **Tweet** (synthesis) | `gemini-3-flash-preview` | `gemini-3.1-flash-lite-preview` | `gemini-2.5-flash-preview` | Creative, punchy 280-char content |

Fallback is automatic — if the primary model returns a 429 or 503, the next model in the chain is tried with exponential backoff.

### System Prompt Delivery
We use Gemini's native `system_instruction` field in the REST API body — NOT the fake user→model conversation history hack. This dramatically strengthens character voice adherence.

### Generation Config
- **Chat responses**: `temperature: 0.9` for creative, human-like replies.
- **Evaluator/JSON calls**: `temperature: 0.3` + `maxOutputTokens: 50` for precise, fast, reliable outputs.
- **Tweet calls**: `temperature: 0.3` (no system prompt, uses prompt-based instruction).

### Resiliency
- **AbortController timeout**: All Gemini fetch calls have a 20-second hard timeout via `AbortController`. If the model doesn't respond, the request is aborted and the next model in the chain is tried.
- **Retry with backoff**: On rate limits (429) or overload (503), retries use exponential backoff (`1000ms * attempt`).

### Chat History
An in-memory `Map<userId, ChatMessage[]>` stores the last 10 messages (5 user + 5 model turns) per user. These are sent as multi-turn conversation history in the `contents` array. This enables true conversational awareness.
- History clears on: wallet disconnect (via `POST /clear-history`), server restart, or roast completion.
- **System signals** (`[SYSTEM: TX_FAILED]`, `[SYSTEM: BRIBE_CONFIRMED]`, etc.) and their responses are **never stored** in chat history to avoid confusing the LLM's context window.

### Character File
`apps/agent/src/bobo_context.md` defines Bobo's personality, voice, game mechanics, and includes example dialogues. The `{{MOOD_INSTRUCTIONS}}` placeholder is replaced dynamically based on the user's rank.

## 3. The Rank System & Dynamic Mood
The system calculates the user's exact token balance during wallet verification and saves it to `users.token_balance`. This balance determines Bobo's personality (mood block), the difficulty of earning Point 2, and the tone of the tweet.

### Ranks & Persuasion Difficulty

| Rank | Balance | Mood | Persuasion Difficulty |
|------|---------|------|----------------------|
| **0 (BROKE GHOST)** | 0 | Ruthless disgust, demands they buy tokens | **IMPOSSIBLE** — hard-returns `false`, no LLM call. User must buy tokens. |
| **1 (TINY BAGS)** | 1–99 | Contemptuous pity, mocking | **N/A** — Persuasion evaluator does NOT run for Rank 1. User must bribe to earn Point 2. |
| **2 (MID HOLDER)** | 100–499 | Cheeky hustling, mild respect | **N/A** — Persuasion evaluator does NOT run for Rank 2. User must bribe to earn Point 2. |
| **3 (SMARTMONEY WHALE)** | 500–999 | Backhanded respect, competitive peer | **EASY but PERSISTENT** — Must ask for a post/tweet TWICE. First qualifying ask is acknowledged but not passed. Second ask passes. Uses `persuasion_attempts` DB counter. This is the ONLY rank that uses the persuasion path. Runs in parallel with the chat reply via `Promise.all`. |
| **4 (GOD KOL)** | 1000+ | Reverence, loyal servant | **N/A** — Persuasion evaluator does NOT run for Rank 4. User must issue a public command which is handled by the chat system prompt's reverent tone. |

### Keyword Pre-Filter (Rank 3)
To prevent LLM false positives from burning attempt counts on casual messages like "hi, what's up", Rank 3 has a keyword pre-filter. The evaluator only runs if the message contains post/tweet-related keywords: `"post"`, `"tweet"`, `"twitter"`, `"roast"`, `"shoutout"`, `"publicly"`, `"public"`, `"announce"`, `"blast"`, `"timeline"`, `"tag me"`, `"talk about me"`.

### Wallet Address Policy
**Bobo NEVER shares a raw wallet address in chat.** The bribe/tip transaction is fully automated through the Phantom popup. The mood blocks instruct Bobo to tell users to say "tip you" or "bribe you" to trigger the flow.

### Opening Messages (Frontend — `page.tsx`)
Each rank gets a unique, in-character Bobo greeting when the chat opens. These are hardcoded strings in the frontend, NOT LLM-generated. They are personality-driven greetings that set the tone for the conversation.

## 4. The Core Agent Logic Flow (The $BOBO Migration Narrative)
**FUTURE PROJECT DIRECTIVE (MIGRATION)**: We are soon swapping `AGENT_TOKEN_MINT` for a token launched on pump.fun. All fees/bribes sent to the `AGENT_WALLET_ADDRESS` will be strictly used to buy $BOBO in SOL. We have introduced a separate `BOBO_TOKEN_MINT` environment variable specifically to track the official $BOBO token on Solana once the migration from ETH is complete.

The entire application is a gamified path to getting evaluated (and likely roasted) by Bobo. It operates on a strict sequence of conditions:
1. **Wallet Connection**: Done via Solana Wallet Adapter in the Next.js frontend.
2. **Point 1 (Holder Verification)**: The backend silently pings the Helius RPC. It scans for the `AGENT_TOKEN_MINT` balance, summing up decimals across all token accounts, and saves `token_balance` to the database.
3. **Point 2 (Bribe or Convince)**:
   - **Route A (Bribe — All Ranks)**: The user tells Bobo they want to "tip" or "bribe" → Bobo asks for an amount → the frontend constructs and sends a `createTransferCheckedInstruction` transaction via Phantom → on successful `connection.confirmTransaction`, the frontend sends `[SYSTEM: BRIBE_CONFIRMED]` to the agent → agent marks `point_two_bribed = true`.
   - **Route B (Persuasion — Rank 3 ONLY)**: The user chats with Bobo. The persuasion evaluator runs **in parallel** with the chat reply via `Promise.all`, ONLY for Rank 3 users who haven't yet earned Point 2. Requires asking for a tweet/post TWICE (tracked via `persuasion_attempts`).
   - **Transaction Failure Handling**: On failed/cancelled transactions, the frontend sends `[SYSTEM: TX_FAILED]` → Bobo offers a retry → if user declines, a chicken-out memory is injected into chat history for future mockery.
   - **Insufficient Funds**: Pre-flight balance check catches this before Phantom popup. Frontend sends `[SYSTEM: INSUFFICIENT_FUNDS]` → states are cleared silently.
4. **X (Twitter) Handle Collection**: Once Point 2 is achieved, the roast is NOT immediately fired. The agent drops a celebration image into the chat and asks if the user wants to be tagged on X. The frontend explicitly keeps the chat open to allow the user to reply.
5. **The Tweet Synthesis**: Once the user supplies a handle (or declines), the backend extracts their last 5 Helius blockchain transactions, calculates the fiat/SOL amounts sent (`Dust` if $0), and feeds real on-chain data to Gemini (using the `"tweet"` purpose model routing) to formulate a personalized 280-character tweet. The tweet tone is rank-dependent:
   - **Rank 4 (GOD KOL)**: Divine proclamation urging others to copy-trade the user. No "bags/wallet" mentions.
   - **Rank 3 (WHALE)**: Respectful validation of smartmoney moves.
   - **Ranks 0–2**: Brutal roast based on on-chain data.
6. **The UI Transition**: The backend returns `readyToDump = true` to the frontend. `actions.ts` parses this, and `page.tsx` starts an explicit 4-second delay so the user can read the final confirmation text before the chat permanently closes, revealing the "DUMP IT" screen.

## 5. Database Schema (`packages/database/schema.ts`)
Key fields on the `users` table:
- `user_id` (UUID, PK)
- `solana_wallet` (varchar)
- `point_one_verified` (boolean) — wallet holds the token
- `point_two_convinced` (boolean) — passed the persuasion check (Rank 3 only)
- `point_two_bribed` (boolean) — sent a bribe transaction
- `roast_published` (boolean) — tweet has been posted
- `token_balance` (double) — exact token holding, drives the rank system
- `persuasion_attempts` (integer) — tracks Rank 3's "ask twice" mechanic
- `roasts_count` (integer) — total roasts published
- `last_roast_published_at` (timestamp) — cooldown timer (6 hours between roasts)
- `agent_memory` (text, nullable) — Bobo's synthesized thoughts about the user, persisted across sessions

All rank-related counters (`persuasion_attempts`, `point_two_convinced`, etc.) reset on: wallet disconnect, roast completion, or cooldown expiry. `agent_memory` does NOT reset — it compounds across sessions.

### Persistent Agent Memory
After each successful roast publication, the agent generates a brief "thought" about the user by synthesizing the last 10 chat messages + any existing memory via Gemini (using the `"tweet"` model routing for creative output). This thought is stored in `agent_memory` and injected into the system prompt on subsequent interactions.

**How it works:**
1. User gets a roast published → `executeWalletRoast` fires → after `roasts_count` increments → `generateMemory(userId)` is called.
2. First session: Memory is created from scratch ("This anon tipped 3 tokens and folded in 4 messages...").
3. Return session: Existing memory is loaded from DB and injected into the system prompt via `getBoboSystemPrompt(balance, memory)`.
4. Next roast: New memory is generated by combining the old memory + the new chat, building a compounding understanding.
5. Memory failures are non-fatal — wrapped in `.catch()` so a Gemini error never blocks the roast flow.

## 6. Frontend UX & Design Code
- **Neo-Brutalist Aesthetic**: The UI relies on hard black borders `border-[4px] border-[#261c1a]`, sharp offsets `shadow-[8px_8px_0_0_#261c1a]`, and aggressive uppercase fonts. DO NOT soften this design with subtle dropshadows, rounded generic buttons, or thin borders.
- **Draggable Window Mechanism**: The main container is a draggable OS window. To avoid massive React re-rendering lag (which destroys chat input performance), the drag handler actively writes directly to the DOM via `el.style.transform`. Do not change this to a state-based layout.
- **Meme Images**: Images are passed natively through the `submitChat` JSON response object. Portrait images are handled utilizing `max-w-full max-h-[320px] object-contain` to preserve aspect ratios without breaking the chat bubble flex bounds.
- **Desktop Font Scaling**: Chat font sizes are bumped at the `lg` breakpoint for desktop legibility (`lg:text-lg` for sender labels, `lg:text-2xl` for message body). Mobile sizes remain untouched from the original design. DO NOT change the font family or mobile sizing.

## 7. API Keys & Dependencies
Check `.env` for secrets. The stack relies on:
- Google Gemini (3-model fallback chain) for the fast conversational LLM, persuasion evaluation, and tweet synthesis.
- Helius RPC keys for live Solana blockchain validation and API scraping.
- X/Twitter OAuth 1.0a keys for posting the final synthesized roasts.

## 8. Agent Server Endpoints (`apps/agent/src/index.ts`)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Health check |
| `/agents` | GET | List agent descriptor |
| `/ping-wallet` | POST | Silent token verification on wallet connect |
| `/:agentId/message` | POST | Main chat — generates Bobo reply, runs evaluator (Rank 3 only), handles roast flow |
| `/clear-history` | POST | Clears in-memory chat history for a user (called on wallet disconnect) |
| `/leaderboard` | GET | Top-3 leaderboard by roasts_count |

## 9. BoboLabs Context
BoboLabs is the parent organization — the team (Barkz, Sebs, ckjesus) that built bobo_os. bobo_os is "one weapon in the Arsenal" — the first deployment from the lab. BoboLabs has its own visual identity (dark terminal, Space Mono, sinister red) which is **completely separate** from bobo_os's warm neo-brutalist aesthetic. They are architecturally and visually decoupled.

*Before making any architectural changes to `page.tsx` or `index.ts`, heavily respect the delicate timing mechanics of the Point 2 transition—it is the core of the user experience.*
