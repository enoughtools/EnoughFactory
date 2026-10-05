interface Assets { fetch(request: Request): Promise<Response> }

export default {
  async fetch(request: Request, env: { ASSETS: Assets }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/downloads/') && /\.\.|%2e/i.test(url.pathname)) return new Response('Not found', { status: 404 });
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const app = url.pathname === '/app' || url.pathname.startsWith('/app/');
    const connections = app ? "'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*" : "'self'";
    const frames = app ? "https: http://127.0.0.1:* http://localhost:*" : "'none'";
    headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connections}; frame-src ${frames}; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`);
    if (url.pathname === '/downloads/manifest.json') headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
