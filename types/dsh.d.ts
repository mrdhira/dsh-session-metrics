/**
 * The minimum DSH client contract this plugin relies on.
 *
 * The packaged app ships no `.d.ts` (verified: zero declaration files in the app tree), and
 * the published `@deepseek-ai/dsh-*` packages describe the host half only, so the browser
 * half's surfaces are declared here. Everything is deliberately loose: these are shapes
 * observed at runtime, not a published contract.
 */
declare const require: (name: string) => any;
declare const module: { exports: any };
declare const exports: any;
declare const window: any;
declare const document: any;
declare const Intl: any;
declare const __BUILD_ID__: string;

/** Props the slot owner composes onto a registered entry. */
interface DshSlotProps {
  readonly sessionId?: string;
  readonly view?: 'page' | 'summary';
  readonly surface?: 'bundle' | 'row';
  readonly useProjection?: (key: string) => any;
  readonly refreshProjections?: (sessionId?: string) => void;
  readonly getService?: (name: string) => any;
  readonly form?: any;
  readonly subject?: any;
  readonly [key: string]: any;
}

/** A projection value as the client sees it. */
type ProjectionValue = any;

/** The restricted client context a plugin half is applied with. */
interface DshClientContext {
  get(name: string): any;
  slots: { register(options: any, component: any): void; inject(name: string, run: () => void): void };
  /**
   * Optional-service injection: the callback runs only while every named service is
   * provided, and inside it the service is a legal property read. Absent entirely on a
   * context that does not offer it — the badge then falls back to `ctx.get`.
   */
  inject?(dependencies: string[], run: (child: any) => void): void;
  effect(run: () => void): void;
  [key: string]: any;
}
