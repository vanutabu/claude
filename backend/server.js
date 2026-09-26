// backend/server.js
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const adminRoutes = require("./routes/admin");
const submissionRoutes = require("./routes/submissions");
const { initDatabase } = require("./config/database");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

app.set("trust proxy", true);

app.use(helmet({ contentSecurityPolicy: false }));

/*
 * These parsers do not consume multipart/form-data, so Multer remains
 * responsible for the submission upload route.
 */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const ROOT_DIR = path.join(__dirname, "..");
const ADMIN_DIR = path.join(__dirname, "public", "admin");

// Never expose server source, environment files, package manifests, or Git data
// through the public static-file handler.
app.use((req, res, next) => {
  const pathname = req.path || "/";
  if (/^\/(?:backend|node_modules|\.git)(?:\/|$)/i.test(pathname) ||
      /^\/(?:package(?:-lock)?\.json|\.env(?:\.|$))/i.test(pathname) ||
      /^\/admin\/(?:package(?:-lock)?\.json|vite\.config\.js)/i.test(pathname)) {
    return res.status(404).end();
  }
  next();
});

// Serve Brotli/GZIP variants when they exist. This keeps the public HTML/CSS/JS
// payloads small without adding a runtime compression dependency.
function servePrecompressed(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const pathname = req.path || "/";
  const allowed = /\.(?:html|css|js|json|xml|txt|svg|webmanifest)$/i.test(pathname);
  if (!allowed) return next();
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT_DIR, "." + relative);
  if (!filePath.startsWith(ROOT_DIR + path.sep) || !fs.existsSync(filePath)) return next();
  const accept = String(req.headers["accept-encoding"] || "").toLowerCase();
  let compressed = null;
  let encoding = null;
  if (accept.includes("br") && fs.existsSync(filePath + ".br")) {
    compressed = filePath + ".br"; encoding = "br";
  } else if (accept.includes("gzip") && fs.existsSync(filePath + ".gz")) {
    compressed = filePath + ".gz"; encoding = "gzip";
  }
  if (!compressed) return next();
  res.setHeader("Content-Encoding", encoding);
  res.setHeader("Vary", "Accept-Encoding");
  if (/\.(?:css|js|html)$/i.test(filePath)) res.setHeader("Content-Type", ({'.css':'text/css; charset=UTF-8','.js':'application/javascript; charset=UTF-8','.html':'text/html; charset=UTF-8'}[path.extname(filePath).toLowerCase()] || "application/octet-stream"));
  // The precompressed branch bypasses express.static's setHeaders callback below,
  // so it must set its own Cache-Control/Expires or every css/js/html response
  // (i.e. almost every real browser request) goes out with no caching headers at all.
  if (/\.html$/i.test(filePath)) {
    res.setHeader("Cache-Control", "public, max-age=600, must-revalidate");
    res.setHeader("Expires", new Date(Date.now() + 600000).toUTCString());
  } else if (/\.(?:css|js)$/i.test(filePath)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Expires", new Date(Date.now() + 31536000000).toUTCString());
  } else {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Expires", new Date(Date.now() + 86400000).toUTCString());
  }
  return res.sendFile(compressed);
}

app.use(servePrecompressed);

app.use(express.static(ROOT_DIR, {
  setHeaders: (res, filePath) => {
    if (/\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Expires", new Date(Date.now() + 31536000000).toUTCString());
    } else if (/\.(?:css|js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Expires", new Date(Date.now() + 31536000000).toUTCString());
    }
  }
}));
app.use("/admin", (req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
}, express.static(ADMIN_DIR));

app.get("/api/health", async (req, res) => {
  res.json({
    success: true,
    status: "ok",
    service: "assignment-help",
    time: new Date().toISOString()
  });
});

app.use("/api/admin", adminRoutes);
app.use("/api/submissions", submissionRoutes);

/*
 * If the client disconnects while a multipart upload is in progress,
 * record it clearly. This is different from a database failure.
 */
app.use((req, res, next) => {
  req.on("aborted", () => {
    console.warn("[HTTP REQUEST ABORTED]", req.method, req.originalUrl);
  });
  next();
});

/*
 * API 404s should return JSON instead of an HTML page.
 */
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

/*
 * Frontend fallback.
 */
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

/*
 * Final error handler.
 */
app.use((err, req, res, next) => {
  console.error("🔴 Server Error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error"
  });
});

async function start() {
  try {
    await initDatabase();
    console.log("✅ Database initialized");
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
    process.exit(1);
  }

  app.listen(PORT, HOST, () => {
    const host = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;

    console.log(`Running on: ${host}`);
    console.log(`Admin: ${host}/admin/`);
    console.log(`Health: ${host}/api/health`);
  });
}

start();
