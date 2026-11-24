interface R2ObjectBody {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ASSETS_BUCKET?: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
