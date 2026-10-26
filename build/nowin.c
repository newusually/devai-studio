/* nowin.c —— 隐藏控制台启动器（根治 ollama/llama-server 弹黑窗口）
 * 用法：nowin.exe <目标exe> [参数...]
 *
 * 原理（2026-10-26 实测定位）：
 *   Windows 控制台程序若以「无控制台」方式启动（DETACHED_PROCESS /
 *   CREATE_NO_WINDOW / Node 的 detached:true），它自己虽不弹窗，但它 spawn 出的
 *   控制台子进程（如 ollama → llama-server.exe）必须【另开一个新控制台】才能运行，
 *   这个新控制台默认可见 → 用户看到黑窗口弹出。
 *   反之，若让目标进程拥有一个【已隐藏的控制台】（CREATE_NEW_CONSOLE +
 *   STARTF_USESHOWWINDOW/SW_HIDE），则其子进程会【继承同一个隐藏控制台】，
 *   永远不会再分配可见窗口 → 启动时零黑窗口。
 *
 * 编译：gcc -O2 -mwindows -o nowin.exe nowin.c -lshell32
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>

static void logerr(const char *fmt, const char *arg, unsigned long code) {
    /* 不弹任何窗口（弹窗本身就是我们要消灭的东西），只写日志文件。 */
    char path[MAX_PATH];
    if (!GetModuleFileNameA(NULL, path, MAX_PATH)) return;
    char *slash = strrchr(path, '\\');
    if (slash) *(slash + 1) = 0;
    char full[MAX_PATH];
    lstrcatA(full, path);
    lstrcatA(full, "nowin.log");
    FILE *f = fopen(full, "ab");
    if (!f) return;
    fprintf(f, "[%lu] ", GetTickCount());
    fprintf(f, fmt, arg, code);
    fclose(f);
}

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || argc < 2) {
        if (argv) LocalFree(argv);
        logerr("usage error: argc=%d, target=", "", 0);
        return 1;
    }

    /* argv[1] = 目标 exe（已由系统正确去引号） */
    wchar_t wtarget[MAX_PATH];
    lstrcpynW(wtarget, argv[1], MAX_PATH);
    char target[MAX_PATH];
    WideCharToMultiByte(CP_ACP, 0, wtarget, -1, target, MAX_PATH, NULL, NULL);

    /* 构造目标命令行："target" arg1 arg2 ... */
    char full[MAX_PATH * 2 + 2048];
    int pos = 0;
    pos += _snprintf(full + pos, sizeof(full) - pos, "\"%s\"", target);
    for (int i = 2; i < argc && pos < (int)sizeof(full) - 512; i++) {
        char a[1024];
        WideCharToMultiByte(CP_ACP, 0, argv[i], -1, a, sizeof(a), NULL, NULL);
        if (strchr(a, ' ')) pos += _snprintf(full + pos, sizeof(full) - pos, " \"%s\"", a);
        else pos += _snprintf(full + pos, sizeof(full) - pos, " %s", a);
    }
    LocalFree(argv);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags |= STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;              /* 关键：新建的控制台窗口直接隐藏 */

    /* 把 stdin/stdout/stderr 接到 NUL，避免 ollama 报
     * "failed to get console mode for stderr: The handle is invalid" 之类的噪声 */
    HANDLE hNull = CreateFileA("NUL", GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (hNull != INVALID_HANDLE_VALUE) {
        si.dwFlags |= STARTF_USESTDHANDLES;
        si.hStdInput = hNull;
        si.hStdOutput = hNull;
        si.hStdError = hNull;
    }

    ZeroMemory(&pi, sizeof(pi));

    /* CREATE_NEW_CONSOLE：给目标一个（隐藏的）控制台，供子孙继承，避免另开可见窗口 */
    BOOL ok = CreateProcessA(target, full, NULL, NULL, FALSE,
                CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                NULL, NULL, &si, &pi);
    if (!ok) {
        logerr("CreateProcess failed target=%s err=", target, GetLastError());
        return 1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 0;
}