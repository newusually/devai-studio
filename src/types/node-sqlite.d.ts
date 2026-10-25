/* ============================================================================
 * src/types/node-sqlite.d.ts —— node:sqlite 类型声明
 * ----------------------------------------------------------------------------
 * Node 22.5+ 起内置 node:sqlite，Node 24 已转正。
 * 但 @types/node 20 的版本里还没有该模块的类型声明，这里手写最小可用签名。
 * ========================================================================== */
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): StatementResultingChanges;
    /** Node 22.15+ / 24 新增：迭代器消费，避免大结果集一次性进内存 */
    iterate(...params: any[]): IterableIterator<any>;
    setAllowBareNamedParameters(allow: boolean): void;
    setReadBigInts(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    function(name: string, options?: any): any;
    aggregate(name: string, options?: any): any;
    createSession(options?: any): any;
    backup(destination: string, options?: any): Promise<void>;
    location(): string;
    isTransaction?: boolean;
  }
}
