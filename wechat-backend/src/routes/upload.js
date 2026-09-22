const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cfg = require('../config');

const router = express.Router();

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/amr': '.amr',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/webm': '.weba',
  'application/pdf': '.pdf', 'text/plain': '.txt',
};

fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, cfg.UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname || '').slice(0, 8) || '.bin';
      cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    },
  }),
  limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 },
});

/** 上传图片/语音/视频/文件，返回可访问 URL */
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: '上传失败：文件过大或类型不支持（≤' + cfg.MAX_UPLOAD_MB + 'MB）' });
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });
    res.json({
      url: '/uploads/' + req.file.filename,
      name: req.file.originalname || req.file.filename,
      size: req.file.size,
      mime: req.file.mimetype,
    });
  });
});

module.exports = router;
