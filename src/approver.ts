import { prisma } from "./prisma";

export type ApproverSource = "supervisor" | "department_head";

export interface ApproverInfo {
  id: string;
  name: string;
  source: ApproverSource;
}

type EmployeeWithLinks = {
  id: string;
  supervisor: { id: string; name: string } | null;
  department: { head: { id: string; name: string } | null } | null;
};

// Aturan approver pertama (atasan) untuk request pengadaan:
// 1. atasan langsung (supervisorId), kalau ada
// 2. kalau tidak ada, kepala departemen, asalkan bukan dirinya sendiri
// 3. kalau dua-duanya tidak ada -> null (ditangani di flow pengadaan)
export function pickApprover(emp: EmployeeWithLinks): ApproverInfo | null {
  if (emp.supervisor) {
    return { ...emp.supervisor, source: "supervisor" };
  }
  const head = emp.department?.head;
  if (head && head.id !== emp.id) {
    return { ...head, source: "department_head" };
  }
  return null;
}

export async function resolveApprover(employeeId: string): Promise<ApproverInfo | null> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      supervisor: { select: { id: true, name: true } },
      department: { select: { head: { select: { id: true, name: true } } } },
    },
  });
  return emp ? pickApprover(emp) : null;
}

// Cek apakah menjadikan `supervisorId` sebagai atasan `employeeId` akan membuat
// rantai atasan yang melingkar (mis. A atasan B, B atasan A).
export async function createsSupervisorCycle(
  employeeId: string,
  supervisorId: string
): Promise<boolean> {
  let current: string | null = supervisorId;
  const seen = new Set<string>();
  while (current) {
    if (current === employeeId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const next: { supervisorId: string | null } | null = await prisma.employee.findUnique({
      where: { id: current },
      select: { supervisorId: true },
    });
    current = next?.supervisorId ?? null;
  }
  return false;
}
