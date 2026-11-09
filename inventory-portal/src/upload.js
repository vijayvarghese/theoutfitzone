import multer from 'multer';
import path from 'path';
import fs from 'fs';

const uploadDir = process.env.MEDIA_DIR || path.join(process.cwd(), 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate clean slug from original name or product name
    const ext = path.extname(file.originalname).toLowerCase();
    const baseRaw = path.basename(file.originalname, ext);
    const cleanBase = baseRaw
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 30) || 'product';
    const timestamp = Date.now();
    const uniqueSuffix = Math.floor(Math.random() * 1000);
    cb(null, `${cleanBase}-${timestamp}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp|svg\+xml|svg|avif/;
  const mimeMatch = allowedTypes.test(file.mimetype);
  const extMatch = allowedTypes.test(path.extname(file.originalname).toLowerCase());

  if (mimeMatch || extMatch) {
    return cb(null, true);
  }
  cb(new Error('Only image files (JPG, PNG, WebP, SVG, AVIF) are permitted.'));
};

export const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter
});

export { uploadDir };
