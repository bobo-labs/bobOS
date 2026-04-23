# BoboOS Project Guidelines

This file serves as the definitive reference for the architecture, mechanics, and design philosophy of the "Bobo the Bear" autonomous Web3 agent project. Any AI agent working on this codebase MUST read and strictly adhere to these guidelines to prevent breaking the intricate state machines and custom server architecture we have built.

## 1. Project Architecture (Monorepo)
We are using a `pnpm` workspace monorepo.
- `apps/web`: Next.js 15 frontend using Tailwind CSS.
- `apps/agent`: A custom, ultra-lightweight Express + TypeScript backend server.
- **CRITICAL WARNING**: Early in development, we used `ElizaOS` core and direct-clients. They were highly unstable due to dependency version mismatches. **We have completely ripped ElizaOS out.** The agent backend is now a 100% custom Express routing application located in `apps/agent/src/index.ts`. Do **not** attempt to "re-integrate" or import ElizaOS plugins unless explicitly commanded to do so.

## 2. The Core Agent Logic Flow (The $BOBO Migration Narrative)
**FUTURE PROJECT DIRECTIVE (MIGRATION IN ~12 DAYS)**: We are soon swapping `AGENT_TOKEN_MINT` for a token launched on pump.fun. All fees/bribes sent to the `AGENT_WALLET_ADDRESS` will be strictly used to buy $BOBO in SOL. We have introduced a separate `BOBO_TOKEN_MINT` environment variable specifically to track the official $BOBO token on Solana once the migration from ETH is complete. For now, it is a dummy variable, but it will be updated post-migration. AI generated content should heavily favor and protect verifiable $BOBO holders. 

*DYNAMIC MOOD SYSTEM (ACTIVE)*: The system now calculates the user's exact token balance during wallet verification and saves it to the database (`users.token_balance`). This balance dictates Bobo's mood across chat and Twitter via a Rank system:
- **Rank 0 (Balance == 0)**: Bobo is ruthless. He treats the user with absolute disgust and aggressively extorts them for tribute or demands they cry and admit they are terrible traders.
- **Rank 1 (Balance 1 - 100)**: Bobo roasts their tiny bags and tells them to pump their bags by tipping his wallet or beg to pass.
- **Rank 2 (Balance 100 - 500)**: Bobo treats them with mild respect, but playfully hustles them to prove they are a "true whale" by tipping.
- **Rank 3 (Balance >= 500)**: Whales. Bobo drops the mob boss persona entirely. He praises their trading genius, reveres them, and they *instantly* auto-pass the Point 2 verification without needing to beg.

The entire application is a gamified path to getting evaluated (and likely roasted) by Bobo. It operates on a strict sequence of conditions:
1. **Wallet Connection**: Done via Solana Wallet Adapter in the Next.js frontend.
2. **Point 1 (Holder Verification)**: The backend silently pings the Helius RPC. It scans for the `AGENT_TOKEN_MINT` balance, summing up decimals across all token accounts, and saves `token_balance` to the database.
3. **Point 2 (Capitulation or Bribe)**:
   - **Route A (Bribe)**: The user sends tokens or SOL directly to the `AGENT_WALLET_ADDRESS`. The backend scans the blockchain utilizing Helius `transactions` endpoint, looking across both `tokenTransfers` and `nativeTransfers`.
   - **Route B (Capitulation)**: The user sends a chat message. The Gemini `evaluatePersuasion` prompt grades the text. **This is hard mode for non-whales:** A simple "I suck" is not enough. The user must write a pitiful, multi-sentence excuse begging for approval. (Whales / Rank 3 auto-pass this instantly).
4. **X (Twitter) Handle Collection**: Once Point 2 is achieved, the roast is NOT immediately fired. The agent drops a celebration image into the chat and asks if the user wants to be tagged on X. The frontend explicitly keeps the chat open to allow the user to reply.
5. **The Roast API**: Once the user supplies a handle (or declines), the backend extracts their last 5 Helius blockchain transactions, calculates the fiat/SOL amounts sent (`Dust` if $0), and feeds real literal on-chain data to Gemini to formulate an organic, deeply personalized, 280-character hit-tweet. 
6. **The UI Transition**: The backend returns `readyToDump = true` to the frontend. `actions.ts` parses this, and `page.tsx` starts an explicit 4-second delay so the user can read the final confirmation text before the chat permanently closes, revealing the "DUMP IT" screen.

## 3. Frontend UX & Design Code
- **Neo-Brutalist Aesthetic**: The UI relies on hard black borders `border-[4px] border-[#261c1a]`, sharp offsets `shadow-[8px_8px_0_0_#261c1a]`, and aggressive uppercase fonts. DO NOT soften this design with subtle dropshadows, rounded generic buttons, or thin borders.
- **Draggable Window Mechanism**: The main container is a draggable OS window. To avoid massive React re-rendering lag (which destroys chat input performance), the drag handler actively writes directly to the DOM via `el.style.transform`. Do not change this to a state-based layout.
- **Meme Images**: Images are passed natively through the `submitChat` JSON response object. Portrait images are handled utilizing `max-w-full max-h-[320px] object-contain` to preserve aspect ratios without breaking the chat bubble flex bounds.

## 4. API Keys & Dependencies
Check `.env` for secrets. The stack replies on:
- Google Gemini (`gemini-3.1-flash-lite-preview` or higher) for the fast conversational LLM and persuasion evaluation.
- Helius RPC keys for live Solana blockchain validation and API scraping.
- X/Twitter OAuth 1.0a keys for posting the final synthesized roasts.

*Before making any architectural changes to `page.tsx` or `index.ts`, heavily respect the delicate timing mechanics of the Point 2 transition—it is the core of the user experience.*
