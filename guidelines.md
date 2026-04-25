# BoboOS Project Guidelines

This file serves as the definitive reference for the architecture, mechanics, and design philosophy of the "Bobo the Bear" autonomous Web3 agent project. Any AI agent working on this codebase MUST read and strictly adhere to these guidelines to prevent breaking the intricate state machines and custom server architecture we have built.

## 1. Project Architecture (Monorepo)
We are using a `pnpm` workspace monorepo.
- `apps/web`: Next.js 15 frontend using Tailwind CSS.
- `apps/agent`: A custom, ultra-lightweight Express + TypeScript backend server.
- `packages/database`: Drizzle ORM schema + DB client shared across apps.
- **CRITICAL WARNING**: Early in development, we used `ElizaOS` core and direct-clients. They were highly unstable due to dependency version mismatches. **We have completely ripped ElizaOS out.** The agent backend is now a 100% custom Express routing application located in `apps/agent/src/index.ts`. Do **not** attempt to "re-integrate" or import ElizaOS plugins unless explicitly commanded to do so.

## 2. LLM Architecture (Gemini API)
- **Model**: `gemini-3.1-flash-lite-preview` (primary), `gemini-3-flash-preview` (fallback on rate limits).
- **System Prompt Delivery**: We use Gemini's native `system_instruction` field in the REST API body — NOT the fake user→model conversation history hack. This dramatically strengthens character voice adherence.
- **Temperature**: Chat responses use `temperature: 0.9` for creative, human-like replies. Evaluator/JSON calls use `temperature: 0.3` for precise, reliable outputs.
- **Chat History**: An in-memory `Map<userId, ChatMessage[]>` stores the last 10 messages (5 user + 5 model turns) per user. These are sent as multi-turn conversation history in the `contents` array. This enables true conversational awareness — Bobo can react to greetings AND requests in the same message.
  - History clears on: wallet disconnect (via `POST /clear-history`), server restart, or roast completion.
- **Character File**: `apps/agent/src/bobo_context.md` defines Bobo's personality, voice, game mechanics, and includes example dialogues. The `{{MOOD_INSTRUCTIONS}}` placeholder is replaced dynamically based on the user's rank.

## 3. The Rank System & Dynamic Mood
The system calculates the user's exact token balance during wallet verification and saves it to `users.token_balance`. This balance determines Bobo's personality (mood block), the difficulty of earning Point 2, and the tone of the tweet.

### Ranks & Persuasion Difficulty

| Rank | Balance | Mood | Persuasion Difficulty |
|------|---------|------|----------------------|
| **0 (BROKE GHOST)** | 0 | Ruthless disgust, demands they buy tokens | **IMPOSSIBLE** — hard-returns `false`, no LLM call. User must buy tokens. |
| **1 (TINY BAGS)** | 1–99 | Contemptuous pity, mocking | **VERY HARD** — Must write a multi-sentence plea: beg for the post, ask for mercy, AND confess being a terrible trader. One-liners always fail. |
| **2 (MID HOLDER)** | 100–499 | Cheeky hustling, mild respect | **MEDIUM** — Must hit ALL THREE in one message: (1) praise Bobo, (2) admit bad trader, (3) request the post. |
| **3 (SMARTMONEY WHALE)** | 500–999 | Backhanded respect, competitive peer | **EASY but PERSISTENT** — Must ask for a post/tweet TWICE. First qualifying ask is acknowledged but not passed. Second ask passes. Uses `persuasion_attempts` DB counter. |
| **4 (GOD KOL)** | 1000+ | Reverence, loyal servant | **COMMAND** — Must issue a public command ("post about me", "tweet about me"). Passes on first qualifying command. |

### Keyword Pre-Filter (Ranks 3 & 4)
To prevent LLM false positives from burning attempt counts on casual messages like "hi, what's up", Ranks 3 and 4 have a keyword pre-filter. The evaluator only runs if the message contains post/tweet-related keywords: `"post"`, `"tweet"`, `"twitter"`, `"roast"`, `"shoutout"`, `"publicly"`, `"public"`, `"announce"`, `"blast"`, `"timeline"`, `"tag me"`, `"talk about me"`.

### Opening Messages (Frontend — `page.tsx`)
Each rank gets a unique, in-character Bobo greeting when the chat opens. These are hardcoded strings in the frontend, NOT LLM-generated. They are personality-driven greetings that set the tone for the conversation.

## 4. The Core Agent Logic Flow (The $BOBO Migration Narrative)
**FUTURE PROJECT DIRECTIVE (MIGRATION IN ~12 DAYS)**: We are soon swapping `AGENT_TOKEN_MINT` for a token launched on pump.fun. All fees/bribes sent to the `AGENT_WALLET_ADDRESS` will be strictly used to buy $BOBO in SOL. We have introduced a separate `BOBO_TOKEN_MINT` environment variable specifically to track the official $BOBO token on Solana once the migration from ETH is complete. For now, it is a dummy variable, but it will be updated post-migration. AI generated content should heavily favor and protect verifiable $BOBO holders. 

The entire application is a gamified path to getting evaluated (and likely roasted) by Bobo. It operates on a strict sequence of conditions:
1. **Wallet Connection**: Done via Solana Wallet Adapter in the Next.js frontend.
2. **Point 1 (Holder Verification)**: The backend silently pings the Helius RPC. It scans for the `AGENT_TOKEN_MINT` balance, summing up decimals across all token accounts, and saves `token_balance` to the database.
3. **Point 2 (Capitulation or Bribe)**:
   - **Route A (Bribe)**: The user sends tokens or SOL directly to the `AGENT_WALLET_ADDRESS`. The backend scans the blockchain utilizing Helius `transactions` endpoint, looking across both `tokenTransfers` and `nativeTransfers`.
   - **Route B (Capitulation)**: The user chats with Bobo. Every normal chat message triggers `evaluatePersuasion()` after Bobo's reply is generated. The difficulty is rank-dependent (see table above). Ranks 3 & 4 require post/tweet keyword intent before the evaluator even runs.
4. **X (Twitter) Handle Collection**: Once Point 2 is achieved, the roast is NOT immediately fired. The agent drops a celebration image into the chat and asks if the user wants to be tagged on X. The frontend explicitly keeps the chat open to allow the user to reply.
5. **The Tweet Synthesis**: Once the user supplies a handle (or declines), the backend extracts their last 5 Helius blockchain transactions, calculates the fiat/SOL amounts sent (`Dust` if $0), and feeds real on-chain data to Gemini to formulate a personalized 280-character tweet. The tweet tone is rank-dependent:
   - **Rank 4 (GOD KOL)**: Divine proclamation urging others to copy-trade the user. No "bags/wallet" mentions.
   - **Rank 3 (WHALE)**: Respectful validation of smartmoney moves.
   - **Ranks 0–2**: Brutal roast based on on-chain data.
6. **The UI Transition**: The backend returns `readyToDump = true` to the frontend. `actions.ts` parses this, and `page.tsx` starts an explicit 4-second delay so the user can read the final confirmation text before the chat permanently closes, revealing the "DUMP IT" screen.

## 5. Database Schema (`packages/database/schema.ts`)
Key fields on the `users` table:
- `user_id` (UUID, PK)
- `solana_wallet` (varchar)
- `point_one_verified` (boolean) — wallet holds the token
- `point_two_convinced` (boolean) — passed the persuasion check
- `point_two_bribed` (boolean) — sent a bribe transaction
- `roast_published` (boolean) — tweet has been posted
- `token_balance` (double) — exact token holding, drives the rank system
- `persuasion_attempts` (integer) — tracks Rank 3's "ask twice" mechanic
- `roasts_count` (integer) — total roasts published
- `last_roast_published_at` (timestamp) — cooldown timer (6 hours between roasts)

All rank-related counters (`persuasion_attempts`, `point_two_convinced`, etc.) reset on: wallet disconnect, roast completion, or cooldown expiry.

## 6. Frontend UX & Design Code
- **Neo-Brutalist Aesthetic**: The UI relies on hard black borders `border-[4px] border-[#261c1a]`, sharp offsets `shadow-[8px_8px_0_0_#261c1a]`, and aggressive uppercase fonts. DO NOT soften this design with subtle dropshadows, rounded generic buttons, or thin borders.
- **Draggable Window Mechanism**: The main container is a draggable OS window. To avoid massive React re-rendering lag (which destroys chat input performance), the drag handler actively writes directly to the DOM via `el.style.transform`. Do not change this to a state-based layout.
- **Meme Images**: Images are passed natively through the `submitChat` JSON response object. Portrait images are handled utilizing `max-w-full max-h-[320px] object-contain` to preserve aspect ratios without breaking the chat bubble flex bounds.
- **Desktop Font Scaling**: Chat font sizes are bumped at the `lg` breakpoint for desktop legibility (`lg:text-lg` for sender labels, `lg:text-2xl` for message body). Mobile sizes remain untouched from the original design. DO NOT change the font family or mobile sizing.

## 7. API Keys & Dependencies
Check `.env` for secrets. The stack relies on:
- Google Gemini (`gemini-3.1-flash-lite-preview` or higher) for the fast conversational LLM and persuasion evaluation.
- Helius RPC keys for live Solana blockchain validation and API scraping.
- X/Twitter OAuth 1.0a keys for posting the final synthesized roasts.

## 8. Agent Server Endpoints (`apps/agent/src/index.ts`)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Health check |
| `/agents` | GET | List agent descriptor |
| `/ping-wallet` | POST | Silent token verification on wallet connect |
| `/:agentId/message` | POST | Main chat — generates Bobo reply, runs evaluator, handles roast flow |
| `/clear-history` | POST | Clears in-memory chat history for a user (called on wallet disconnect) |

*Before making any architectural changes to `page.tsx` or `index.ts`, heavily respect the delicate timing mechanics of the Point 2 transition—it is the core of the user experience.*
