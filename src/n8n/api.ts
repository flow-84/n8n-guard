import type { GuardConfig } from "../config.js";

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  updatedAt?: string;
  createdAt?: string;
  nodes?: unknown[];
  connections?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface N8nExecution {
  id: string | number;
  workflowId?: string;
  status?: string;
  finished?: boolean;
  mode?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

export class N8nApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "N8nApiError";
  }
}

interface Page<T> {
  data: T[];
  nextCursor?: string | null;
}

/**
 * Thin client for the n8n Public API. It deliberately covers only what the
 * operational checks need; workflow authoring is what every other n8n MCP
 * server already does well.
 */
export class N8nApi {
  constructor(private readonly config: GuardConfig) {}

  private async request<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    if (!this.config.n8nApiKey) {
      throw new N8nApiError("N8N_API_KEY is not set, so the n8n Public API cannot be queried");
    }
    const url = new URL(`${this.config.n8nUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "X-N8N-API-KEY": this.config.n8nApiKey, accept: "application/json" },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new N8nApiError(`cannot reach ${url.origin}: ${(error as Error).message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new N8nApiError(
        `${url.pathname} returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /** Walks the cursor pagination until exhausted or `max` records are collected. */
  private async collect<T>(path: string, params: Record<string, string | number | boolean | undefined>, max: number): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<Page<T>>(path, { ...params, limit: 250, cursor });
      out.push(...(page.data ?? []));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && out.length < max);
    return out.slice(0, max);
  }

  /** Reachability probe that works without an API key. */
  async health(): Promise<{ reachable: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.config.n8nUrl}/healthz`, {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      return { reachable: response.ok, detail: `GET /healthz -> ${response.status}` };
    } catch (error) {
      return { reachable: false, detail: (error as Error).message };
    }
  }

  listWorkflows(max = 1000): Promise<N8nWorkflow[]> {
    return this.collect<N8nWorkflow>("/workflows", { excludePinnedData: true }, max);
  }

  getWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>(`/workflows/${encodeURIComponent(id)}`);
  }

  listExecutions(status: "running" | "success" | "error" | "waiting" | undefined, max = 500): Promise<N8nExecution[]> {
    return this.collect<N8nExecution>("/executions", { status, includeData: false }, max);
  }
}
