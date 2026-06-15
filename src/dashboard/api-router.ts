import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyBearerToken } from './api-auth.js';

// Type alias to avoid importing AppContext directly at the module level.
type AppContextRef = import('../types/app-config.js').AppContext;

/** Parsed representation of an incoming API request, ready for handler consumption. */
export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

/** Handler context bundling the parsed request and the raw response object. */
export interface ApiContext {
  req: ApiRequest;
  res: ServerResponse;
}

/** Signature for all registered API route handlers. */
export type ApiHandler = (ctx: ApiContext, app: AppContextRef) => Promise<void>;

interface RegisteredRoute {
  method: string;
  /** Original pattern string, e.g. /routines/:name/history */
  pattern: string;
  /** Pattern split into segments, excluding leading empty string. */
  segments: string[];
  handler: ApiHandler;
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Lightweight route registry and dispatcher for the /api/* namespace.
 *
 * Usage:
 *   const router = new ApiRouter();
 *   router.register('GET', '/status', statusHandler);
 *   router.register('GET', '/routines/:name/history', historyHandler);
 *   const handled = await router.handle(req, res, appCtx);
 */
export class ApiRouter {
  private routes: RegisteredRoute[] = [];

  /**
   * Register a route handler for a given HTTP method and path pattern.
   * Patterns may include :param segments (e.g. /routines/:name/history).
   * Registration order determines matching priority.
   */
  register(method: string, pattern: string, handler: ApiHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
  }

  /**
   * Match a request method and pathname against registered routes.
   * Strips the /api prefix from pathname before comparing against patterns.
   * Returns the matched route and extracted path params, or null on no match.
   */
  private match(
    method: string,
    pathname: string
  ): { route: RegisteredRoute; params: Record<string, string> } | null {
    // Strip /api prefix so patterns are registered without it.
    const reqSegments = pathname.replace(/^\/api/, '').split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== reqSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          // Dynamic segment — capture value as named param.
          params[seg.slice(1)] = decodeURIComponent(reqSegments[i]);
        } else if (seg !== reqSegments[i]) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }
    return null;
  }

  /**
   * Attempt to handle an incoming request.
   *
   * Returns false immediately for paths that do not start with /api/ so the
   * caller can delegate to other handlers (MCP transport, static serving, etc.).
   *
   * For /api/* paths:
   *   - Returns 401 if the Bearer token is missing or does not match.
   *   - Returns 404 if no registered route matches method + path.
   *   - Parses JSON body for POST/PUT requests (max 1 MB).
   *   - Returns 400 on body parse failure.
   *   - Returns 500 on unhandled handler errors.
   *   - Returns true in all /api/* cases (request is consumed).
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    app: AppContextRef
  ): Promise<boolean> {
    const url = new URL(
      request.url ?? '',
      `http://${request.headers.host ?? 'localhost'}`
    );

    // Delegate non-API paths to the caller.
    if (!url.pathname.startsWith('/api/')) return false;

    // Authenticate via Bearer token — fail-closed when no token is configured.
    if (!verifyBearerToken(request, app.config.server.authToken)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.setHeader('www-authenticate', 'Bearer');
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    const matchResult = this.match(method, url.pathname);

    if (!matchResult) {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Not Found' }));
      return true;
    }

    // Parse request body for mutating methods.
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT') {
      try {
        body = await readJsonBody(request);
      } catch (err) {
        sendJson(response, 400, {
          error: err instanceof Error ? err.message : 'Bad request body',
        });
        return true;
      }
    }

    const ctx: ApiContext = {
      req: {
        method,
        path: url.pathname,
        params: matchResult.params,
        query: url.searchParams,
        body,
      },
      res: response,
    };

    try {
      await matchResult.route.handler(ctx, app);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.logger.error('Dashboard API handler error', { path: url.pathname, message });
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'Internal server error' });
      }
    }

    return true;
  }
}

/**
 * Read and parse a JSON request body, enforcing a 1 MB size cap.
 * Resolves with undefined for empty bodies.
 * Rejects with a descriptive Error on size overflow, invalid JSON, or stream errors.
 */
function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error('Request body too large (max 1 MB)'));
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    request.on('error', reject);
  });
}

/**
 * Write a JSON response with the given status code.
 * Sets Content-Type: application/json and calls end().
 */
export function sendJson(
  response: ServerResponse,
  statusCode: number,
  data: unknown
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(data));
}
