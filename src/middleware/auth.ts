import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { Role } from "../roles";

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; employeeId?: string | null };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token tidak ditemukan" });
  }

  const token = authHeader.split(" ")[1];

  let decoded: { id?: string };
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id?: string };
  } catch {
    return res.status(401).json({ message: "Token tidak valid atau kadaluarsa" });
  }

  // Ambil data user terbaru dari database, supaya perubahan role / akun yang
  // dihapus langsung berlaku tanpa menunggu token kadaluarsa.
  const user = decoded.id
    ? await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, email: true, role: true, employeeId: true },
      })
    : null;

  if (!user) {
    return res.status(401).json({ message: "Akun tidak ditemukan" });
  }

  req.user = user;
  next();
}

// Batasi endpoint hanya untuk role tertentu. Dipasang setelah authMiddleware.
// Generic <P> supaya tipe req.params di handler berikutnya tetap disimpulkan dari path route.
export function requireRole(...roles: Role[]) {
  return <P>(req: Request<P>, res: Response, next: NextFunction) => {
    const user = (req as unknown as AuthRequest).user;
    if (!user || !(roles as string[]).includes(user.role)) {
      return res.status(403).json({ message: "Anda tidak punya akses ke fitur ini" });
    }
    next();
  };
}
