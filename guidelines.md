# BoboOS Project Guidelines

This file serves as the definitive reference for the architecture, mechanics, and design philosophy of the "Bobo the Bear" autonomous Web3 agent project. Any AI agent working on this codebase MUST read and strictly adhere to these guidelines to prevent breaking the intricate state machines and custom server architecture we have built.

## 1. Project Architecture (Monorepo)
We are using a `pnpm` workspace monorepo.
- `apps/web`: Next.js 15 frontend using Tailwind CSS.
- `apps/agent`: A custom, ultra-lightweight Express + TypeScript backend server.
- **CRITICAL WARNING**: Early in development, we used `ElizaOS` core and direct-clients. They were highly unstable due to dependency version mismatches. **We have completely ripped ElizaOS out.** The agent backend is now a 100% custom Express routing application located in `apps/agent/src/index.ts`. Do **not** attempt to "re-integrate" or import ElizaOS plugins unless explicitly commanded to do so.

## 2. The Core Agent Logic Flow
The entire application is a gamified path to getting "roasted" by Bobo. It operates on a strict sequence of conditions:
1. **Wallet Connection**: Done via Solana Wallet Adapter in the Next.js frontend.
2. **Point 1 (Holder Verification)**: The backend silently pings the Helius RPC. It scans for the `AGENT_TOKEN_MINT` balance. If the token balance is zero, it falls back to checking the native SOL balance (useful for Devnet testing).
3. **Point 2 (Capitulation or Bribe)**:
   - **Route A (Bribe)**: The user sends tokens or SOL directly to the `AGENT_WALLET_ADDRESS`. The backend scans the blockchain utilizing Helius `transactions` endpoint, looking across both `tokenTransfers` and `nativeTransfers`.
   - **Route B (Capitulation)**: The user sends a chat message. The Gemini `evaluatePersuasion` prompt grades the text. If the user expresses extreme financial defeat or self-deprecation, they pass.
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
