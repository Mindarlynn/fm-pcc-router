import http from 'node:http';

export function requestJSON(socketPath, path, {
  body, signal, timeoutMs = 30_000, maxBytes = 65_536,
} = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath, path, method: bytes ? 'POST' : 'GET', signal,
      headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {},
    });
    const deadline = setTimeout(() => req.destroy(new Error('PCC request timed out.')), timeoutMs);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      error ? reject(error) : resolve(value);
    };
    req.on('error', (error) => finish(error));
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('error', (error) => finish(error));
      res.on('aborted', () => finish(new Error('PCC response connection was interrupted.')));
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error('PCC response exceeded the allowed size.');
          finish(error);
          res.destroy();
          req.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish(new Error(`PCC server returned HTTP error: ${res.statusCode}`));
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          finish(new Error('PCC server response is not valid JSON.'));
        }
      });
    });
    req.end(bytes);
  });
}
