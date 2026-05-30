import "dotenv/config";
import OAuth from "oauth-1.0a";
import crypto from "crypto";

const apiKey = process.env.TWITTER_API_KEY;
const apiSecret = process.env.TWITTER_API_SECRET_KEY;
const accessToken = process.env.TWITTER_ACCESS_TOKEN;
const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;
const envName = process.env.TWITTER_ENV_NAME || "dev";

if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
  console.error("Missing Twitter API credentials in .env file.");
  process.exit(1);
}

const webhookUrl = process.argv[2];
if (!webhookUrl) {
  console.error("Usage: npx tsx src/register-webhook.ts <your_public_webhook_url>");
  console.error("Example: npx tsx src/register-webhook.ts https://my-agent.up.railway.app/api/twitter-webhook");
  process.exit(1);
}

const oauth = new OAuth({
  consumer: { key: apiKey, secret: apiSecret },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  }
});

const token = {
  key: accessToken,
  secret: accessTokenSecret
};

async function registerWebhook() {
  console.log(`[XAA REGISTER] Starting registration for URL: ${webhookUrl}`);
  console.log(`[XAA REGISTER] Environment name: ${envName}`);

  const registerUrl = `https://api.twitter.com/1.1/account_activity/all/${envName}/webhooks.json?url=${encodeURIComponent(webhookUrl)}`;
  const requestData = {
    url: registerUrl,
    method: 'POST'
  };

  const headers = oauth.toHeader(oauth.authorize(requestData, token)) as unknown as Record<string, string>;

  try {
    const res = await fetch(registerUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      }
    });

    // Handle responses which might not be JSON if they error out early
    const contentType = res.headers.get("content-type");
    let data: any = {};
    if (contentType && contentType.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      console.error("[XAA REGISTER] Unexpected non-JSON response:", text);
      return;
    }

    if (!res.ok) {
      console.error("[XAA REGISTER] Webhook registration failed:", JSON.stringify(data));
      return;
    }

    const webhookId = data.id;
    console.log(`[XAA REGISTER] ✓ Webhook registered successfully! ID: ${webhookId}`);

    // Now, create the user subscription
    console.log(`[XAA REGISTER] Subscribing user account to webhook...`);
    const subscribeUrl = `https://api.twitter.com/1.1/account_activity/all/${envName}/subscriptions.json`;
    const subRequestData = {
      url: subscribeUrl,
      method: 'POST'
    };

    const subHeaders = oauth.toHeader(oauth.authorize(subRequestData, token)) as unknown as Record<string, string>;

    const subRes = await fetch(subscribeUrl, {
      method: 'POST',
      headers: {
        ...subHeaders,
        'Content-Type': 'application/json'
      }
    });

    if (subRes.ok) {
      console.log("[XAA REGISTER] ✓ User subscription created successfully! Real-time tweets are now active.");
    } else {
      const subData = await subRes.text();
      console.error("[XAA REGISTER] Subscription failed:", subData);
    }
  } catch (err: any) {
    console.error("[XAA REGISTER] Exception during registration:", err.message || err);
  }
}

registerWebhook();
