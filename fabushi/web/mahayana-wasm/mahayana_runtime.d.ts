/* tslint:disable */
/* eslint-disable */

/**
 * Long-lived browser runtime with the same JSON commands/events as native.
 */
export class MahayanaWebRuntime {
    free(): void;
    [Symbol.dispose](): void;
    execute(command_json: string): string;
    constructor(config_json: string);
    /**
     * Returns one queued event, or null when the browser queue is empty.
     */
    receive(): string | undefined;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mahayanawebruntime_free: (a: number, b: number) => void;
    readonly mahayanawebruntime_execute: (a: number, b: number, c: number) => [number, number, number, number];
    readonly mahayanawebruntime_new: (a: number, b: number) => [number, number, number];
    readonly mahayanawebruntime_receive: (a: number) => [number, number, number, number];
    readonly wasm_bindgen_1249bbd6df52a242___convert__closures_____invoke___wasm_bindgen_1249bbd6df52a242___JsValue__core_7d5f0a2ba6a62c33___result__Result_____wasm_bindgen_1249bbd6df52a242___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
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
