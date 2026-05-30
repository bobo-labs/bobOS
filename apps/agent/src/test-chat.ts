import "dotenv/config";

async function sendMessage(text: string) {
  const res = await fetch("http://localhost:3001/bobo-the-bear/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      userId: "test-whale-uuid",
      roomId: "room-test-whale-uuid",
      userName: "human"
    })
  });
  const data = await res.json() as any;
  console.log(`\nUser: ${text}`);
  console.log(`Bobo: ${data[0]?.text}`);
  if (data[0]?.proposalChallenge) {
    console.log(`[PROPOSAL CHALLENGE]: ${data[0].proposalChallenge}`);
  }
}

async function main() {
  // Clear any existing state first
  await sendMessage("cancel");

  // Step 1: Initiate proposal
  await sendMessage("lets create a proposal");
  
  // Step 2: Natural language input supplying title, recipient, and amount in one go
  await sendMessage("Propose to send 2500000 tokens to B6c7ZsbA5yR3s65N9i6h8D9eL8G4uK3jH2fP1oQ5rT8y to fund our marketing campaign");

  // Step 3: Test Gauntlet of the Bear with a valid lipogram (no 'e', >= 10 words)
  await sendMessage("I build a major utility for our community with no scams. Upward you go."); 
}

main().catch(console.error);
