"use server";

import { db, users } from "@bobos/database";
import { eq } from "drizzle-orm";

export async function getUserState(walletAddress: string) {
  if (!walletAddress) return null;
  const [user] = await db.select().from(users).where(eq(users.solana_wallet, walletAddress));
  
  if (!user) {
    // Insert user if they connect for the first time
    const [newUser] = await db.insert(users).values({ 
      solana_wallet: walletAddress,
      point_one_verified: false,
      point_two_convinced: false,
      point_two_bribed: false,
      roast_published: false
    }).returning();
    return newUser;
  }
  // Cooldown logic check
  if (user.roast_published && user.last_roast_published_at) {
    const diffMs = Date.now() - new Date(user.last_roast_published_at).getTime();
    const cooldownMs = 6 * 60 * 60 * 1000;
    if (diffMs >= cooldownMs) {
       // Reset user to play again (they keep point 1 if they still hold tokens, but must earn point 2 again)
       const [updatedUser] = await db.update(users).set({ 
         roast_published: false,
         point_two_bribed: false,
         point_two_convinced: false
       }).where(eq(users.solana_wallet, walletAddress)).returning();
       return updatedUser;
    }
  }

  return user;
}

export async function pingAgentForWallet(walletAddress: string) {
  try {
    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    await fetch(`${agentUrl}/ping-wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });
  } catch (e) {
    console.error("Silent Ping Error:", e);
  }
}


export async function submitChat(walletAddress: string, message: string) {
  if (!walletAddress || !message) return { reply: "Speak up.", convinced: false };

  let replyText = "I'm ignoring you right now.";
  let replyImage: string | undefined = undefined;
  let convincedOrBribed = false;
  let isReadyToDump = false;

  try {
    // 1. Get user to pass their UUID to Eliza
    const [user] = await db.select().from(users).where(eq(users.solana_wallet, walletAddress));
    if (!user) {
      return { reply: "Connect your wallet first.", convinced: false };
    }

    // 2. Use hardcoded stable agent ID (no dynamic lookup needed)
    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    const agentId = "bobo-the-bear";

    // Sanity-check: make sure the server is alive
    try {
      const ping = await fetch(`${agentUrl}/agents`);
      if (!ping.ok) {
        return { reply: "I'm asleep. Run the agent server.", convinced: false };
      }
    } catch (e) {
      return { reply: "I'm asleep. Run the agent server.", convinced: false };
    }

    // 3. Post the user's message to ElizaOS DirectClient
    const messageRes = await fetch(`${agentUrl}/${agentId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
         text: message,
         userId: user.user_id,
         roomId: `room-${user.user_id}`,
         userName: "human"
      })
    });

    if (messageRes.ok) {
      const messagesArray = await messageRes.json();
      // Eliza returns an array of responses. We join them or grab the first text.
      if (Array.isArray(messagesArray) && messagesArray.length > 0) {
         replyText = messagesArray.map((m: any) => m.text).join("\\n");
         replyImage = messagesArray.find((m: any) => !!m.image)?.image;
         isReadyToDump = !!messagesArray.find((m: any) => !!m.readyToDump)?.readyToDump;
      }
    } else {
      replyText = "The agent choked on its response.";
    }

    // 4. Re-query the database to see if the Eliza agent updated points via its Evaluators/Actions
    const [updatedUser] = await db.select().from(users).where(eq(users.solana_wallet, walletAddress));
    
    if (updatedUser) {
       convincedOrBribed = !!(updatedUser.point_two_convinced || updatedUser.point_two_bribed);
    }

  } catch (e) {
    console.error("Chat Server Action Error:", e);
    replyText = "The server is completely busted.";
  }
  
  return { reply: replyText, image: replyImage, convinced: convincedOrBribed, readyToDump: isReadyToDump };
}

export async function wipeUserProgress(walletAddress: string) {
  if (!walletAddress) return;
  await db.update(users).set({
    point_one_verified: false,
    point_two_convinced: false,
    point_two_bribed: false,
    token_balance: 0,
    persuasion_attempts: 0
  }).where(eq(users.solana_wallet, walletAddress));

  // Clear in-memory chat history on the agent server
  try {
    const agentUrl = process.env.AGENT_URL ?? "http://localhost:3001";
    await fetch(`${agentUrl}/clear-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });
  } catch (e) {
    console.error("Failed to clear agent chat history:", e);
  }
}
