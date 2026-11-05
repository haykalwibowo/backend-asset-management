import express from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth";
import { ROLES } from "../roles";
import { parseDateOnly, todayStr } from "../purchase/delegation";

export const delegationsRouter = express.Router();

const userBrief = {
  select: { id: true, name: true, role: true, employee: { select: { position: true } } },
} as const;

const delegationInclude = {
  delegator: userBrief,
  delegate: userBrief,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ApprovalDelegationInclude;

type DelegationRow = Prisma.ApprovalDelegationGetPayload<{ include: typeof delegationInclude }>;

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function serialize(d: DelegationRow) {
  const today = todayStr();
  const start = dateOnly(d.startDate);
  const end = dateOnly(d.endDate);
  const state = d.cancelledAt
    ? "cancelled"
    : end < today
    ? "expired"
    : start > today
    ? "scheduled"
    : "active";
  const person = (u: DelegationRow["delegator"]) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    position: u.employee?.position ?? null,
  });
  return {
    id: d.id,
    delegator: person(d.delegator),
    delegate: person(d.delegate),
    startDate: start,
    endDate: end,
    note: d.note,
    createdBy: d.createdBy,
    cancelledAt: d.cancelledAt,
    state,
  };
}

// Delegasi milik saya (yang saya berikan & yang saya terima).
// Super Admin dengan ?all=1 melihat semua delegasi.
delegationsRouter.get("/", async (req: AuthRequest, res) => {
  const user = req.user!;
  const all = req.query.all === "1" && user.role === ROLES.ADMIN;
  const rows = await prisma.approvalDelegation.findMany({
    where: all ? {} : { OR: [{ delegatorId: user.id }, { delegateId: user.id }] },
    include: delegationInclude,
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });
  res.json(rows.map(serialize));
});

// Daftar user yang bisa dipilih sebagai pengganti / pemberi delegasi
delegationsRouter.get("/candidates", async (req: AuthRequest, res) => {
  const users = await prisma.user.findMany({
    where: { employeeId: { not: null } },
    select: { id: true, name: true, role: true, employee: { select: { position: true } } },
    orderBy: { name: "asc" },
  });
  res.json(
    users.map((u) => ({ id: u.id, name: u.name, role: u.role, position: u.employee?.position ?? null }))
  );
});

delegationsRouter.post("/", async (req: AuthRequest, res) => {
  const user = req.user!;
  const b = req.body ?? {};

  // Super Admin boleh membuat delegasi atas nama siapa pun
  const delegatorId: string =
    user.role === ROLES.ADMIN && typeof b.delegatorUserId === "string" && b.delegatorUserId
      ? b.delegatorUserId
      : user.id;
  const delegateId = typeof b.delegateUserId === "string" ? b.delegateUserId : "";
  const start = parseDateOnly(b.startDate);
  const end = parseDateOnly(b.endDate);
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;

  if (!delegateId) return res.status(400).json({ message: "Pengganti wajib dipilih" });
  if (delegateId === delegatorId) {
    return res.status(400).json({ message: "Tidak bisa mendelegasikan ke diri sendiri" });
  }
  if (!start || !end) return res.status(400).json({ message: "Tanggal mulai dan selesai wajib diisi" });
  if (b.endDate < b.startDate) {
    return res.status(400).json({ message: "Tanggal selesai tidak boleh sebelum tanggal mulai" });
  }
  if (b.endDate < todayStr()) {
    return res.status(400).json({ message: "Tanggal selesai tidak boleh sebelum hari ini" });
  }

  const [delegator, delegate] = await Promise.all([
    prisma.user.findUnique({ where: { id: delegatorId } }),
    prisma.user.findUnique({ where: { id: delegateId } }),
  ]);
  if (!delegator) return res.status(404).json({ message: "Pemberi delegasi tidak ditemukan" });
  if (!delegate) return res.status(404).json({ message: "Pengganti tidak ditemukan" });

  // Satu orang hanya boleh punya satu pengganti di periode yang sama
  const overlap = await prisma.approvalDelegation.findFirst({
    where: {
      delegatorId,
      cancelledAt: null,
      startDate: { lte: end },
      endDate: { gte: start },
    },
    include: { delegate: { select: { name: true } } },
  });
  if (overlap) {
    return res.status(400).json({
      message: `Sudah ada delegasi ke ${overlap.delegate.name} di periode ${dateOnly(
        overlap.startDate
      )} s/d ${dateOnly(overlap.endDate)}. Batalkan dulu kalau mau diganti.`,
    });
  }

  const created = await prisma.approvalDelegation.create({
    data: { delegatorId, delegateId, startDate: start, endDate: end, note, createdById: user.id },
    include: delegationInclude,
  });
  res.status(201).json(serialize(created));
});

// Batalkan delegasi (oleh pemberi, pembuat, atau Super Admin)
delegationsRouter.delete("/:id", async (req: AuthRequest, res) => {
  const user = req.user!;
  const d = await prisma.approvalDelegation.findUnique({ where: { id: req.params.id as string } });
  if (!d) return res.status(404).json({ message: "Delegasi tidak ditemukan" });
  if (user.role !== ROLES.ADMIN && d.delegatorId !== user.id && d.createdById !== user.id) {
    return res.status(403).json({ message: "Anda tidak berhak membatalkan delegasi ini" });
  }
  if (d.cancelledAt) return res.status(400).json({ message: "Delegasi sudah dibatalkan" });

  await prisma.approvalDelegation.update({
    where: { id: d.id },
    data: { cancelledAt: new Date() },
  });
  res.status(204).send();
});
