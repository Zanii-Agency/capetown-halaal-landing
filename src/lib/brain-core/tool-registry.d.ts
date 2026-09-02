/* eslint-disable @typescript-eslint/no-explicit-any */
export type ToolPrimitiveCategory = "guard" | "resolver" | "chokepoint" | "persistence" | "introspection";
export type ToolPrimitive<TInput = unknown, TOutput = unknown, TAdapters = unknown> = {
    name: string;
    category: ToolPrimitiveCategory;
    description: string;
    registeredAt: string;
    kt?: number;
    run: (input: TInput, adapters: TAdapters) => Promise<TOutput>;
};
export declare function register<I, O, A>(primitive: ToolPrimitive<I, O, A>): void;
export declare function list(): ToolPrimitive<any, any, any>[];
export declare function get(name: string): ToolPrimitive<any, any, any> | undefined;
export declare function _resetForTest(): void;
//# sourceMappingURL=tool-registry.d.ts.map