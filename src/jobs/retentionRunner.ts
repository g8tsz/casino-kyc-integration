import "dotenv/config";
import { ensureDefaultPolicies, runRetention } from "../services/retentionService.js";

async function main() {
  await ensureDefaultPolicies();
  const results = await runRetention();
  console.log("Retention run complete:", JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
