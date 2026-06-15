import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';

/** Map of file extensions to MIME content-type strings. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * Returns true if the file path looks like a hashed asset (e.g. main.a1b2c3d4.js).
 * Vite and most bundlers embed a content hash of 8+ hex chars before the extension.
 */
function isHashedAsset(pathname: string): boolean {
  return /\.[0-9a-f]{8,}\.[a-z0-9]+$/i.test(pathname);
}

/**
 * Sanitize a URL pathname so it cannot escape rootDir.
 *
 * - Decodes percent-encoding
 * - Normalizes slashes and removes redundant segments
 * - Does NOT strip `..` segments; the caller must verify the resolved absolute
 *   path stays within rootDir (see startsWith guard in serveDashboardStatic)
 * - Returns a relative path to join onto rootDir
 */
function sanitizePath(pathname: string): string {
  // Decode percent-encoded characters before normalization.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }

  // normalize() resolves .., //, etc. on the decoded path.
  const normalized = normalize(decoded);

  // Strip any leading slash so the path is relative.
  return normalized.replace(/^[/\\]+/, '');
}

/**
 * Factory that creates a static file handler bound to rootDir.
 *
 * The returned handler serves files from rootDir with appropriate MIME types
 * and cache headers, and applies SPA fallback routing for extension-free paths.
 *
 * @param rootDir - Absolute path to the directory containing built static assets.
 * @returns An async function that attempts to serve the requested pathname.
 */
export function createStaticHandler(
  rootDir: string
): (pathname: string, response: ServerResponse) => Promise<boolean> {
  const absRoot = resolve(rootDir);

  /**
   * Attempt to serve a static file for the given URL pathname.
   *
   * @param pathname - URL pathname (e.g. "/index.html", "/assets/main.js", "/about").
   * @param response - Node.js ServerResponse to write the file into.
   * @returns true if a response was sent; false if the caller should return 404.
   */
  async function serveDashboardStatic(
    pathname: string,
    response: ServerResponse
  ): Promise<boolean> {
    const relative = sanitizePath(pathname === '/' ? 'index.html' : pathname);

    // Build absolute path and verify it stays within rootDir (no traversal).
    const absPath = resolve(join(absRoot, relative));
    if (!absPath.startsWith(absRoot + '/') && absPath !== absRoot) {
      // Path escaped the root — treat as not found without revealing details.
      return false;
    }

    const ext = extname(absPath).toLowerCase();

    // Attempt to serve the exact file first.
    if (existsSync(absPath) && statSync(absPath).isFile()) {
      await sendFile(absPath, ext, response);
      return true;
    }

    // If the requested path carries a file extension, do NOT fall back to
    // index.html — a missing asset (.js, .css, .woff2, …) should 404.
    if (ext !== '') {
      return false;
    }

    // Extension-free path: apply SPA fallback and serve index.html.
    const indexPath = join(absRoot, 'index.html');
    if (existsSync(indexPath) && statSync(indexPath).isFile()) {
      await sendFile(indexPath, '.html', response);
      return true;
    }

    return false;
  }

  return serveDashboardStatic;
}

/**
 * Stream a file from disk to the response with correct headers.
 *
 * Cache policy:
 *   - HTML files: no-cache (browser revalidates on every navigation)
 *   - Hashed assets (e.g. main.a1b2c3d4.js): immutable, 1-year max-age
 *   - Other assets: no-cache (safe default for non-hashed filenames)
 */
async function sendFile(
  absPath: string,
  ext: string,
  response: ServerResponse
): Promise<void> {
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  let cacheControl: string;
  if (ext === '.html') {
    cacheControl = 'no-cache';
  } else if (isHashedAsset(absPath)) {
    cacheControl = 'public, max-age=31536000, immutable';
  } else {
    cacheControl = 'no-cache';
  }

  const stats = statSync(absPath);

  response.setHeader('content-type', contentType);
  response.setHeader('cache-control', cacheControl);
  response.setHeader('content-length', stats.size);
  response.statusCode = 200;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(response, { end: true });
  });
}
