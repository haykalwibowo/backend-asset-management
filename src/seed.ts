import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

async function main() {
  const hashedPassword = await bcrypt.hash("admin123", 10);

  const admin = await prisma.user.create({
    data: {
      email: "admin@company.com",
      password: hashedPassword,
      name: "Admin IT",
      role: "admin",
    },
  });

  console.log("Admin berhasil dibuat:", admin);
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit());