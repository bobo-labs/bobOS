import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://postgres.bzrodonxrikwofxkldrg:25508465ale123CA19!@aws-1-us-east-2.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

const sql = `
CREATE TABLE IF NOT EXISTS cc_linked_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twitter_id VARCHAR(32) NOT NULL UNIQUE,
  twitter_username VARCHAR(100),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  wallet_address VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cc_linked_accounts_twitter_id_idx
  ON cc_linked_accounts (twitter_id);
`;

try {
  const client = await pool.connect();
  await client.query(sql);
  client.release();
  console.log('✅ cc_linked_accounts table created (or already exists).');
} catch (err) {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
