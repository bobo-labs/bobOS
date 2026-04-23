const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres.bzrodonxrikwofxkldrg:25508465ale123CA19!@aws-1-us-east-2.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});
pool.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'users';")
  .then(res => { console.log(res.rows); process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
