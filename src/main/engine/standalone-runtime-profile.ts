/* ============================================================================
 * engine/standalone-runtime-profile.ts —— OpenClaw standalone-runtime-profile 的本地等价实现
 * ----------------------------------------------------------------------------
 * 来源：openclaw/standalone-runtime-profile.mjs（仓库根，原样等价）
 *   "The executing image owns its runtime profile; sidecars describe artifacts on disk."
 *   原文件通过 globalThis.__openclawStandaloneBuildInfo 判断是否为 AOT 镜像。
 *   DevAI Studio 是普通 Electron 应用，永不处于 embedded-aot，故恒返回
 *   "dynamic-execution" —— 与原实现在本项目下的行为完全一致。
 * ========================================================================== */

// The executing image owns its runtime profile; sidecars describe artifacts on disk.
let runtimeExecutionProfile: string | undefined;

function resolveRuntimeExecutionProfile(build?: { mode?: string }): string {
  return build?.mode === "aot" ? "embedded-aot" : "dynamic-execution";
}

/** Compiler bootstrap installs image facts before any application entry or worker executes. */
export function getRuntimeExecutionProfile(): string {
  if (runtimeExecutionProfile === undefined) {
    runtimeExecutionProfile = resolveRuntimeExecutionProfile(
      (globalThis as { __openclawStandaloneBuildInfo?: { mode?: string } })
        .__openclawStandaloneBuildInfo,
    );
  }
  return runtimeExecutionProfile;
}
