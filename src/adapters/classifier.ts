import { READINESS_SCHEMA, validateIdentity, validateResult } from '../engine/readiness.ts';
import type { ClassifierAdapter, ClassifierIdentity } from '../engine/readiness.ts';
import type { FeatureSnapshot } from '../engine/features.ts';

/** Loopback only: the service and classifier are deployed together on the GB10. */
export class LocalClassifier implements ClassifierAdapter {
  private loaded?: ClassifierIdentity;
  private baseUrl: string;
  private timeoutMs: number;
  constructor(baseUrl: string, timeoutMs: number) { this.baseUrl = baseUrl; this.timeoutMs = timeoutMs; }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Local classifier returned HTTP ${response.status}`);
    return response.json();
  }

  async identity(): Promise<ClassifierIdentity> {
    if (!this.loaded) this.loaded = validateIdentity(await this.request('/health'));
    return this.loaded;
  }

  async predict(snapshot: FeatureSnapshot['data']) {
    try {
      return validateResult(await this.request('/predict', { schema_version: READINESS_SCHEMA, snapshot }), await this.identity());
    } catch (error) {
      this.loaded = undefined; // A replaced service is re-identified on the next request.
      throw error;
    }
  }
}
