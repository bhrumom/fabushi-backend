/* tslint:disable */
/* eslint-disable */

export class OfficialMiniAppRuntime {
    free(): void;
    [Symbol.dispose](): void;
    callTool(tool: string, arguments_json: string): string;
    callToolOutcome(tool: string, arguments_json: string): string;
    exportState(): string;
    homeHtml(): string;
    manifestJson(): string;
    constructor(plugin_id: string, state_json: string);
    toolsJson(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_officialminiappruntime_free: (a: number, b: number) => void;
    readonly officialminiappruntime_callTool: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly officialminiappruntime_callToolOutcome: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly officialminiappruntime_exportState: (a: number, b: number) => void;
    readonly officialminiappruntime_homeHtml: (a: number, b: number) => void;
    readonly officialminiappruntime_manifestJson: (a: number, b: number) => void;
    readonly officialminiappruntime_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly officialminiappruntime_toolsJson: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
