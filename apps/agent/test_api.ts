import { config } from "dotenv";
config({ path: "../../.env" });
import { api } from "@coin-communities/sdk";
console.log(Object.keys(api));
