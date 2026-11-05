import express from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { AuthRequest } from "../middleware/auth";
import { ROLES } from "../roles";
import { singleDocument } from "../upload";
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
  stepOfStatus,
  statusAfter,
  initialStatus,
  formatDocNumber,
} from "../purchase/flow";
import {
  Principal,
  getPrincipals,
  pickActingPrincipal,
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
  status: true,
  _count: { select: { items: true } },
} satisfies Prisma.PurchaseRequestSelect;

type SummaryRow = Prisma.PurchaseRequestGetPayload<{ select: typeof summarySelect }>;

function serializeSummary(pr: SummaryRow) {
  const { _count, totalEstimate, ...rest } = pr;
  return {
    ...rest,
    totalEstimate: Number(totalEstimate),
    itemCount: _count.items,
    statusLabel: STATUS_LABEL[pr.status] ?? pr.status,
  };
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
  };

  return FULL_FLOW.map((f, idx) => {
    const log = [...pr.logs].reverse().find((l) => l.step === f.key);
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
  return or.length ? { OR: or } : null;
}

const cleanText = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

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
            action: { not: LOG_ACTION.SKIPPED },
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
            action: { not: LOG_ACTION.SKIPPED },
            OR: [{ actorUserId: user.id }, { onBehalfOfUserId: user.id }],
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    const result = rows
      .map(({ logs, ...pr }) => ({
        ...serializeSummary(pr),
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
  res.json(rows.map(serializeSummary));
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
    status: pr.status,
    statusLabel: STATUS_LABEL[pr.status] ?? pr.status,
    supervisorApprover: pr.supervisorApprover,
    items: pr.items.map((it) => ({
      id: it.id,
      lineNo: it.lineNo,
      description: it.description,
      quantity: it.quantity,
      estimatedPrice: Number(it.estimatedPrice),
      subtotal: Number(it.estimatedPrice) * it.quantity,
    })),
    logs: pr.logs.map(serializeLog),
    flow: buildFlow(pr),
    permissions: {
      canAct: !!acting,
      step,
      onBehalfOf:
        acting?.viaDelegation ? { name: acting.name, position: acting.position } : null,
    },
  });
});

// ===== Buat pengajuan =====
function parseItems(raw: unknown):
  | { ok: true; items: { description: string; quantity: number; estimatedPrice: number }[] }
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
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
      return { ok: false, message: `Jumlah barang no. ${n} harus bilangan bulat minimal 1` };
    }
    if (!Number.isFinite(estimatedPrice) || estimatedPrice < 0 || estimatedPrice > MAX_PRICE) {
      return { ok: false, message: `Estimasi harga barang no. ${n} tidak valid` };
    }
    items.push({ description, quantity, estimatedPrice: Math.round(estimatedPrice * 100) / 100 });
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
