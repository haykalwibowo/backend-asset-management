import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";

export const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Hanya PDF/JPG/PNG. Ekstensi file yang disimpan diambil dari daftar ini,
// bukan dari nama file asli, supaya file .html dll. tidak bisa ikut tersaji.
const ALLOWED_UPLOADS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};
const ALLOWED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + ALLOWED_UPLOADS[file.mimetype]);
  },
});

function makeDocumentUpload(label: string) {
  return multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_UPLOADS[file.mimetype] && ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
      else cb(new Error(`Format ${label} harus PDF, JPG, atau PNG`));
    },
  });
}

// Upload nota/invoice aset: hanya PDF/JPG/PNG, maks 5 MB
export const invoiceUpload = makeDocumentUpload("nota");

// Middleware upload 1 file dokumen (opsional, cek wajib/tidaknya di handler):
// - error format/ukuran dikembalikan sebagai 400 dengan pesan yang jelas
// - kalau request akhirnya gagal (status >= 400), file yang sudah tersimpan dihapus
export function singleDocument(field: string, label: string) {
  const uploader = makeDocumentUpload(label).single(field);
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    uploader(req, res, (err: unknown) => {
      if (err) {
        const msg =
          (err as any)?.code === "LIMIT_FILE_SIZE"
            ? `Ukuran ${label} maksimal 5 MB`
            : err instanceof Error
            ? err.message
            : String(err);
        return res.status(400).json({ message: msg });
      }
      res.on("finish", () => {
        if (res.statusCode >= 400 && req.file) fs.unlink(req.file.path, () => {});
      });
      next();
    });
  };
}
