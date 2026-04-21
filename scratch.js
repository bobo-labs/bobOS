const fs = require('fs');
const files = [
  './apps/agent/src/providers/TokenVerificationProvider.ts',
  './apps/agent/src/evaluators/BoboPersuasionEvaluator.ts',
  './apps/agent/src/actions/VERIFY_BRIBE.ts',
  './apps/agent/src/actions/EXECUTE_WALLET_ROAST.ts'
];
files.forEach(f => {
  let c = fs.readFileSync(f, 'utf8');
  c = c.replace(/eq\([^,]+,\s*[^\)]+\)/g, match => {
    return `${match} as any`;
  });
  c = c.replace(/where\(eq\(/g, 'where((eq(');
  c = c.replace(/as any\)/g, 'as any))'); // Fix closure
  
  // Let's just do a simpler replace since regex parsing might be messy:
  // we know the syntax is: .where(eq(users.user_id, ...))
});
