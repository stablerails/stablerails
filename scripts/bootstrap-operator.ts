/**
 * DEV-ONLY operator bootstrap.
 *
 * Creates a local operator account by writing directly to the database,
 * bypassing the TTY-gated `operator init` flow. This is ONLY acceptable for
 * local development; the production path is the interactive CLI in
 * src/cli/commands/operator.ts (passphrase entered at the TTY, never via env).
 *
 * Safety rails:
 *   - Refuses to run when NODE_ENV === "production".
 *   - No default password: BOOTSTRAP_OPERATOR_PASSWORD must be set explicitly.
 */
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

async function main() {
  if (process.env['NODE_ENV'] === 'production') {
    console.error(
      'bootstrap-operator: refusing to run with NODE_ENV=production. ' +
        'This script is dev-only; use the TTY-gated `operator init` CLI (src/cli/commands/operator.ts) instead.',
    );
    process.exit(1);
  }

  const password = process.env['BOOTSTRAP_OPERATOR_PASSWORD'];
  if (!password) {
    console.error(
      'bootstrap-operator: BOOTSTRAP_OPERATOR_PASSWORD is not set. ' +
        'Set it to a password of your choice for the local dev operator, e.g.:\n' +
        '  BOOTSTRAP_OPERATOR_PASSWORD="..." npx tsx scripts/bootstrap-operator.ts',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasourceUrl: 'postgresql://stablerails:stablerails_dev@localhost:5432/stablerails' });
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  try {
    const op = await prisma.operator.create({ data: { email: 'admin@example.dev', passwordHash: hash } });
    console.log('operator created:', op.id);
  } catch(e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'P2002') { console.log('operator already exists'); }
    else throw e;
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
