import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

/**
 * A pool for the API and the worker. pg emits an error on the pool when an idle connection dies
 * (the database restarted, or an administrator ended the session); without a listener that error
 * ends the process. The pool drops the broken connection and opens a new one for the next query.
 */
export function connectDatabase(
  connectionString: string,
  options: { readonly max?: number; readonly onError: (error: Error) => void },
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  pool.on("error", options.onError);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
