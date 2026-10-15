/**
 * Tiny static file server.
 *
 * Serves whatever folder this file lives in at http://localhost:3000
 *
 * To run:  node serve.js
 * To stop: Ctrl+C in the terminal, or just close the window.
 *
 * No dependencies. No install. Just Node.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
};

const server = http.createServer((req, res) => {
  // Strip query string, decode URL
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Default to index.html
  if (urlPath === '/') urlPath = '/index.html';

  // Prevent directory traversal
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + urlPath);
      console.log(`  404  ${urlPath}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });

    fs.createReadStream(filePath).pipe(res);
    console.log(`  200  ${urlPath}`);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ROSCA dev server');
  console.log(`  Serving: ${ROOT}`);
  console.log(`  Open:    http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Something else is running on port ${PORT}.\n`);
  } else {
    console.error('\n  Server error:', err.message, '\n');
  }
  process.exit(1);
});