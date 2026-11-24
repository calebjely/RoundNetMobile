interface R2ObjectBody {
  body: ReadableStream;
  httpEtag: string;
  text(): Promise<string>;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ASSETS_BUCKET?: R2Bucket;
}

const CONFIG_KEY = 'config/court-config.json';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Direct persistence for calibrated camera angles, net placement, and physics speed
    if (url.pathname === '/api/config' && env.ASSETS_BUCKET) {
      if (request.method === 'GET') {
        const obj = await env.ASSETS_BUCKET.get(CONFIG_KEY);
        if (!obj) {
          return new Response('null', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          });
        }
        return new Response(await obj.text(), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        });
      }

      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.text();
        // Validate JSON before saving
        JSON.parse(body);
        await env.ASSETS_BUCKET.put(CONFIG_KEY, body, {
          httpMetadata: { contentType: 'application/json' },
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    // Serve large (>25 MiB) splat/collision assets from R2 if bound
    if (url.pathname.startsWith('/assets/maps/') && env.ASSETS_BUCKET) {
      const key = url.pathname.replace(/^\/+/, '');
      const obj = await env.ASSETS_BUCKET.get(key);
      if (obj) {
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        headers.set('cache-control', 'public, max-age=86400');
        headers.set('access-control-allow-origin', '*');
        return new Response(obj.body, { headers });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
