import { db, users } from './index';
import { eq } from 'drizzle-orm';

async function main() {
  console.log("Checking user...");
  const u = await db.select().from(users).limit(1);
  console.log(u);
  process.exit(0);
}
main().catch(console.error);
