// Daftar role aplikasi.
// "admin" ditampilkan sebagai "Super Admin" di FE (nilai di database tetap "admin").
export const ROLES = {
  ADMIN: "admin",
  STAFF: "staff",
  FINANCE: "finance",
  GA: "ga",
  PROCUREMENT: "procurement",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: Role[] = Object.values(ROLES);

// Role yang dimiliki karyawan biasa (punya data Employee, bisa pinjam aset & ajukan request).
// Atasan bukan role: atasan = karyawan yang tercatat sebagai supervisor / kepala departemen.
export const EMPLOYEE_ROLES: Role[] = [
  ROLES.STAFF,
  ROLES.FINANCE,
  ROLES.GA,
  ROLES.PROCUREMENT,
];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ALL_ROLES as string[]).includes(value);
}
