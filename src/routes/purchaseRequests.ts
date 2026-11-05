import express from "express";
import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth";
import { ROLES } from "../roles";
import { singleDocument, uploadDir } from "../upload";
import { resolveApprover } from "../approver";
import {
  PR_STATUS,
  ApprovalStep,
  LOG_ACTION,
  LOG_STEP,
  FULL_FLOW,
  STATUS_LABEL,
  REQUIREMENT_TYPES,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_SCOPES,
  STATUS_AFTER_PROCUREMENT,
  PURCHASE_METHODS,
  stepOfStatus,
  statusAfter,
  initialStatus,
  formatDocNumber,
} from "../purchase/flow";
import {
  Principal,
  getPrincipals,
  pickActingPrincipal,
  pickProcurementPrincipal,
  parseDateOnly,
  todayStr,
} from "../purchase/delegation";

export const purchaseRequestsRouter = express.Router();

// Role yang terlibat di setiap request, jadi boleh melihat semua request
const VIEW_ALL_ROLES: string[] = [ROLES.ADMIN, ROLES.GA, ROLES.FINANCE, ROLES.PROCUREMENT];

const MAX_ITEMS = 50;
const MAX_PRICE = 1e13;

// ===== Helper =====

const detailInclude = {
  items: { orderBy: { lineNo: "asc" } },
  logs: { orderBy: { createdAt: "asc" } },
  supervisorApprover: { select: { id: true, name: true, position: true } },
} satisfies Prisma.PurchaseRequestInclude;

type DetailRequest = Prisma.PurchaseRequestGetPayload<{ include: typeof detailInclude }>;
type LogRow = DetailRequest["logs"][number];

const summarySelect = {
  id: true,
  docNumber: true,
  createdAt: true,
  dueDate: true,
  requesterName: true,
  requesterDepartment: true,
  purpose: true,
  totalEstimate: true,
  totalFinal: true,
  status: true,
  _count: { select: { items: true } },
} satisfies Prisma.PurchaseRequestSelect;

type SummaryRow = Prisma.PurchaseRequestGetPayload<{ select: typeof summarySelect }>;

function serializeSummary(pr: SummaryRow) {
  const { _count, totalEstimate, totalFinal, ...rest } = pr;
  const estimate = Number(totalEstimate);
  const final = totalFinal === null ? null : Number(totalFinal);
  return {
    ...rest,
    totalEstimate: estimate,
    totalFinal: final,
    overBudget: final !== null && final > estimate,
    itemCount: _count.items,
    statusLabel: STATUS_LABEL[pr.status] ?? pr.status,
  };
}

// Update progres terbaru (mis. dari procurement: "barang masih dicari") per pengajuan
async function latestUpdates(ids: string[]) {
  if (!ids.length) return new Map<string, { note: string | null; actorName: string | null; createdAt: Date }>();
  const notes = await prisma.purchaseRequestLog.findMany({
    where: { requestId: { in: ids }, action: LOG_ACTION.NOTE },
    select: { requestId: true, note: true, actorName: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, { note: string | null; actorName: string | null; createdAt: Date }>();
  for (const n of notes) if (!map.has(n.requestId)) map.set(n.requestId, n);
  return map;
}

function serializeLog(l: Pick<LogRow, "id" | "step" | "action" | "actorName" | "actorPosition" | "onBehalfOfName" | "onBehalfOfPosition" | "note"> & { createdAt: Date }) {
  return {
    id: l.id,
    step: l.step,
    action: l.action,
    actorName: l.actorName,
    actorPosition: l.actorPosition,
    onBehalfOfName: l.onBehalfOfName,
    onBehalfOfPosition: l.onBehalfOfPosition,
    note: l.note,
    createdAt: l.createdAt,
  };
}

// Progress setiap tahap untuk timeline FE
function buildFlow(pr: DetailRequest) {
  const currentIdx = FULL_FLOW.findIndex((f) => f.status === pr.status);
  const waitingFor: Record<string, string> = {
    SUPERVISOR: pr.supervisorApprover?.name ?? "Atasan",
    GA: "Tim GA",
    FINANCE: "Tim Finance",
    PROCUREMENT: "Tim Procurement",
    PAYMENT: "proses pembayaran",
  };

  return FULL_FLOW.map((f, idx) => {
    const stepLogs = pr.logs.filter((l) => l.step === f.key);
    const log = [...stepLogs].reverse().find((l) => l.action !== LOG_ACTION.NOTE);
    const notes = stepLogs.filter((l) => l.action === LOG_ACTION.NOTE).map(serializeLog);
    let state: "done" | "skipped" | "rejected" | "current" | "upcoming" | "cancelled";
    if (f.key === LOG_STEP.SUBMIT || log?.action === LOG_ACTION.APPROVED) state = "done";
    else if (log?.action === LOG_ACTION.SKIPPED) state = "skipped";
    else if (log?.action === LOG_ACTION.REJECTED) state = "rejected";
    else if (pr.status === PR_STATUS.REJECTED) state = "cancelled";
    else if (idx === currentIdx) state = "current";
    else state = "upcoming";

    return {
      key: f.key,
      label: f.label,
      state,
      waitingFor: state === "current" ? waitingFor[f.key] ?? null : null,
      log: log ? serializeLog(log) : null,
      notes,
    };
  });
}

function canView(pr: DetailRequest, req: AuthRequest, principals: Principal[]) {
  const user = req.user!;
  if (principals.some((p) => VIEW_ALL_ROLES.includes(p.role))) return true;
  if (user.employeeId && pr.requesterId === user.employeeId) return true;
  if (principals.some((p) => p.employeeId && p.employeeId === pr.supervisorApproverId)) return true;
  return pr.logs.some((l) => l.actorUserId === user.id || l.onBehalfOfUserId === user.id);
}

// Filter "perlu tindakan saya" berdasarkan dirinya + delegasi yang sedang aktif
function inboxWhere(principals: Principal[]): Prisma.PurchaseRequestWhereInput | null {
  const or: Prisma.PurchaseRequestWhereInput[] = [];
  const employeeIds = principals.map((p) => p.employeeId).filter((id): id is string => !!id);
  if (employeeIds.length) {
    or.push({ status: PR_STATUS.PENDING_SUPERVISOR, supervisorApproverId: { in: employeeIds } });
  }
  if (principals.some((p) => p.role === ROLES.GA)) or.push({ status: PR_STATUS.PENDING_GA });
  if (principals.some((p) => p.role === ROLES.FINANCE)) or.push({ status: PR_STATUS.PENDING_FINANCE });
  if (principals.some((p) => p.role === ROLES.PROCUREMENT)) or.push({ status: PR_STATUS.IN_PROCUREMENT });
  return or.length ? { OR: or } : null;
}

const cleanText = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function isHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ===== List =====
// scope: mine (pengajuan saya) | inbox (perlu tindakan) | processed (pernah saya proses) | all
purchaseRequestsRouter.get("/", async (req: AuthRequest, res) => {
  const user = req.user!;
  const scope = String(req.query.scope || "mine");
  const principals = await getPrincipals(user.id);

  let where: Prisma.PurchaseRequestWhereInput;
  switch (scope) {
    case "mine":
      where = { requesterId: user.employeeId ?? "__none__" };
      break;
    case "inbox":
      where = inboxWhere(principals) ?? { id: "__none__" };
      break;
    case "processed":
      where = {
        logs: {
          some: {
            step: { not: LOG_STEP.SUBMIT },
            action: { notIn: [LOG_ACTION.SKIPPED, LOG_ACTION.NOTE] },
            OR: [{ actorUserId: user.id }, { onBehalfOfUserId: user.id }],
          },
        },
      };
      break;
    case "all":
      if (!principals.some((p) => VIEW_ALL_ROLES.includes(p.role))) {
        return res.status(403).json({ message: "Anda tidak punya akses ke fitur ini" });
      }
      where = {};
      break;
    default:
      return res.status(400).json({ message: "Scope tidak valid" });
  }

  if (scope === "processed") {
    // Riwayat: sertakan keputusan terakhir user ini di tiap pengajuan
    const rows = await prisma.purchaseRequest.findMany({
      where,
      select: {
        ...summarySelect,
        logs: {
          where: {
            step: { not: LOG_STEP.SUBMIT },
            action: { notIn: [LOG_ACTION.SKIPPED, LOG_ACTION.NOTE] },
            OR: [{ actorUserId: user.id }, { onBehalfOfUserId: user.id }],
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    const updates = await latestUpdates(rows.map((r) => r.id));
    const result = rows
      .map(({ logs, ...pr }) => ({
        ...serializeSummary(pr),
        latestUpdate: updates.get(pr.id) ?? null,
        myAction: logs[0] ? serializeLog(logs[0]) : null,
      }))
      // urut dari keputusan terbaru
      .sort((a, b) =>
        String(b.myAction?.createdAt ?? "").localeCompare(String(a.myAction?.createdAt ?? ""))
      );
    return res.json(result);
  }

  const rows = await prisma.purchaseRequest.findMany({
    where,
    select: summarySelect,
    orderBy: { createdAt: scope === "inbox" ? "asc" : "desc" },
  });
  const updates = await latestUpdates(rows.map((r) => r.id));
  res.json(rows.map((r) => ({ ...serializeSummary(r), latestUpdate: updates.get(r.id) ?? null })));
});

// Jumlah request yang menunggu tindakan saya (untuk badge)
purchaseRequestsRouter.get("/counts", async (req: AuthRequest, res) => {
  const principals = await getPrincipals(req.user!.id);
  const where = inboxWhere(principals);
  const inbox = where ? await prisma.purchaseRequest.count({ where }) : 0;
  res.json({ inbox });
});

// ===== Detail =====
purchaseRequestsRouter.get("/:id", async (req: AuthRequest, res) => {
  const pr = await prisma.purchaseRequest.findUnique({
    where: { id: req.params.id as string },
    include: detailInclude,
  });
  if (!pr) return res.status(404).json({ message: "Request tidak ditemukan" });

  const principals = await getPrincipals(req.user!.id);
  if (!canView(pr, req, principals)) {
    return res.status(403).json({ message: "Anda tidak punya akses ke request ini" });
  }

  const step = stepOfStatus(pr.status);
  const acting = step ? pickActingPrincipal(step, principals, pr) : null;
  const procurer =
    pr.status === PR_STATUS.IN_PROCUREMENT ? pickProcurementPrincipal(principals) : null;
  const totalFinal = pr.totalFinal === null ? null : Number(pr.totalFinal);

  res.json({
    id: pr.id,
    docNumber: pr.docNumber,
    createdAt: pr.createdAt,
    dueDate: pr.dueDate,
    requester: {
      id: pr.requesterId,
      name: pr.requesterName,
      position: pr.requesterPosition,
      department: pr.requesterDepartment,
      email: pr.requesterEmail,
      phone: pr.requesterPhone,
    },
    requirementType: pr.requirementType,
    requirementAction: pr.requirementAction,
    requirementScope: pr.requirementScope,
    purpose: pr.purpose,
    note: pr.note,
    attachmentPath: pr.attachmentPath,
    attachmentName: pr.attachmentName,
    totalEstimate: Number(pr.totalEstimate),
    totalFinal,
    overBudget: totalFinal !== null && totalFinal > Number(pr.totalEstimate),
    priceVarianceNote: pr.priceVarianceNote,
    estimatedArrival: pr.estimatedArrival,
    quotationPath: pr.quotationPath,
    quotationName: pr.quotationName,
    procuredAt: pr.procuredAt,
    status: pr.status,
    statusLabel: STATUS_LABEL[pr.status] ?? pr.status,
    supervisorApprover: pr.supervisorApprover,
    items: pr.items.map((it) => {
      const finalPrice = it.finalPrice === null ? null : Number(it.finalPrice);
      return {
        id: it.id,
        lineNo: it.lineNo,
        description: it.description,
        quantity: it.quantity,
        estimatedPrice: Number(it.estimatedPrice),
        subtotal: Number(it.estimatedPrice) * it.quantity,
        referenceLink: it.referenceLink,
        purchaseMethod: it.purchaseMethod,
        vendorName: it.vendorName,
        vendorContact: it.vendorContact,
        poNumber: it.poNumber,
        purchaseLink: it.purchaseLink,
        finalPrice,
        finalSubtotal: finalPrice === null ? null : finalPrice * it.quantity,
      };
    }),
    logs: pr.logs.map(serializeLog),
    flow: buildFlow(pr),
    permissions: {
      canAct: !!acting,
      step,
      onBehalfOf:
        acting?.viaDelegation ? { name: acting.name, position: acting.position } : null,
      canProcure: !!procurer,
      procureOnBehalfOf:
        procurer?.viaDelegation ? { name: procurer.name, position: procurer.position } : null,
    },
  });
});

// ===== Buat pengajuan =====
function parseItems(raw: unknown):
  | {
      ok: true;
      items: { description: string; quantity: number; estimatedPrice: number; referenceLink: string | null }[];
    }
  | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, message: "Format daftar barang tidak valid" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, message: "Minimal satu barang harus diisi" };
  }
  if (parsed.length > MAX_ITEMS) {
    return { ok: false, message: `Maksimal ${MAX_ITEMS} barang per pengajuan` };
  }
  const items = [];
  for (const [i, it] of parsed.entries()) {
    const n = i + 1;
    const description = cleanText(it?.description, 1000);
    const quantity = Number(it?.quantity);
    const estimatedPrice = Number(it?.estimatedPrice);
    if (!description) return { ok: false, message: `Deskripsi barang no. ${n} wajib diisi` };
    const referenceLink = cleanText(it?.referenceLink, 2000);
    if (referenceLink && !isHttpUrl(referenceLink)) {
      return { ok: false, message: `Link pembelian barang no. ${n} harus diawali http:// atau https://` };
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
      return { ok: false, message: `Jumlah barang no. ${n} harus bilangan bulat minimal 1` };
    }
    if (!Number.isFinite(estimatedPrice) || estimatedPrice < 0 || estimatedPrice > MAX_PRICE) {
      return { ok: false, message: `Estimasi harga barang no. ${n} tidak valid` };
    }
    items.push({
      description,
      quantity,
      estimatedPrice: Math.round(estimatedPrice * 100) / 100,
      referenceLink,
    });
  }
  return { ok: true, items };
}

purchaseRequestsRouter.post(
  "/",
  singleDocument("attachment", "dokumen pendukung"),
  async (req: AuthRequest, res) => {
    const user = req.user!;
    if (!user.employeeId) {
      return res.status(403).json({ message: "Akun ini tidak terhubung ke data karyawan" });
    }

    const b = req.body ?? {};
    if (!REQUIREMENT_TYPES.includes(b.requirementType)) {
      return res.status(400).json({ message: "Requirement type wajib dipilih" });
    }
    if (!REQUIREMENT_ACTIONS.includes(b.requirementAction)) {
      return res.status(400).json({ message: "Pilih New / Upgrade / Downgrade / Additional" });
    }
    if (!REQUIREMENT_SCOPES.includes(b.requirementScope)) {
      return res.status(400).json({ message: "Pilih Internal / External" });
    }
    const purpose = cleanText(b.purpose, 2000);
    if (!purpose) return res.status(400).json({ message: "Purpose / alasan pengadaan wajib diisi" });

    const dueDate = parseDateOnly(b.dueDate);
    if (!dueDate) return res.status(400).json({ message: "Due date wajib diisi" });
    if (b.dueDate < todayStr()) {
      return res.status(400).json({ message: "Due date tidak boleh sebelum hari ini" });
    }

    const parsedItems = parseItems(b.items);
    if (!parsedItems.ok) return res.status(400).json({ message: parsedItems.message });
    const { items } = parsedItems;
    const totalEstimate = items.reduce((s, it) => s + it.estimatedPrice * it.quantity, 0);

    const employee = await prisma.employee.findUnique({
      where: { id: user.employeeId },
      include: { department: { select: { name: true } } },
    });
    if (!employee) return res.status(400).json({ message: "Data karyawan tidak ditemukan" });

    // Approver atasan ditentukan sekarang. Tanpa atasan -> tahap atasan dilewati.
    const approver = await resolveApprover(employee.id);
    const { status, skipped } = initialStatus(approver ? [] : ["SUPERVISOR"]);

    try {
      const created = await prisma.$transaction(async (tx) => {
        const pr = await tx.purchaseRequest.create({
          data: {
            requesterId: employee.id,
            requesterName: employee.name,
            requesterPosition: employee.position,
            requesterDepartment: employee.department?.name ?? null,
            requesterEmail: user.email,
            requesterPhone: employee.phone,
            requirementType: b.requirementType,
            requirementAction: b.requirementAction,
            requirementScope: b.requirementScope,
            purpose,
            dueDate,
            note: cleanText(b.note, 2000),
            attachmentPath: req.file?.filename ?? null,
            attachmentName: req.file?.originalname?.slice(0, 190) ?? null,
            totalEstimate,
            status,
            supervisorApproverId: approver?.id ?? null,
            items: {
              create: items.map((it, i) => ({ ...it, lineNo: i + 1 })),
            },
          },
        });

        await tx.purchaseRequest.update({
          where: { id: pr.id },
          data: { docNumber: formatDocNumber(pr.seq) },
        });

        await tx.purchaseRequestLog.create({
          data: {
            requestId: pr.id,
            step: LOG_STEP.SUBMIT,
            action: LOG_ACTION.SUBMITTED,
            actorUserId: user.id,
            actorName: employee.name,
            actorPosition: employee.position,
          },
        });

        for (const step of skipped) {
          await tx.purchaseRequestLog.create({
            data: {
              requestId: pr.id,
              step,
              action: LOG_ACTION.SKIPPED,
              note: "Dilewati: pemohon tidak memiliki atasan",
            },
          });
        }

        return pr;
      });

      res.status(201).json({ id: created.id, docNumber: formatDocNumber(created.seq), status });
    } catch (e) {
      console.error("POST /purchase-requests error:", e);
      res.status(400).json({ message: "Gagal membuat pengajuan", error: String(e) });
    }
  }
);

// ===== Approve / Reject =====
async function decide(req: AuthRequest, res: express.Response, approve: boolean) {
  const id = req.params.id as string;
  const note = cleanText(req.body?.note, 1000);
  if (!approve && !note) {
    return res.status(400).json({ message: "Catatan alasan penolakan wajib diisi" });
  }

  const pr = await prisma.purchaseRequest.findUnique({
    where: { id },
    select: { id: true, status: true, supervisorApproverId: true },
  });
  if (!pr) return res.status(404).json({ message: "Request tidak ditemukan" });

  const step: ApprovalStep | null = stepOfStatus(pr.status);
  if (!step) {
    return res.status(400).json({ message: "Request ini tidak sedang menunggu approval" });
  }

  const principals = await getPrincipals(req.user!.id);
  const acting = pickActingPrincipal(step, principals, pr);
  if (!acting) {
    return res.status(403).json({ message: "Anda tidak berhak memproses tahap ini" });
  }
  const self = principals.find((p) => !p.viaDelegation)!;
  const newStatus = approve ? statusAfter(step) : PR_STATUS.REJECTED;

  try {
    await prisma.$transaction(async (tx) => {
      // Cegah dua orang memproses tahap yang sama bersamaan
      const updated = await tx.purchaseRequest.updateMany({
        where: { id, status: pr.status },
        data: { status: newStatus },
      });
      if (updated.count === 0) throw new Error("CONFLICT");

      await tx.purchaseRequestLog.create({
        data: {
          requestId: id,
          step,
          action: approve ? LOG_ACTION.APPROVED : LOG_ACTION.REJECTED,
          actorUserId: self.userId,
          actorName: self.name,
          actorPosition: self.position,
          onBehalfOfUserId: acting.viaDelegation ? acting.userId : null,
          onBehalfOfName: acting.viaDelegation ? acting.name : null,
          onBehalfOfPosition: acting.viaDelegation ? acting.position : null,
          note,
        },
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "CONFLICT") {
      return res.status(409).json({ message: "Request ini sudah diproses orang lain. Muat ulang halaman." });
    }
    console.error("decide purchase request error:", e);
    return res.status(400).json({ message: "Gagal memproses request", error: String(e) });
  }

  res.json({ id, status: newStatus, statusLabel: STATUS_LABEL[newStatus] ?? newStatus });
}

purchaseRequestsRouter.post("/:id/approve", (req: AuthRequest, res) => decide(req, res, true));
purchaseRequestsRouter.post("/:id/reject", (req: AuthRequest, res) => decide(req, res, false));

// ===== Procurement =====
// Hanya role procurement (atau penggantinya lewat delegasi), saat status IN_PROCUREMENT.

async function loadForProcurement(req: AuthRequest, res: express.Response) {
  const id = req.params.id as string;
  const pr = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: { items: { orderBy: { lineNo: "asc" } } },
  });
  if (!pr) {
    res.status(404).json({ message: "Request tidak ditemukan" });
    return null;
  }
  if (pr.status !== PR_STATUS.IN_PROCUREMENT) {
    res.status(400).json({ message: "Request ini tidak sedang di tahap procurement" });
    return null;
  }
  const principals = await getPrincipals(req.user!.id);
  const procurer = pickProcurementPrincipal(principals);
  if (!procurer) {
    res.status(403).json({ message: "Hanya tim Procurement yang bisa memproses tahap ini" });
    return null;
  }
  const self = principals.find((p) => !p.viaDelegation)!;
  return { pr, self, procurer };
}

function actorFields(self: Principal, acting: Principal) {
  return {
    actorUserId: self.userId,
    actorName: self.name,
    actorPosition: self.position,
    onBehalfOfUserId: acting.viaDelegation ? acting.userId : null,
    onBehalfOfName: acting.viaDelegation ? acting.name : null,
    onBehalfOfPosition: acting.viaDelegation ? acting.position : null,
  };
}

type ProcurementItemInput = {
  id: string;
  purchaseMethod: string | null;
  vendorName: string | null;
  vendorContact: string | null;
  poNumber: string | null;
  purchaseLink: string | null;
  finalPrice: number | null;
};

// Validasi data procurement. Draft boleh belum lengkap; submit wajib lengkap.
function parseProcurementItems(
  raw: unknown,
  existingIds: string[],
  strict: boolean
): { ok: true; items: ProcurementItemInput[] } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, message: "Format data barang tidak valid" };
  }
  if (!Array.isArray(parsed)) return { ok: false, message: "Format data barang tidak valid" };

  const byId = new Map(parsed.map((it: any) => [it?.id, it]));
  const items: ProcurementItemInput[] = [];
  for (const [i, id] of existingIds.entries()) {
    const n = i + 1;
    const it: any = byId.get(id) ?? {};
    const method = cleanText(it.purchaseMethod, 20);
    if (method && !PURCHASE_METHODS.includes(method)) {
      return { ok: false, message: `Metode pembelian barang no. ${n} tidak valid` };
    }
    const purchaseLink = cleanText(it.purchaseLink, 2000);
    if (purchaseLink && !isHttpUrl(purchaseLink)) {
      return { ok: false, message: `Link pembelian barang no. ${n} harus diawali http:// atau https://` };
    }
    const priceRaw = it.finalPrice;
    let finalPrice: number | null = null;
    if (priceRaw !== null && priceRaw !== undefined && priceRaw !== "") {
      finalPrice = Number(priceRaw);
      if (!Number.isFinite(finalPrice) || finalPrice < 0 || finalPrice > MAX_PRICE) {
        return { ok: false, message: `Harga final barang no. ${n} tidak valid` };
      }
      finalPrice = Math.round(finalPrice * 100) / 100;
    }
    const item: ProcurementItemInput = {
      id,
      purchaseMethod: method,
      vendorName: cleanText(it.vendorName, 190),
      vendorContact: cleanText(it.vendorContact, 190),
      poNumber: cleanText(it.poNumber, 100),
      purchaseLink,
      finalPrice,
    };

    if (strict) {
      if (!item.purchaseMethod) return { ok: false, message: `Pilih metode pembelian barang no. ${n} (Vendor / Link)` };
      if (item.purchaseMethod === "vendor" && !item.vendorName) {
        return { ok: false, message: `Nama vendor barang no. ${n} wajib diisi` };
      }
      if (item.purchaseMethod === "link" && !item.purchaseLink) {
        return { ok: false, message: `Link pembelian barang no. ${n} wajib diisi` };
      }
      if (item.finalPrice === null) return { ok: false, message: `Harga final barang no. ${n} wajib diisi` };
    }
    items.push(item);
  }
  return { ok: true, items };
}

// Simpan data procurement. submit=true -> selesai, lanjut ke Payment.
purchaseRequestsRouter.post(
  "/:id/procurement",
  singleDocument("quotation", "dokumen quotation"),
  async (req: AuthRequest, res) => {
    const ctx = await loadForProcurement(req, res);
    if (!ctx) return;
    const { pr, self, procurer } = ctx;
    const b = req.body ?? {};
    const submit = b.submit === "true" || b.submit === true;

    const parsed = parseProcurementItems(b.items, pr.items.map((it) => it.id), submit);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });

    let estimatedArrival: Date | null = null;
    if (b.estimatedArrival) {
      estimatedArrival = parseDateOnly(b.estimatedArrival);
      if (!estimatedArrival) return res.status(400).json({ message: "Perkiraan tanggal datang tidak valid" });
    }

    const qtyById = new Map(pr.items.map((it) => [it.id, it.quantity]));
    const allPriced = parsed.items.every((it) => it.finalPrice !== null);
    const totalFinal = allPriced
      ? parsed.items.reduce((s, it) => s + (it.finalPrice ?? 0) * (qtyById.get(it.id) ?? 0), 0)
      : null;
    const priceVarianceNote = cleanText(b.priceVarianceNote, 2000);
    const overBudget = totalFinal !== null && totalFinal > Number(pr.totalEstimate);

    if (submit && overBudget && !priceVarianceNote) {
      return res.status(400).json({
        message: "Total harga final melebihi estimasi. Isi catatan selisih harga untuk Finance.",
      });
    }

    const oldQuotation = req.file ? pr.quotationPath : null;

    try {
      await prisma.$transaction(async (tx) => {
        for (const it of parsed.items) {
          const { id, ...data } = it;
          await tx.purchaseRequestItem.update({ where: { id }, data });
        }

        const data: Prisma.PurchaseRequestUpdateManyMutationInput = {
          estimatedArrival,
          totalFinal,
          priceVarianceNote: overBudget ? priceVarianceNote : null,
          ...(req.file
            ? { quotationPath: req.file.filename, quotationName: req.file.originalname.slice(0, 190) }
            : {}),
          ...(submit ? { status: STATUS_AFTER_PROCUREMENT, procuredAt: new Date() } : {}),
        };
        // Cegah dua orang menyelesaikan tahap yang sama bersamaan
        const updated = await tx.purchaseRequest.updateMany({
          where: { id: pr.id, status: PR_STATUS.IN_PROCUREMENT },
          data,
        });
        if (updated.count === 0) throw new Error("CONFLICT");

        if (submit) {
          await tx.purchaseRequestLog.create({
            data: {
              requestId: pr.id,
              step: LOG_STEP.PROCUREMENT,
              action: LOG_ACTION.APPROVED,
              ...actorFields(self, procurer),
              note: overBudget ? `Melebihi estimasi: ${priceVarianceNote}` : null,
            },
          });
        }
      });
    } catch (e) {
      if (e instanceof Error && e.message === "CONFLICT") {
        return res.status(409).json({ message: "Request ini sudah diproses. Muat ulang halaman." });
      }
      console.error("procurement save error:", e);
      return res.status(400).json({ message: "Gagal menyimpan data procurement", error: String(e) });
    }

    // Quotation lama diganti -> hapus filenya
    if (oldQuotation) fs.unlink(path.join(uploadDir, oldQuotation), () => {});

    const status = submit ? STATUS_AFTER_PROCUREMENT : PR_STATUS.IN_PROCUREMENT;
    res.json({ id: pr.id, status, statusLabel: STATUS_LABEL[status], totalFinal, overBudget });
  }
);

// Kirim update progres ke pemohon (status tidak berubah)
purchaseRequestsRouter.post("/:id/procurement/note", async (req: AuthRequest, res) => {
  const ctx = await loadForProcurement(req, res);
  if (!ctx) return;
  const note = cleanText(req.body?.note, 1000);
  if (!note) return res.status(400).json({ message: "Isi pesan update dulu" });

  await prisma.purchaseRequestLog.create({
    data: {
      requestId: ctx.pr.id,
      step: LOG_STEP.PROCUREMENT,
      action: LOG_ACTION.NOTE,
      ...actorFields(ctx.self, ctx.procurer),
      note,
    },
  });
  res.status(201).json({ ok: true });
});

// Batalkan pengajuan di tahap procurement (mis. barang tidak tersedia). Catatan wajib.
purchaseRequestsRouter.post("/:id/procurement/cancel", async (req: AuthRequest, res) => {
  const ctx = await loadForProcurement(req, res);
  if (!ctx) return;
  const note = cleanText(req.body?.note, 1000);
  if (!note) return res.status(400).json({ message: "Catatan alasan pembatalan wajib diisi" });

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseRequest.updateMany({
        where: { id: ctx.pr.id, status: PR_STATUS.IN_PROCUREMENT },
        data: { status: PR_STATUS.REJECTED },
      });
      if (updated.count === 0) throw new Error("CONFLICT");
      await tx.purchaseRequestLog.create({
        data: {
          requestId: ctx.pr.id,
          step: LOG_STEP.PROCUREMENT,
          action: LOG_ACTION.REJECTED,
          ...actorFields(ctx.self, ctx.procurer),
          note,
        },
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "CONFLICT") {
      return res.status(409).json({ message: "Request ini sudah diproses. Muat ulang halaman." });
    }
    return res.status(400).json({ message: "Gagal membatalkan request", error: String(e) });
  }
  res.json({ id: ctx.pr.id, status: PR_STATUS.REJECTED, statusLabel: STATUS_LABEL[PR_STATUS.REJECTED] });
});
