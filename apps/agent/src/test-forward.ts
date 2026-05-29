import "dotenv/config";

async function runTest() {
  const port = process.env.SERVER_PORT || "3001";
  const secret = process.env.TWEET_FORWARDER_SECRET || "test-secret";

  console.log("--- TEST 1: Sending request with invalid secret ---");
  try {
    const res = await fetch(`http://localhost:${port}/api/forward-tweet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": "wrong-secret",
      },
      body: JSON.stringify({
        twitterId: "123456",
        tweetText: "Test",
        tweetId: "999",
      }),
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Response:", data);
  } catch (err: any) {
    console.error("Fetch failed:", err.message);
  }

  console.log("\n--- TEST 2: Sending request with valid secret but missing params ---");
  try {
    const res = await fetch(`http://localhost:${port}/api/forward-tweet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify({
        twitterId: "123456",
      }),
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Response:", data);
  } catch (err: any) {
    console.error("Fetch failed:", err.message);
  }
}

runTest();
