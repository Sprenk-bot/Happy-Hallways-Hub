declare module "bun:sqlite" {
  interface Statement {
    get<T = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
    run(...parameters: unknown[]): unknown;
  }

  export class Database {
    constructor(
      path: string,
      options?: { create?: boolean; readwrite?: boolean; readonly?: boolean },
    );
    exec(sql: string): void;
    query(sql: string): Statement;
    transaction<T>(callback: () => T): () => T;
    close(force?: boolean): void;
  }
}

declare module "bun:test" {
  export function afterEach(callback: () => void | Promise<void>): void;
  export function describe(name: string, callback: () => void): void;
  export function expect(actual: unknown): any;
  export function test(
    name: string,
    callback: () => void | Promise<void>,
  ): void;
}
