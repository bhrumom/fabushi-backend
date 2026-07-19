/* tslint:disable */
/* eslint-disable */

/**
 * Long-lived browser runtime with the same JSON commands/events as native.
 */
export class MahayanaWebRuntime {
    free(): void;
    [Symbol.dispose](): void;
    execute(command_json: string): string;
    /**
     * Executes account, marketplace, payment, and social commands inside the
     * browser-local Rust Worker. Credentials are retained in Rust state and
     * are removed from every response before it crosses into Flutter/Dart.
     */
    execute_product(command_json: string): Promise<string>;
    constructor(config_json: string);
    /**
     * Returns one queued event, or null when the browser queue is empty.
     */
    receive(): string | undefined;
    /**
     * Registers a browser-local plugin after the package loader has verified
     * its Codex manifest, TUF target, runtime variant, and user permissions.
     * Jco-generated modules expose their callable object through
     * `globalThis.__mahayanaLocalPlugins[pluginId]`; this Rust host never
     * substitutes a cloud MCP endpoint.
     */
    register_local_plugin(plugin_json: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mahayanawebruntime_free: (a: number, b: number) => void;
    readonly mahayanawebruntime_execute: (a: number, b: number, c: number, d: number) => void;
    readonly mahayanawebruntime_execute_product: (a: number, b: number, c: number) => number;
    readonly mahayanawebruntime_new: (a: number, b: number, c: number) => void;
    readonly mahayanawebruntime_receive: (a: number, b: number) => void;
    readonly mahayanawebruntime_register_local_plugin: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1233: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1235: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export5: (a: number, b: number, c: number) => void;
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
