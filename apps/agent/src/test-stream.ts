import "dotenv/config";
import { Readable } from "stream";

// Save original fetch
const originalFetch = global.fetch;

console.log("=== STARTING TWITTER FILTERED STREAM MOCK TEST ===");

let rulesSetupCalled = false;
let streamConnected = false;
let messageForwarded = false;
let activeStreamInstance: Readable | null = null;

// Mock fetch
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = typeof input === "string" 
    ? input 
    : (input && typeof input === "object" && "url" in input ? (input as any).url : String(input));

  // 1. Bearer Token request
  if (urlStr.includes("/oauth2/token")) {
    console.log("[MOCK FETCH] Received OAuth2 token request.");
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === "content-type" ? "application/json" : null
      },
      json: async () => ({ access_token: "mock-bearer-token" }),
      text: async () => JSON.stringify({ access_token: "mock-bearer-token" })
    } as any;
  }

  // 2. User Lookup request
  if (urlStr.includes("/2/users/") && !urlStr.includes("/rules")) {
    console.log("[MOCK FETCH] Received User Lookup request.");
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === "content-type" ? "application/json" : null
      },
      json: async () => ({ data: { username: "mocked_bobo_user" } }),
      text: async () => JSON.stringify({ data: { username: "mocked_bobo_user" } })
    } as any;
  }

  // 3. Stream Rules GET request
  if (urlStr.includes("/2/tweets/search/stream/rules") && (!init?.method || init.method.toUpperCase() === "GET")) {
    console.log("[MOCK FETCH] Received GET stream rules request.");
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === "content-type" ? "application/json" : null
      },
      json: async () => ({ data: [] }),
      text: async () => JSON.stringify({ data: [] })
    } as any;
  }

  // 4. Stream Rules POST request
  if (urlStr.includes("/2/tweets/search/stream/rules") && init?.method?.toUpperCase() === "POST") {
    console.log("[MOCK FETCH] Received POST stream rules request:", init.body);
    rulesSetupCalled = true;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === "content-type" ? "application/json" : null
      },
      json: async () => ({ meta: { sent: new Date().toISOString() } }),
      text: async () => JSON.stringify({ meta: { sent: new Date().toISOString() } })
    } as any;
  }

  // 5. Stream Connection request
  if (urlStr.includes("/2/tweets/search/stream")) {
    console.log("[MOCK FETCH] Received stream connection request.");
    streamConnected = true;
    
    activeStreamInstance = new Readable({
      read() {}
    });

    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === "content-type" ? "application/json" : null
      },
      body: activeStreamInstance,
      text: async () => ""
    } as any;
  }

  // 6. Coin Communities postMessage request
  if (urlStr.includes("api.coin-communities.xyz")) {
    console.log("[MOCK FETCH] Received Coin Communities API request:", urlStr);
    messageForwarded = true;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === "content-type" ? "application/json" : null
      },
      json: async () => ({ success: true, data: { messageId: "cc-msg-999" } }),
      text: async () => JSON.stringify({ success: true, data: { messageId: "cc-msg-999" } })
    } as any;
  }

  console.log("[MOCK FETCH] Unhandled request:", urlStr);
  return new Response("Not Found", { status: 404 });
};

// Set dummy env variables if not set
process.env.TWITTER_API_KEY = process.env.TWITTER_API_KEY || "mock-key";
process.env.TWITTER_API_SECRET_KEY = process.env.TWITTER_API_SECRET_KEY || "mock-secret";
process.env.TWITTER_USER_ID = process.env.TWITTER_USER_ID || "1747088288903581696";
process.env.USER_ACCESS_TOKEN = process.env.USER_ACCESS_TOKEN || "mock-user-token";

// Now import index.js, which will trigger the server start and start the stream connection automatically!
await import("./index.js");

async function runTest() {
  try {
    // Wait for the stream to be connected by the server
    console.log("[TEST] Waiting for stream connection to establish...");
    for (let i = 0; i < 20; i++) {
      if (activeStreamInstance) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (!activeStreamInstance) {
      throw new Error("Stream connection failed to establish in 2 seconds.");
    }

    console.log("[TEST] Stream established. Simulating events...");
    
    // Simulate keep-alive heartbeat
    console.log("[TEST] Pushing keep-alive signal...");
    activeStreamInstance.push("\r\n");
    await new Promise(r => setTimeout(r, 200));

    // Simulate tweet payload
    console.log("[TEST] Pushing tweet payload...");
    const tweetPayload = {
      data: {
        id: "123456789012345",
        text: "Hello World! This is a test tweet from my automated bot. #bobo",
        referenced_tweets: []
      }
    };
    activeStreamInstance.push(JSON.stringify(tweetPayload) + "\n");
    
    // Wait for message forwarding to complete
    await new Promise(r => setTimeout(r, 500));

    // Close the stream
    console.log("[TEST] Pushing EOF to stream.");
    activeStreamInstance.push(null);

    // Check assertions
    console.log("\n=== VERIFYING RESULTS ===");
    console.log("Rules setup called:", rulesSetupCalled ? "PASSED" : "FAILED");
    console.log("Stream connected:", streamConnected ? "PASSED" : "FAILED");
    console.log("Message forwarded:", messageForwarded ? "PASSED" : "FAILED");

    if (rulesSetupCalled && streamConnected && messageForwarded) {
      console.log("\nTEST RESULT: ALL TESTS PASSED! 🎉");
      process.exit(0);
    } else {
      console.error("\nTEST RESULT: SOME TESTS FAILED! ❌");
      process.exit(1);
    }
  } catch (err: any) {
    console.error("Test failed with exception:", err);
    process.exit(1);
  } finally {
    // Restore fetch
    global.fetch = originalFetch;
  }
}

runTest();
