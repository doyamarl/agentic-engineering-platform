// Applies migrations as the schema owner, then (re)grants the runtime role its privileges.
// Env: DATABASE_URL (owner credentials), APP_DB_ROLE (runtime role name).
import { grantRuntimeAccess, migrateToLatest } from "@aep/postgres";
import { connectDatabase, requireEnv } from "../database.ts";

const db = connectDatabase(requireEnv("DATABASE_URL"));
try {
  await migrateToLatest(db);
  await grantRuntimeAccess(db, requireEnv("APP_DB_ROLE"));
  console.log("migrations applied");
} finally {
  await db.destroy();
}
