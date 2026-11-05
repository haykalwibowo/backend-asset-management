// Alur request pengadaan aset.
//
// Urutan approval mengikuti SOP kantor: Atasan -> GA -> Finance.
// Kalau SOP berubah, cukup ubah urutan APPROVAL_STEPS (dan FULL_FLOW untuk tampilan).

export const PR_STATUS = {
  PENDING_SUPERVISOR: "PENDING_SUPERVISOR",
  PENDING_GA: "PENDING_GA",
  PENDING_FINANCE: "PENDING_FINANCE",
  IN_PROCUREMENT: "IN_PROCUREMENT",
  REJECTED: "REJECTED",
} as const;

export type ApprovalStep = "SUPERVISOR" | "GA" | "FINANCE";

export const APPROVAL_STEPS: ApprovalStep[] = ["SUPERVISOR", "GA", "FINANCE"];

const STEP_STATUS: Record<ApprovalStep, string> = {
  SUPERVISOR: PR_STATUS.PENDING_SUPERVISOR,
  GA: PR_STATUS.PENDING_GA,
  FINANCE: PR_STATUS.PENDING_FINANCE,
};

// Status setelah semua approval selesai
export const STATUS_AFTER_APPROVAL = PR_STATUS.IN_PROCUREMENT;

export const LOG_STEP = {
  SUBMIT: "SUBMIT",
  ...Object.fromEntries(APPROVAL_STEPS.map((s) => [s, s])),
} as Record<"SUBMIT" | ApprovalStep, string>;

export const LOG_ACTION = {
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  SKIPPED: "SKIPPED",
} as const;

export function stepOfStatus(status: string): ApprovalStep | null {
  return APPROVAL_STEPS.find((s) => STEP_STATUS[s] === status) ?? null;
}

export function statusOfStep(step: ApprovalStep): string {
  return STEP_STATUS[step];
}

// Status berikutnya setelah `step` di-approve
export function statusAfter(step: ApprovalStep): string {
  const idx = APPROVAL_STEPS.indexOf(step);
  const next = APPROVAL_STEPS[idx + 1];
  return next ? STEP_STATUS[next] : STATUS_AFTER_APPROVAL;
}

// Seluruh tahapan untuk tampilan progress/timeline (termasuk tahap fase berikutnya)
export const FULL_FLOW: { key: string; label: string; status?: string }[] = [
  { key: "SUBMIT", label: "Pengajuan" },
  ...APPROVAL_STEPS.map((s) => ({
    key: s,
    label: { SUPERVISOR: "Approval Atasan", GA: "Acknowledge GA", FINANCE: "Verifikasi Finance" }[s],
    status: STEP_STATUS[s],
  })),
  { key: "PROCUREMENT", label: "Procurement (pilih vendor)", status: PR_STATUS.IN_PROCUREMENT },
  { key: "PAYMENT", label: "Payment" },
  { key: "GA_VERIFY", label: "Verifikasi Barang (GA)" },
  { key: "RECORDING", label: "Pencatatan Aset" },
];

export const STATUS_LABEL: Record<string, string> = {
  PENDING_SUPERVISOR: "Menunggu Approval Atasan",
  PENDING_GA: "Menunggu Acknowledge GA",
  PENDING_FINANCE: "Menunggu Verifikasi Finance",
  IN_PROCUREMENT: "Proses Procurement",
  REJECTED: "Ditolak",
};

// Status awal saat pengajuan dibuat. Tahap di `skip` dilewati (mis. tidak ada atasan).
export function initialStatus(skip: ApprovalStep[]): { status: string; skipped: ApprovalStep[] } {
  const skipped: ApprovalStep[] = [];
  for (const step of APPROVAL_STEPS) {
    if (skip.includes(step)) {
      skipped.push(step);
      continue;
    }
    return { status: STEP_STATUS[step], skipped };
  }
  return { status: STATUS_AFTER_APPROVAL, skipped };
}

export const REQUIREMENT_TYPES = ["product", "service", "troubleshooting", "ticket", "material", "other"];
export const REQUIREMENT_ACTIONS = ["new", "upgrade", "downgrade", "additional"];
export const REQUIREMENT_SCOPES = ["internal", "external"];

// Format nomor dokumen sementara. Format resmi (mis. UMS/0013/IX/2026) menyusul.
export const formatDocNumber = (seq: number) => `PR-${String(seq).padStart(4, "0")}`;
