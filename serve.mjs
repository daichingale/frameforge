import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const port = Number(process.env.PORT ?? 4173);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (request, response) => {
  const path = request.url?.split('?')[0];
  const entry = path === '/' ? '/index.html' : path;
  const extension = entry?.match(/\.[a-z]+$/)?.[0];
  if (entry !== '/index.html' && !/^\/src\/[a-z-]+\.(?:mjs|css)$/.test(entry ?? '')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL('.' + entry, import.meta.url));
    response.writeHead(200, {'Content-Type': contentTypes[extension], 'Cache-Control': 'no-store'}).end(content);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`FrameForge http://127.0.0.1:${port}`);
});
