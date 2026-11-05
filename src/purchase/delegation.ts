import { prisma } from "../prisma";
import { ROLES } from "../roles";
import { ApprovalStep } from "./flow";

// Zona waktu kantor, untuk menentukan "hari ini" pada periode delegasi.
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Jakarta";

// Tanggal hari ini (YYYY-MM-DD) di zona waktu kantor
export function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(new Date());
}

// "YYYY-MM-DD" -> Date (UTC tengah malam), sama dengan cara kolom @db.Date disimpan
export function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00.000Z");
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

// Orang yang "diwakili" oleh user yang login: dirinya sendiri, ditambah semua
// user yang sedang mendelegasikan approval kepadanya (delegasi aktif hari ini).
// Delegasi tidak berantai: kalau A -> B dan B -> C, C hanya mewakili B.
export interface Principal {
  userId: string;
  name: string;
  position: string | null;
  role: string;
  employeeId: string | null;
  viaDelegation: boolean;
}

const principalSelect = {
  id: true,
  name: true,
  role: true,
  employeeId: true,
  employee: { select: { position: true } },
} as const;

export async function getPrincipals(userId: string): Promise<Principal[]> {
  const today = parseDateOnly(todayStr())!;
  const [self, delegations] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: principalSelect }),
    prisma.approvalDelegation.findMany({
      where: {
        delegateId: userId,
        cancelledAt: null,
        startDate: { lte: today },
        endDate: { gte: today },
      },
      select: { delegator: { select: principalSelect } },
    }),
  ]);

  const toPrincipal = (u: NonNullable<typeof self>, viaDelegation: boolean): Principal => ({
    userId: u.id,
    name: u.name,
    position: u.employee?.position ?? null,
    role: u.role,
    employeeId: u.employeeId,
    viaDelegation,
  });

  const result: Principal[] = self ? [toPrincipal(self, false)] : [];
  for (const d of delegations) {
    if (!result.some((p) => p.userId === d.delegator.id)) {
      result.push(toPrincipal(d.delegator, true));
    }
  }
  return result;
}

// Apakah principal berhak memproses tahap ini
export function principalCanAct(
  step: ApprovalStep,
  principal: Principal,
  request: { supervisorApproverId: string | null }
): boolean {
  switch (step) {
    case "SUPERVISOR":
      return !!principal.employeeId && principal.employeeId === request.supervisorApproverId;
    case "GA":
      return principal.role === ROLES.GA;
    case "FINANCE":
      return principal.role === ROLES.FINANCE;
  }
}

// Pilih atas nama siapa user bertindak. Diri sendiri diutamakan, baru delegasi.
export function pickActingPrincipal(
  step: ApprovalStep,
  principals: Principal[],
  request: { supervisorApproverId: string | null }
): Principal | null {
  return principals.find((p) => principalCanAct(step, p, request)) ?? null;
}
