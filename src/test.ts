import { prisma } from "./prisma";

async function main() {
  const assets = await prisma.asset.findMany();
  console.log(assets);
}

main().finally(() => prisma.$disconnect());