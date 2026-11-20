// Creates a tenant, a workspace and an admin member, and prints the admin's API token once.
// With --email the admin can also log in with a password: a random initial password is printed
// once and must be changed at first login.
// Env: DATABASE_URL (owner credentials).
// Usage: node src/cli/bootstrap.ts --tenant <name> --workspace <name> --admin <display name>
//          [--email <address>]
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { normalizeEmail } from "@aep/domain";
import { Argon2PasswordHasher } from "@aep/identity-local";
import { bootstrapTenant } from "@aep/postgres";
import { connectDatabase, requireEnv } from "../database.ts";

const { values } = parseArgs({
  options: {
    tenant: { type: "string", default: "Demo" },
    workspace: { type: "string", default: "Default" },
    admin: { type: "string", default: "Operator" },
    email: { type: "string" },
  },
});

let login: { adminEmail: string; adminPasswordHash: string; password: string } | undefined;
if (values.email !== undefined) {
  const email = normalizeEmail(values.email);
  if (!email.ok) {
    console.error(`--email ${email.error.reason}`);
    process.exit(1);
  }
  // 18 random bytes are 24 base64url characters, above the 12-character minimum.
  const password = randomBytes(18).toString("base64url");
  login = {
    adminEmail: email.value,
    adminPasswordHash: await new Argon2PasswordHasher().hash(password),
    password,
  };
}

const db = connectDatabase(requireEnv("DATABASE_URL"));
try {
  const created = await bootstrapTenant(db, {
    tenantName: values.tenant,
    workspaceName: values.workspace,
    adminName: values.admin,
    ...(login === undefined
      ? {}
      : { adminEmail: login.adminEmail, adminPasswordHash: login.adminPasswordHash }),
  });
  const shown =
    login === undefined
      ? created
      : { ...created, email: login.adminEmail, initialPassword: login.password };
  console.log(JSON.stringify(shown, null, 2));
  console.error(
    login === undefined
      ? "The token above is shown only once. Store it now."
      : "The token and the initial password above are shown only once. Store them now; the password must be changed at first login.",
  );
} finally {
  await db.destroy();
}
