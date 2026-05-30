import { pgTable, uuid, varchar, boolean, doublePrecision, timestamp, integer, text, uniqueIndex } from "drizzle-orm/pg-core";

// CC token store — one row per Twitter user who has authorized their CC account.
// The agent uses these tokens to post on their behalf and auto-refreshes before expiry.
export const ccLinkedAccounts = pgTable("cc_linked_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  twitter_id: varchar("twitter_id", { length: 32 }).notNull().unique(),
  twitter_username: varchar("twitter_username", { length: 100 }),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token").notNull(),
  expires_at: timestamp("expires_at").notNull(),
  wallet_address: varchar("wallet_address", { length: 100 }),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  twitterIdIdx: uniqueIndex("cc_linked_accounts_twitter_id_idx").on(table.twitter_id),
}));

// One-time invite codes that gate access to the onboarding flow.
// Admin generates these manually (or later: auto-generated after fee payment).
export const inviteCodes = pgTable("invite_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  used: boolean("used").notNull().default(false),
  used_by: varchar("used_by", { length: 100 }),   // twitter_id or username once consumed
  note: varchar("note", { length: 200 }),           // optional admin label (e.g. "@username")
  created_at: timestamp("created_at").defaultNow().notNull(),
  used_at: timestamp("used_at"),
}, (table) => ({
  codeIdx: uniqueIndex("invite_codes_code_idx").on(table.code),
}));

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
  persuasion_attempts: integer("persuasion_attempts").default(0),
  agent_memory: text("agent_memory"),
}, (table) => {
  return {
    walletIdx: uniqueIndex("wallet_idx").on(table.solana_wallet),
  };
});

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposer_wallet: varchar("proposer_wallet", { length: 44 }).notNull(),
  title: text("title").notNull(),
  amount: doublePrecision("amount").notNull(),
  recipient: varchar("recipient", { length: 44 }).notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(), // 'active', 'passed', 'defeated'
  remarks: text("remarks"), // Bobo's custom commentary on this proposal
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const votes = pgTable("votes", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposal_id: uuid("proposal_id").references(() => proposals.id, { onDelete: "cascade" }).notNull(),
  voter_wallet: varchar("voter_wallet", { length: 44 }).notNull(),
  vote: varchar("vote", { length: 3 }).notNull(), // 'yes' or 'no'
  weight: doublePrecision("weight").notNull(), // User's token balance at time of vote
  signature: text("signature").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => {
  return {
    proposalVoterIdx: uniqueIndex("proposal_voter_idx").on(table.proposal_id, table.voter_wallet),
  };
});
