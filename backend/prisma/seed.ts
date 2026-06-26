import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'Seeding requires SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD to be set.',
    );
  }

  if (password.length < 12) {
    throw new Error('SEED_SUPER_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    },
  });

  console.log(`[seed] super admin ready: ${user.email} (${user.role})`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
