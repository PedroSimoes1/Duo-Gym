import type { Bootstrap, CommandEnvelope } from '../../shared/contracts.ts';

export interface Gateway {
  bootstrap(): Promise<Bootstrap>;
  execute(envelope: CommandEnvelope): Promise<Bootstrap>;
  exportOwn(): Promise<object>;
  upload(file: File, purpose?: 'meals' | 'body'): Promise<{ mediaId: string }>;
  logout(): Promise<void>;
  sendLoginCode?(email: string): Promise<void>;
  verifyLoginCode?(email: string, code: string): Promise<void>;
}

export class GatewayError extends Error {
  code: string;
  status: number;
  retryable: boolean;

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Same-origin, cookie-authenticated boundary. It never falls back to preview data. */
export class HttpGateway implements Gateway {
  private csrfToken: string | null = null;
  private readonly uploadRequests = new WeakMap<File, string>();
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis), baseUrl = '/api/v1') {
    if (!baseUrl.startsWith('/') || baseUrl.startsWith('//')) {
      throw new Error('The API must use a same-origin relative path.');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetcher = fetcher;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        credentials: 'include',
        mode: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...init.headers },
      });
    } catch {
      throw new GatewayError(
        'NETWORK_ERROR',
        'Could not reach the server. Your entry has not been confirmed. Retry with the same request.',
        0,
        true,
      );
    }
    const csrf = response.headers.get('X-CSRF-Token');
    if (csrf) this.csrfToken = csrf;
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const fallback =
        response.status === 401
          ? 'Sign in to your invited account to continue.'
          : response.status === 403
            ? 'This account does not have permission to access this competition.'
            : response.status === 409 || response.status === 412
              ? 'This record changed. Refresh before trying again.'
              : 'The server could not complete this request.';
      throw new GatewayError(
        body?.error?.code ??
          (response.status === 401
            ? 'UNAUTHENTICATED'
            : response.status === 403
              ? 'FORBIDDEN'
              : 'API_ERROR'),
        body?.error?.message ?? fallback,
        response.status,
        body?.error?.retryable ?? response.status >= 500,
      );
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new GatewayError(
        'INVALID_RESPONSE',
        'The backend did not return the expected response. No saved result was confirmed.',
        502,
        true,
      );
    }
  }

  private async mutationHeaders(): Promise<Record<string, string>> {
    if (!this.csrfToken) await this.bootstrap();
    if (!this.csrfToken) {
      throw new GatewayError(
        'CSRF_UNAVAILABLE',
        'The backend connection is not ready for secure changes. Please sign in again.',
        503,
      );
    }
    return { 'X-CSRF-Token': this.csrfToken! };
  }

  bootstrap(): Promise<Bootstrap> {
    return this.request('/bootstrap');
  }

  async execute(envelope: CommandEnvelope): Promise<Bootstrap> {
    const headers: Record<string, string> = {
      ...(await this.mutationHeaders()),
      'Content-Type': 'application/json',
      'Idempotency-Key': envelope.requestId,
    };
    if ('expectedVersion' in envelope.command)
      headers['If-Match'] = `"${envelope.command.expectedVersion}"`;
    return this.request('/commands', { method: 'POST', headers, body: JSON.stringify(envelope) });
  }

  exportOwn(): Promise<object> {
    return this.request('/export');
  }

  async upload(file: File): Promise<{ mediaId: string }> {
    if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
      throw new GatewayError(
        'IMAGE_FORMAT',
        'Export this photo as JPEG or PNG first. HEIC is not supported in this version.',
      );
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new GatewayError('IMAGE_FORMAT', 'Choose one JPEG, PNG, or WebP image.');
    }
    if (file.size > 10 * 1024 * 1024)
      throw new GatewayError('IMAGE_SIZE', 'Choose an image smaller than 10 MB.');
    const requestId = this.uploadRequests.get(file) ?? crypto.randomUUID();
    this.uploadRequests.set(file, requestId);
    const headers = { ...(await this.mutationHeaders()), 'Idempotency-Key': requestId };
    const form = new FormData();
    form.append('file', file);
    return this.request('/media', { method: 'POST', headers, body: form });
  }

  async logout(): Promise<void> {
    await this.request('/session/logout', {
      method: 'POST',
      headers: await this.mutationHeaders(),
    });
    this.csrfToken = null;
  }
}
