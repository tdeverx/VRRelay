// SPDX-License-Identifier: GPL-3.0-or-later
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

#include <atomic>
#include <string>
#include <thread>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")

namespace {
constexpr wchar_t kWindowClass[] = L"VRRelayNativeTrayWindow";
constexpr wchar_t kServiceName[] = L"VRRelay";
constexpr wchar_t kDefaultDashboard[] = L"http://127.0.0.1:8099";
constexpr UINT kTrayIconId = 1;
constexpr UINT kTrayMessage = WM_APP + 1;
constexpr UINT kActionCompleteMessage = WM_APP + 2;
constexpr UINT_PTR kRefreshTimerId = 1;
constexpr UINT kOpenDashboard = 100;
constexpr UINT kStartService = 101;
constexpr UINT kStopService = 102;
constexpr UINT kRestartService = 103;
constexpr UINT kQuit = 104;

std::atomic_bool g_actionPending = false;
UINT g_taskbarCreated = 0;

DWORD queryServiceState() {
  SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!manager) return 0;
  SC_HANDLE service = OpenServiceW(manager, kServiceName, SERVICE_QUERY_STATUS);
  if (!service) {
    CloseServiceHandle(manager);
    return 0;
  }

  SERVICE_STATUS_PROCESS status{};
  DWORD bytesNeeded = 0;
  const BOOL queried = QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
      reinterpret_cast<LPBYTE>(&status), sizeof(status), &bytesNeeded);
  CloseServiceHandle(service);
  CloseServiceHandle(manager);
  return queried ? status.dwCurrentState : 0;
}

const wchar_t* serviceStatusText(DWORD state) {
  switch (state) {
    case SERVICE_RUNNING: return L"Running as a Windows service";
    case SERVICE_STOPPED: return L"Service is stopped";
    case SERVICE_START_PENDING: return L"Service is starting";
    case SERVICE_STOP_PENDING: return L"Service is stopping";
    case SERVICE_PAUSED: return L"Service is paused";
    default: return L"Service is not installed";
  }
}

bool waitForState(SC_HANDLE service, DWORD target, DWORD timeoutMilliseconds) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMilliseconds;
  while (GetTickCount64() < deadline) {
    SERVICE_STATUS_PROCESS status{};
    DWORD bytesNeeded = 0;
    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
            reinterpret_cast<LPBYTE>(&status), sizeof(status), &bytesNeeded))
      return false;
    if (status.dwCurrentState == target) return true;
    Sleep(250);
  }
  SetLastError(ERROR_TIMEOUT);
  return false;
}

DWORD controlService(const std::wstring& action) {
  SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!manager) return GetLastError();
  SC_HANDLE service = OpenServiceW(
      manager, kServiceName, SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP);
  if (!service) {
    const DWORD error = GetLastError();
    CloseServiceHandle(manager);
    return error;
  }

  DWORD result = ERROR_SUCCESS;
  SERVICE_STATUS_PROCESS current{};
  DWORD bytesNeeded = 0;
  if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
          reinterpret_cast<LPBYTE>(&current), sizeof(current), &bytesNeeded)) {
    result = GetLastError();
  } else {
    const bool shouldStop = action == L"stop" || action == L"restart";
    if (shouldStop && current.dwCurrentState != SERVICE_STOPPED) {
      if (current.dwCurrentState != SERVICE_STOP_PENDING) {
        SERVICE_STATUS ignored{};
        if (!ControlService(service, SERVICE_CONTROL_STOP, &ignored) &&
            GetLastError() != ERROR_SERVICE_NOT_ACTIVE)
          result = GetLastError();
      }
      if (result == ERROR_SUCCESS && !waitForState(service, SERVICE_STOPPED, 30'000))
        result = GetLastError();
    }

    const bool shouldStart = action == L"start" || action == L"restart";
    if (result == ERROR_SUCCESS && shouldStart) {
      if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
              reinterpret_cast<LPBYTE>(&current), sizeof(current), &bytesNeeded)) {
        result = GetLastError();
      } else if (current.dwCurrentState != SERVICE_RUNNING) {
        if (current.dwCurrentState != SERVICE_START_PENDING &&
            !StartServiceW(service, 0, nullptr) && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING)
          result = GetLastError();
        if (result == ERROR_SUCCESS && !waitForState(service, SERVICE_RUNNING, 30'000))
          result = GetLastError();
      }
    }
  }

  CloseServiceHandle(service);
  CloseServiceHandle(manager);
  return result;
}

std::wstring executablePath() {
  std::wstring path(32'768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= static_cast<DWORD>(path.size())) return {};
  path.resize(length);
  return path;
}

std::wstring dashboardUrl() {
  const DWORD required = GetEnvironmentVariableW(L"VRRELAY_PUBLIC_URL", nullptr, 0);
  if (required == 0) return kDefaultDashboard;
  std::wstring value(required, L'\0');
  const DWORD written = GetEnvironmentVariableW(
      L"VRRELAY_PUBLIC_URL", value.data(), static_cast<DWORD>(value.size()));
  if (written == 0 || written >= static_cast<DWORD>(value.size())) return kDefaultDashboard;
  value.resize(written);
  return value;
}

void showError(HWND window, DWORD error) {
  wchar_t* systemMessage = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error, 0, reinterpret_cast<LPWSTR>(&systemMessage), 0, nullptr);
  const std::wstring message = systemMessage
      ? std::wstring(L"The service operation failed: ") + systemMessage
      : L"The service operation failed.";
  if (systemMessage) LocalFree(systemMessage);
  MessageBoxW(window, message.c_str(), L"VRRelay", MB_OK | MB_ICONERROR);
}

void addOrUpdateTrayIcon(HWND window, DWORD message) {
  NOTIFYICONDATAW icon{};
  icon.cbSize = sizeof(icon);
  icon.hWnd = window;
  icon.uID = kTrayIconId;
  icon.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  icon.uCallbackMessage = kTrayMessage;
  icon.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  const std::wstring tip = std::wstring(L"VRRelay - ") + serviceStatusText(queryServiceState());
  wcsncpy_s(icon.szTip, tip.c_str(), _TRUNCATE);
  Shell_NotifyIconW(message, &icon);
}

void removeTrayIcon(HWND window) {
  NOTIFYICONDATAW icon{};
  icon.cbSize = sizeof(icon);
  icon.hWnd = window;
  icon.uID = kTrayIconId;
  Shell_NotifyIconW(NIM_DELETE, &icon);
}

void openDashboard(HWND window) {
  const std::wstring url = dashboardUrl();
  if (reinterpret_cast<INT_PTR>(
          ShellExecuteW(window, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32)
    MessageBoxW(window, L"Windows could not open the dashboard URL.", L"VRRelay",
        MB_OK | MB_ICONERROR);
}

void runElevatedAction(HWND window, const wchar_t* action) {
  if (g_actionPending.exchange(true)) return;
  std::thread([window, action = std::wstring(action)] {
    const std::wstring executable = executablePath();
    const std::wstring parameters = L"--control " + action;
    SHELLEXECUTEINFOW execution{};
    execution.cbSize = sizeof(execution);
    execution.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
    execution.hwnd = window;
    execution.lpVerb = L"runas";
    execution.lpFile = executable.c_str();
    execution.lpParameters = parameters.c_str();
    execution.nShow = SW_HIDE;

    DWORD result = ERROR_SUCCESS;
    if (!ShellExecuteExW(&execution)) {
      result = GetLastError();
    } else {
      const DWORD waitResult = WaitForSingleObject(execution.hProcess, 65'000);
      if (waitResult == WAIT_TIMEOUT)
        result = ERROR_TIMEOUT;
      else if (!GetExitCodeProcess(execution.hProcess, &result))
        result = GetLastError();
      CloseHandle(execution.hProcess);
    }
    PostMessageW(window, kActionCompleteMessage, result, 0);
  }).detach();
}

void showMenu(HWND window) {
  const DWORD state = queryServiceState();
  HMENU menu = CreatePopupMenu();
  if (!menu) return;
  AppendMenuW(menu, MF_STRING | MF_DISABLED, 0, serviceStatusText(state));
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kOpenDashboard, L"Open Dashboard");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  const UINT busy = g_actionPending.load() ? MF_GRAYED : MF_ENABLED;
  AppendMenuW(menu, MF_STRING | busy | (state == SERVICE_RUNNING ? MF_GRAYED : 0),
      kStartService, L"Start Relay");
  AppendMenuW(menu, MF_STRING | busy | (state == SERVICE_STOPPED ? MF_GRAYED : 0),
      kStopService, L"Stop Relay");
  AppendMenuW(menu, MF_STRING | busy | (state != SERVICE_RUNNING ? MF_GRAYED : 0),
      kRestartService, L"Restart Relay");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kQuit, L"Quit VRRelay Tray");

  POINT cursor{};
  GetCursorPos(&cursor);
  SetForegroundWindow(window);
  TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN,
      cursor.x, cursor.y, 0, window, nullptr);
  DestroyMenu(menu);
}

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  if (g_taskbarCreated != 0 && message == g_taskbarCreated) {
    addOrUpdateTrayIcon(window, NIM_ADD);
    return 0;
  }
  switch (message) {
    case kTrayMessage:
      if (lParam == WM_RBUTTONUP || lParam == WM_CONTEXTMENU) showMenu(window);
      if (lParam == WM_LBUTTONDBLCLK) openDashboard(window);
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wParam)) {
        case kOpenDashboard: openDashboard(window); break;
        case kStartService: runElevatedAction(window, L"start"); break;
        case kStopService: runElevatedAction(window, L"stop"); break;
        case kRestartService: runElevatedAction(window, L"restart"); break;
        case kQuit: DestroyWindow(window); break;
        default: break;
      }
      return 0;
    case kActionCompleteMessage:
      g_actionPending = false;
      if (wParam != ERROR_SUCCESS && wParam != ERROR_CANCELLED)
        showError(window, static_cast<DWORD>(wParam));
      addOrUpdateTrayIcon(window, NIM_MODIFY);
      return 0;
    case WM_TIMER:
      if (wParam == kRefreshTimerId) addOrUpdateTrayIcon(window, NIM_MODIFY);
      return 0;
    case WM_CLOSE:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      KillTimer(window, kRefreshTimerId);
      removeTrayIcon(window);
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wParam, lParam);
  }
}
}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments && argumentCount >= 2 && std::wstring(arguments[1]) == L"--quit") {
    if (HWND window = FindWindowW(kWindowClass, nullptr)) PostMessageW(window, WM_CLOSE, 0, 0);
    LocalFree(arguments);
    return 0;
  }
  if (arguments && argumentCount == 3 && std::wstring(arguments[1]) == L"--control") {
    const std::wstring action = arguments[2];
    LocalFree(arguments);
    if (action != L"start" && action != L"stop" && action != L"restart")
      return static_cast<int>(ERROR_INVALID_PARAMETER);
    return static_cast<int>(controlService(action));
  }
  if (arguments) LocalFree(arguments);

  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\VRRelayNativeTray");
  if (!mutex || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (mutex) CloseHandle(mutex);
    return 0;
  }

  g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  WNDCLASSEXW windowClass{};
  windowClass.cbSize = sizeof(windowClass);
  windowClass.lpfnWndProc = windowProcedure;
  windowClass.hInstance = instance;
  windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  windowClass.lpszClassName = kWindowClass;
  if (!RegisterClassExW(&windowClass)) {
    CloseHandle(mutex);
    return static_cast<int>(GetLastError());
  }

  HWND window = CreateWindowExW(0, kWindowClass, L"VRRelay Tray", WS_OVERLAPPED,
      0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
  if (!window) {
    CloseHandle(mutex);
    return static_cast<int>(GetLastError());
  }

  addOrUpdateTrayIcon(window, NIM_ADD);
  SetTimer(window, kRefreshTimerId, 10'000, nullptr);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  CloseHandle(mutex);
  return static_cast<int>(message.wParam);
}
