/* DevAI Studio 启动器（原生，无控制台窗口）
 * 作用：在启动真正的 electron 主程序前，清除会让 electron 退化成纯 node 的
 *       环境变量 ELECTRON_RUN_AS_NODE，并关闭 crashpad 噪声，从而“封死”该退路。
 *       无论系统/会话里是否被注入该变量，子进程都拿不到它，应用必定以 Electron 模式启动。
 */
#include <windows.h>
#include <string>

static std::string dirOf(const char *path) {
    std::string s(path);
    size_t p = s.find_last_of("\\/");
    return (p == std::string::npos) ? std::string(".") : s.substr(0, p);
}

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    /* 1) 清除污染变量：ELECTRON_RUN_AS_NODE=1 会让 electron.exe 当 node 跑，
     *    导致 require('electron') 失败、主进程一加载即崩、窗口永不出现。 */
    SetEnvironmentVariableA("ELECTRON_RUN_AS_NODE", NULL);
    /* 2) 关闭 crashpad 噪声（本机电子构建缺 crashpad_handler，会刷 CreateFile 0x2 报错，无关功能）。 */
    SetEnvironmentVariableA("ELECTRON_DISABLE_CRASHPAD", "1");

    char self[MAX_PATH];
    GetModuleFileNameA(NULL, self, MAX_PATH);
    std::string dir = dirOf(self);
    std::string exe = dir + "\\DevAI Studio.exe";

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(exe.c_str(), NULL, NULL, NULL, FALSE,
                        CREATE_UNICODE_ENVIRONMENT, NULL, dir.c_str(), &si, &pi)) {
        DWORD err = GetLastError();
        std::string msg = "无法启动 DevAI Studio。\n\n目标：\n" + exe +
                          "\n\n错误码：0x" + std::to_string(err);
        MessageBoxA(NULL, msg.c_str(), "DevAI Studio", MB_OK | MB_ICONERROR);
        return 1;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
