import { connectDatabase as connect, type Database } from "@aep/postgres";
import type { Kysely } from "kysely";

/** A lost idle connection is logged and replaced, not fatal (see connectDatabase). */
export const connectDatabase = (connectionString: string): Kysely<Database> =>
  connect(connectionString, {
    onError: (error) => {
      console.error(JSON.stringify({ msg: "database connection lost", error: error.message }));
    },
  });

/** Reads a required environment variable or exits with a message naming it. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}
