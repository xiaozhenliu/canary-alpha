const TOKEN_KEY = 'canary-dashboard-token';

export function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function hasAuthToken(): boolean {
  return !!localStorage.getItem(TOKEN_KEY);
}

export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options?.headers,
    },
  });
  if (res.status === 401) {
    clearAuthToken();
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new ApiError('Unauthorized', 401);
  }
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
