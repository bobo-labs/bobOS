import { pgTable, uuid, varchar, boolean, doublePrecision, timestamp, integer } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  user_id: uuid("user_id").primaryKey().defaultRandom(),
  solana_wallet: varchar("solana_wallet", { length: 44 }),
  point_one_verified: boolean("point_one_verified").default(false),
  point_two_convinced: boolean("point_two_convinced").default(false),
  point_two_bribed: boolean("point_two_bribed").default(false),
  roast_published: boolean("roast_published").default(false),
  token_balance: doublePrecision("token_balance").default(0),
  last_roast_published_at: timestamp("last_roast_published_at"),
  roasts_count: integer("roasts_count").default(0),
  persuasion_attempts: integer("persuasion_attempts").default(0)
});
