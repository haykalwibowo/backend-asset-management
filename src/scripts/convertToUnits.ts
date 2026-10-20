import { prisma } from "../prisma";

function makeUnitPrefix(name: string) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const assets = await prisma.asset.findMany();

  for (const asset of assets) {
    const existingUnits = await prisma.assetUnit.count({
      where: { assetId: asset.id },
    });
    if (existingUnits > 0) {
      console.log(`Lewati "${asset.name}" (sudah punya unit)`);
      continue;
    }

    const prefix = makeUnitPrefix(asset.name);
    const total = asset.quantity;

    for (let i = 1; i <= total; i++) {
      const idNumber =
        i === 1 && asset.serialNumber
          ? asset.serialNumber
          : `${prefix}-${String(i).padStart(3, "0")}`;

      await prisma.assetUnit.create({
        data: {
          assetId: asset.id,
          idNumber,
          status: "available",
        },
      });
    }

    console.log(`"${asset.name}": dibuat ${total} unit`);
  }

  console.log("Selesai konversi ke per-unit.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));