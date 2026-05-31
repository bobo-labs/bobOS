import { config } from "dotenv";
config();
import { configureApi, api } from "@coin-communities/sdk";
configureApi({ baseUrl: "https://api.coin-communities.xyz", headers: { "x-api-key": process.env.CC_API_KEY || "" } });
api.getCommunities({}).then(res => console.log(JSON.stringify(res.data, null, 2))).catch(console.error);
