import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import multer from "multer";
import { prisma } from "./prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authMiddleware, AuthRequest } from "./middleware/auth";

const app = express();
app.use(cors());
app.use(express.json());

// ===== Upload setup =====
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Upload nota/invoice aset: hanya PDF/JPG/PNG, maks 5 MB
const invoiceUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["application/pdf", "image/jpeg", "image/png"].includes(
      file.mimetype
    );
    if (ok) cb(null, true);
    else cb(new Error("Format nota harus PDF, JPG, atau PNG"));
  },
});

app.use("/uploads", express.static(uploadDir));

// ===== Auth =====
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ message: "Email atau password salah" });
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    return res.status(401).json({ message: "Email atau password salah" });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, employeeId: user.employeeId },
    process.env.JWT_SECRET as string,
    { expiresIn: "1d" }
  );

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      employeeId: user.employeeId,
    },
  });
});

app.use(authMiddleware);

// Jumlah unit yang rusak dan sedang tidak dipinjam, per aset.
// Unit seperti ini tidak dihitung sebagai stok tersedia.
async function damagedIdleCounts(assetIds?: string[]) {
  const units = await prisma.assetUnit.findMany({
    where: {
      status:"available",
      condition:"damaged",
      ...(assetIds ? { assetId: { in: assetIds } } : {}),
    },
    select: { assetId: true },
  });

  const map = new Map<string, number>();
  for (const u of units) {
    map.set(u.assetId, (map.get(u.assetId) || 0) + 1);
  }
  return map;
}

app.get("/assets", async (_req, res) => {
  const assets = await prisma.asset.findMany({
    orderBy: { createdAt: "desc" },
    include: { category: true },
  });

  const activeHistory = await prisma.assignmentHistory.findMany({
    where: { returnedAt: null },
    select: { assetId: true, quantity: true },
  });

  const borrowedMap = new Map<string, number>();
  for (const h of activeHistory) {
    borrowedMap.set(h.assetId, (borrowedMap.get(h.assetId) || 0) + h.quantity);
  }

  const damagedMap = await damagedIdleCounts();

  const result = assets.map((a) => ({
    ...a,
    borrowedQuantity: borrowedMap.get(a.id) || 0,
    availableQuantity: Math.max(
      0,
      a.quantity - (borrowedMap.get(a.id) || 0) - (damagedMap.get(a.id) || 0)
    ),
  }));

  res.json(result);
});

app.get("/assets/:id", async (req, res) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset) return res.status(404).json({ message: "Asset not found" });

  const activeHistory = await prisma.assignmentHistory.findMany({
    where: { assetId: req.params.id, returnedAt: null },
    select: { quantity: true },
  });
  const borrowed = activeHistory.reduce((sum, h) => sum + h.quantity, 0);

  const damagedMap = await damagedIdleCounts([asset.id]);
  const damaged = damagedMap.get(asset.id) || 0;

  res.json({
    ...asset,
    availableQuantity: Math.max(0, asset.quantity - borrowed - damaged),
  });
});

function makeUnitPrefix(name: string) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

app.get("/assets/:id/units", async (req, res) => {
  const units = await prisma.assetUnit.findMany({
    where: { assetId: req.params.id },
    orderBy: { idNumber: "asc" },
  });
  res.json(units);
});

// GET semua unit dari semua aset (buat halaman Inventaris)
app.get("/asset-units", async (req, res) => {
  try {
    const units = await prisma.assetUnit.findMany({
      include: {
        asset: {
          include: {
            category: true,
            location: true,
          },
        },
      },
      orderBy: { idNumber: "asc" },
    });
    res.json(units);
  } catch (e) {
    console.error("GET /asset-units error:", e);
    res.status(500).json({ error: "Gagal mengambil data inventaris" });
  }
});

// Ubah kondisi unit (baik / rusak)
app.put("/units/:unitId/condition", async (req: AuthRequest, res) => {
  if (req.user?.role !== "admin") {
    return res
      .status(403)
      .json({ message: "Hanya admin yang bisa mengubah kondisi unit" });
  }

  const { condition, conditionNote, damageLevel, urgency } = req.body;

  if (!["good", "damaged"].includes(condition)) {
    return res.status(400).json({ message: "Kondisi tidak valid" });
  }

  if (condition === "damaged") {
    if (!["ringan", "sedang", "berat"].includes(damageLevel)) {
      return res.status(400).json({ message: "Jenis kerusakan wajib dipilih" });
    }
    if (!["rendah", "menengah", "tinggi", "darurat"].includes(urgency)) {
      return res.status(400).json({ message: "Urgensi wajib dipilih" });
    }
  }

  try {
    const unit = await prisma.assetUnit.update({
      where: { id: req.params.unitId as string },
      data: {
        condition,
        conditionNote: conditionNote?.trim() || null,
        damageLevel: condition === "damaged" ? damageLevel : null,
        urgency: condition === "damaged" ? urgency : null,
      },
    });
    res.json(unit);
  } catch (e) {
    console.error("PUT /units/:unitId/condition error:", e);
    res.status(404).json({ message: "Unit tidak ditemukan" });
  }
});

// Ubah ID Number unit
app.put("/units/:unitId/id-number", async (req: AuthRequest, res) => {
  if (req.user?.role !== "admin") {
    return res
      .status(403)
      .json({ message: "Hanya admin yang bisa mengubah ID Number" });
  }

  const { idNumber } = req.body;
  if (!idNumber || typeof idNumber !== "string" || !idNumber.trim()) {
    return res.status(400).json({ message: "ID Number tidak boleh kosong" });
  }

  try {
    const existing = await prisma.assetUnit.findUnique({
      where: { idNumber: idNumber.trim() },
    });
    if (existing && existing.id !== req.params.unitId) {
      return res
        .status(400)
        .json({ message: "ID Number sudah dipakai unit lain" });
    }

    const unit = await prisma.assetUnit.update({
      where: { id: req.params.unitId as string },
      data: { idNumber: idNumber.trim() },
    });
    res.json(unit);
  } catch (e) {
    console.error("PUT /units/:unitId/id-number error:", e);
    res.status(404).json({ message: "Unit tidak ditemukan" });
  }
});

app.post("/assets", (req, res) => {
  invoiceUpload.single("invoice")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg =
        (uploadErr as any).code === "LIMIT_FILE_SIZE"
          ? "Ukuran nota maksimal 5 MB"
          : uploadErr.message;
      return res.status(400).json({ message: msg });
    }

    try {
      const {
        name,
        type,
        categoryId,
        locationId,
        value,
        purchaseDate,
        invoiceNumber,
        vendorName,
      } = req.body;

      if (!name?.trim() || !categoryId || !locationId) {
        throw new Error("Nama, kategori, dan lokasi wajib diisi");
      }
      if (!invoiceNumber?.trim() || !vendorName?.trim()) {
        throw new Error("Nomor invoice dan nama vendor wajib diisi");
      }
      if (!req.file) {
        throw new Error("Nota / invoice wajib diupload");
      }

      const quantity = req.body.quantity ? Number(req.body.quantity) : 1;

      const asset = await prisma.asset.create({
        data: {
          name: name.trim(),
          type: type?.trim() || null,
          categoryId,
          locationId,
          value: value ? Number(value) : null,
          purchaseDate: purchaseDate || null,
          quantity,
          invoiceNumber: invoiceNumber.trim(),
          vendorName: vendorName.trim(),
          invoicePath: req.file.filename,
        },
      });

      const prefix = makeUnitPrefix(asset.name);
      const unitsData = Array.from({ length: quantity }, (_, i) => ({
        assetId: asset.id,
        idNumber: `${prefix}-${String(i + 1).padStart(3, "0")}`,
        status: "available",
      }));

      await prisma.assetUnit.createMany({ data: unitsData });

      res.status(201).json(asset);
    } catch (e) {
      // hapus file yang sudah terupload kalau gagal menyimpan
      if (req.file) fs.unlink(req.file.path, () => {});
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ message: msg, error: msg });
    }
  });
});

app.get("/assets/:id/history", async (req, res) => {
  const history = await prisma.assignmentHistory.findMany({
    where: { assetId: req.params.id },
    include: { employee: true },
    orderBy: { assignedAt: "desc" },
  });
  res.json(history);
});

app.put("/assets/:id", async (req, res) => {
  try {
    if (req.body.quantity !== undefined) {
      const newQty = Number(req.body.quantity);
      if (isNaN(newQty) || newQty < 0) {
        return res.status(400).json({ message: "Jumlah tidak valid" });
      }

      const activeHistory = await prisma.assignmentHistory.findMany({
        where: { assetId: req.params.id, returnedAt: null },
        select: { quantity: true },
      });
      const borrowed = activeHistory.reduce((sum, h) => sum + h.quantity, 0);

      if (newQty < borrowed) {
        return res.status(400).json({
          message: `Jumlah tidak boleh kurang dari yang sedang dipinjam (${borrowed})`,
        });
      }
    }

    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(asset);
  } catch {
    res.status(404).json({ message: "Asset not found" });
  }
});

app.delete("/assets/:id", async (req, res) => {
  try {
    await prisma.asset.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ message: "Asset not found" });
  }
});

// ===== Category =====
app.get("/categories", async (_req, res) => {
  const categories = await prisma.category.findMany();
  res.json(categories);
});

app.post("/categories", async (req, res) => {
  try {
    const category = await prisma.category.create({ data: req.body });
    res.status(201).json(category);
  } catch (e) {
    res.status(400).json({ message: "Invalid data", error: String(e) });
  }
});

app.put("/categories/:id", async (req, res) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(category);
  } catch {
    res.status(404).json({ message: "Category not found" });
  }
});

app.delete("/categories/:id", async (req, res) => {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ message: "Category not found" });
  }
});

// ===== Location =====
app.get("/locations", async (_req, res) => {
  const locations = await prisma.location.findMany();
  res.json(locations);
});

app.get("/locations/:id", async (req, res) => {
  const location = await prisma.location.findUnique({ where: { id: req.params.id } });
  if (!location) {
    return res.status(404).json({ message: "Location not found" });
  }

  const assets = await prisma.asset.findMany({ where: { locationId: req.params.id } });

  const activeHistory = await prisma.assignmentHistory.findMany({
    where: { returnedAt: null, asset: { locationId: req.params.id } },
    select: { assetId: true, quantity: true },
  });

  const borrowedMap = new Map<string, number>();
  for (const h of activeHistory) {
    borrowedMap.set(h.assetId, (borrowedMap.get(h.assetId) || 0) + h.quantity);
  }

  const damagedMap = await damagedIdleCounts(assets.map((a) => a.id));

  const assetsWithStock = assets.map((a) => ({
    ...a,
    availableQuantity: Math.max(
      0,
      a.quantity - (borrowedMap.get(a.id) || 0) - (damagedMap.get(a.id) || 0)
    ),
  }));

  res.json({ ...location, assets: assetsWithStock });
});

app.post("/locations", async (req, res) => {
  try {
    const location = await prisma.location.create({ data: req.body });
    res.status(201).json(location);
  } catch (e) {
    res.status(400).json({ message: "Invalid data", error: String(e) });
  }
});

app.put("/locations/:id", async (req, res) => {
  try {
    const location = await prisma.location.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(location);
  } catch {
    res.status(404).json({ message: "Location not found" });
  }
});

app.delete("/locations/:id", async (req, res) => {
  try {
    await prisma.location.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ message: "Location not found" });
  }
});

// ===== Employee =====
app.get("/employees", async (_req, res) => {
  const employees = await prisma.employee.findMany({
    include: { user: { select: { email: true } } },
  });
  res.json(employees);
});

app.post("/employees", async (req, res) => {
  try {
    const employee = await prisma.employee.create({ data: req.body });
    res.status(201).json(employee);
  } catch (e) {
    res.status(400).json({ message: "Invalid data", error: String(e) });
  }
});

app.put("/employees/:id", async (req, res) => {
  try {
    const employee = await prisma.employee.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(employee);
  } catch {
    res.status(404).json({ message: "Employee not found" });
  }
});

app.delete("/employees/:id", async (req, res) => {
  try {
    await prisma.employee.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ message: "Employee not found" });
  }
});

// ===== Staff Account =====
app.post("/employees/:id/create-account", async (req: AuthRequest, res) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Hanya admin yang bisa membuat akun staff" });
  }

  const { email, password } = req.body;
  const employeeId = req.params.id as string;

  try {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ message: "Email sudah dipakai" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        name: employee.name,
        role: "staff",
        employeeId: employee.id,
      },
    });

    res.status(201).json({ id: user.id, email: user.email, name: user.name });
  } catch (e) {
    res.status(400).json({ message: "Gagal membuat akun", error: String(e) });
  }
});

// ===== Assignment (berbasis stok) =====
app.post("/assets/:id/assign", async (req, res) => {
  const { employeeId, quantity, note } = req.body;

  try {
    const qty = Number(quantity) || 1;
    if (qty < 1) {
      return res.status(400).json({ message: "Jumlah harus lebih dari 0" });
    }

    const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!asset) {
      return res.status(404).json({ message: "Asset not found" });
    }

    // hanya unit yang tersedia DAN kondisinya baik
    const availableUnits = await prisma.assetUnit.findMany({
      where: { assetId: req.params.id, status: "available", condition: "good" },
      orderBy: { idNumber: "asc" },
      take: qty,
    });

    if (availableUnits.length < qty) {
      return res
        .status(400)
        .json({ message: `Stok tidak cukup. Sisa stok: ${availableUnits.length}` });
    }

    const assignment = await prisma.$transaction(async (tx) => {
      const created = await tx.assignmentHistory.create({
        data: {
          assetId: req.params.id,
          employeeId,
          quantity: qty,
          note,
        },
      });

      await tx.assetUnit.updateMany({
        where: { id: { in: availableUnits.map((u) => u.id) } },
        data: { status: "borrowed", currentAssignmentHistoryId: created.id },
      });

      return created;
    });

    res.status(201).json(assignment);
  } catch (e) {
    res.status(400).json({ message: "Gagal assign aset", error: String(e) });
  }
});

app.post("/assets/:id/return", async (req: AuthRequest, res) => {
  const { historyId } = req.body;

  try {
    const record = await prisma.assignmentHistory.findUnique({
      where: { id: historyId },
    });

    if (!record || record.assetId !== req.params.id || record.returnedAt) {
      return res.status(400).json({ message: "Data peminjaman tidak valid" });
    }

    if (req.user?.role === "staff" && record.employeeId !== req.user.employeeId) {
      return res.status(403).json({ message: "Tidak bisa mengembalikan aset milik orang lain" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.assignmentHistory.update({
        where: { id: historyId },
        data: { returnedAt: new Date() },
      });

      await tx.assetUnit.updateMany({
        where: { currentAssignmentHistoryId: historyId },
        data: { status: "available", currentAssignmentHistoryId: null },
      });
    });

    res.json({ message: "Aset berhasil dikembalikan" });
  } catch (e) {
    res.status(400).json({ message: "Gagal mengembalikan aset", error: String(e) });
  }
});

// ===== Asset Request (staff) =====
app.get("/requests", async (req: AuthRequest, res) => {
  const where = req.user?.role === "staff" ? { employeeId: req.user.employeeId || "" } : {};

  const requests = await prisma.assetRequest.findMany({
    where,
    include: {
      asset: true,
      employee: true,
      assignmentHistory: { select: { id: true, returnedAt: true } },
    },
    orderBy: { requestedAt: "desc" },
  });
  res.json(requests);
});

app.post("/requests", upload.single("document"), async (req: AuthRequest, res) => {
  try {
    if (req.user?.role !== "staff" || !req.user.employeeId) {
      return res.status(403).json({ message: "Hanya staff yang bisa membuat request" });
    }

    const { assetId, note } = req.body;
    const quantity = Number(req.body.quantity);

    if (!assetId) {
      return res.status(400).json({ message: "Aset wajib dipilih" });
    }
    if (!quantity || quantity < 1) {
      return res.status(400).json({ message: "Jumlah minimal 1" });
    }
    if (!req.file) {
      return res.status(400).json({ message: "Dokumen surat jalan wajib diupload" });
    }

    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) {
      return res.status(404).json({ message: "Asset not found" });
    }

    const activeHistory = await prisma.assignmentHistory.findMany({
      where: { assetId, returnedAt: null },
      select: { quantity: true },
    });
    const borrowed = activeHistory.reduce((s, h) => s + h.quantity, 0);
    const damagedMap = await damagedIdleCounts([assetId]);
    const damaged = damagedMap.get(assetId) || 0;
    const available = Math.max(0, asset.quantity - borrowed - damaged);

    if (quantity > available) {
      return res.status(400).json({ message: `Stok tidak cukup. Sisa stok: ${available}` });
    }

    const created = await prisma.assetRequest.create({
      data: {
        assetId,
        employeeId: req.user.employeeId,
        quantity,
        note: note || null,
        documentPath: req.file.filename,
        status: "pending",
      },
    });

    res.status(201).json(created);
  } catch (e) {
    console.error("POST /requests error:", e);
    res.status(400).json({ message: "Gagal membuat request", error: String(e) });
  }
});

app.put("/requests/:id/approve", async (req: AuthRequest, res) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Hanya admin yang bisa approve" });
  }

  const requestId = req.params.id as string;

  try {
    const request = await prisma.assetRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "pending") {
      return res.status(400).json({ message: "Request tidak valid" });
    }

    const asset = await prisma.asset.findUnique({ where: { id: request.assetId } });
    if (!asset) {
      return res.status(404).json({ message: "Asset not found" });
    }

    // hanya unit yang tersedia DAN kondisinya baik
    const availableUnits = await prisma.assetUnit.findMany({
      where: { assetId: request.assetId, status: "available", condition: "good" },
      orderBy: { idNumber: "asc" },
      take: request.quantity,
    });

    if (availableUnits.length < request.quantity) {
      return res.status(400).json({ message: `Stok tidak cukup. Sisa stok: ${availableUnits.length}` });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const assignment = await tx.assignmentHistory.create({
        data: {
          assetId: request.assetId,
          employeeId: request.employeeId,
          quantity: request.quantity,
          note: request.note,
        },
      });

      await tx.assetUnit.updateMany({
        where: { id: { in: availableUnits.map((u) => u.id) } },
        data: { status: "borrowed", currentAssignmentHistoryId: assignment.id },
      });

      return tx.assetRequest.update({
        where: { id: requestId },
        data: { status: "approved", decidedAt: new Date(), assignmentHistoryId: assignment.id },
      });
    });

    res.json(updated);
  } catch (e) {
    console.error("APPROVE error:", e);
    res.status(400).json({ message: "Gagal approve request", error: String(e) });
  }
});

app.put("/requests/:id/reject", async (req: AuthRequest, res) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Hanya admin yang bisa reject" });
  }

  const requestId = req.params.id as string;

  try {
    const request = await prisma.assetRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== "pending") {
      return res.status(400).json({ message: "Request tidak valid" });
    }

    const updated = await prisma.assetRequest.update({
      where: { id: requestId },
      data: { status: "rejected", decidedAt: new Date() },
    });

    res.json(updated);
  } catch (e) {
    res.status(400).json({ message: "Gagal reject request", error: String(e) });
  }
});

// ===== Dashboard Stats =====
app.get("/dashboard/stats", async (_req, res) => {
  try {
    const assets = await prisma.asset.findMany({
      include: { category: true },
    });

    const activeHistory = await prisma.assignmentHistory.findMany({
      where: { returnedAt: null },
      select: { quantity: true },
    });

    const pendingRequests = await prisma.assetRequest.count({
      where: { status: "pending" },
    });

    const totalAssets = assets.length;
    const totalStock = assets.reduce((sum, a) => sum + a.quantity, 0);
    const totalBorrowed = activeHistory.reduce((sum, h) => sum + h.quantity, 0);

    const categoryMap = new Map<string, number>();
    for (const a of assets) {
      const catName = a.category.name;
      categoryMap.set(catName, (categoryMap.get(catName) || 0) + 1);
    }
    const perCategory = Array.from(categoryMap.entries()).map(([name, count]) => ({
      name,
      count,
    }));

    const recentHistoryRaw = await prisma.assignmentHistory.findMany({
      orderBy: { assignedAt: "desc" },
      take: 10,
      include: { employee: true, asset: true },
    });

    const recentHistory = recentHistoryRaw.map((h) => ({
      id: h.id,
      employeeName: h.employee.name,
      assetName: h.asset.name,
      quantity: h.quantity,
      assignedAt: h.assignedAt,
      returnedAt: h.returnedAt,
    }));

    const activeBorrowsRaw = await prisma.assignmentHistory.findMany({
      where: { returnedAt: null },
      orderBy: { assignedAt: "desc" },
      include: { employee: true, asset: true },
    });

    const activeBorrows = activeBorrowsRaw.map((h) => ({
      id: h.id,
      employeeName: h.employee.name,
      department: h.employee.department,
      assetName: h.asset.name,
      quantity: h.quantity,
      assignedAt: h.assignedAt,
    }));

    res.json({
      totalAssets,
      totalStock,
      totalBorrowed,
      pendingRequests,
      perCategory,
      recentHistory,
      activeBorrows,
    });
  } catch (e) {
    res.status(400).json({ message: "Gagal memuat statistik", error: String(e) });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));