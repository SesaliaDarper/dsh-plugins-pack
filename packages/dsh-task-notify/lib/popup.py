"""DSH 任务完成弹窗 —— 右下角通知窗口。

一个常驻的轻量进程，从 stdin 读 NDJSON 指令，把通知画到屏幕右下角。

为什么自绘而不是用系统 Toast：本机 Windows 11 (22631) 对**未打包进程**
禁用了 WinRT Toast —— `CreateToastNotifier(aumid).Show()` 一律抛
0x80073D54「The process has no package identity」，连设置进程 AUMID
也不行；而 DSH 自己的 Electron 外壳只把 `Notification` 用在强制更新流程上，
插件够不到。自绘窗口反而是唯一能同时做到「真的弹在右下角」和
「完全跟随 DSH 主题 + 带美术」的路子。

窗口是 WS_EX_LAYERED 的逐像素 alpha 窗口（UpdateLayeredWindow），
所以圆角是真透明、能和桌面自然叠加，不会出现黑角或白角。

指令（每行一个 JSON）：
  {"cmd":"show","id":"...","title":...,"body":...,"meta":...,
   "status":"done|failed|cancelled","dark":true,
   "tokens":{"--dsw-alias-label-primary":"#eee",...},
   "art_path":"...","duration_ms":6000}
  {"cmd":"dismiss","id":"..."}
  {"cmd":"dismiss-all"}
  {"cmd":"ping"} -> {"cmd":"pong","visible":0}
"""

from __future__ import annotations

import ctypes
import json
import os
import queue
import sys
import threading
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from card import render, to_premultiplied_bgra  # noqa: E402

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

LRESULT = ctypes.c_ssize_t
WPARAM = ctypes.c_size_t
LPARAM = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, ctypes.c_uint, WPARAM, LPARAM)

WS_POPUP = 0x80000000
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TOPMOST = 0x00000008
WS_EX_NOACTIVATE = 0x08000000
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, LPARAM)
PM_REMOVE = 0x0001
WM_QUIT = 0x0012
HGDI_ERROR = ctypes.c_void_p(-1).value

SW_SHOWNA = 8
SW_RESTORE = 9
SPI_GETWORKAREA = 0x0030
AC_SRC_OVER, AC_SRC_ALPHA, ULW_ALPHA = 0, 1, 2

WM_LBUTTONUP, WM_RBUTTONUP, WM_CLOSE = 0x0202, 0x0205, 0x0010
WM_MOUSEACTIVATE, MA_NOACTIVATE = 0x0021, 3
WM_ERASEBKGND = 0x0014


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", ctypes.c_uint), ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class SIZE(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


user32.DefWindowProcW.restype = LRESULT
user32.DefWindowProcW.argtypes = [wintypes.HWND, ctypes.c_uint, WPARAM, LPARAM]
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.UpdateLayeredWindow.restype = wintypes.BOOL
user32.UpdateLayeredWindow.argtypes = [
    wintypes.HWND, wintypes.HDC, ctypes.POINTER(POINT), ctypes.POINTER(SIZE),
    wintypes.HDC, ctypes.POINTER(POINT), wintypes.DWORD,
    ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.ReleaseDC.restype = ctypes.c_int
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
user32.RegisterClassW.restype = wintypes.ATOM
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
user32.LoadCursorW.restype = wintypes.HANDLE
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, wintypes.LPVOID, wintypes.UINT]
user32.EnumWindows.argtypes = [WNDENUMPROC, LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.PeekMessageW.argtypes = [ctypes.POINTER(ctypes.wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
user32.PeekMessageW.restype = wintypes.BOOL
user32.TranslateMessage.argtypes = [ctypes.POINTER(ctypes.wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(ctypes.wintypes.MSG)]
user32.DispatchMessageW.restype = LRESULT
user32.TranslateMessage.restype = wintypes.BOOL
user32.SystemParametersInfoW.restype = wintypes.BOOL
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.DestroyWindow.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteObject.restype = wintypes.BOOL
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.DeleteDC.restype = wintypes.BOOL


def log(message: str) -> None:
    try:
        sys.stderr.write(f"[dsh-task-notify] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def work_area():
    rect = RECT()
    if user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0):
        return rect.left, rect.top, rect.right, rect.bottom
    return 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def find_dsh_window() -> int:
    """找 DSH 主窗口，用于点击弹窗后把应用带到前台。"""
    found = []

    @WNDENUMPROC
    def cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return 1
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return 1
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value or ""
            if "DeepSeek Harness" in title:
                found.append(int(hwnd))
                return 0
        except Exception:
            pass
        return 1

    try:
        user32.EnumWindows(cb, 0)
    except Exception:
        pass
    return found[0] if found else 0


class Popup:
    """一张通知卡片对应的分层窗口。"""

    _registered = False
    _class_name = "DshTaskNotifyWnd"
    _proc_ref = None
    _instances: dict[int, "Popup"] = {}

    def __init__(self, card, spec, on_click, on_closed):
        self.card = card
        self.spec = spec
        self.on_click = on_click
        self.on_closed = on_closed
        self.width, self.height = card.size
        self.hwnd = 0
        self._screen = self._mem = self._hbmp = self._old_bitmap = None
        self.expires_at = None
        Popup._register()

        self.hwnd = user32.CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            Popup._class_name, "DSH 通知", WS_POPUP,
            0, 0, self.width, self.height, None, None, kernel32.GetModuleHandleW(None), None)
        if not self.hwnd:
            raise OSError(f"CreateWindowExW failed: {ctypes.get_last_error()}")
        Popup._instances[int(self.hwnd)] = self

        try:
            self._screen = user32.GetDC(None)
            if not self._screen:
                raise ctypes.WinError(ctypes.get_last_error())
            self._mem = gdi32.CreateCompatibleDC(self._screen)
            if not self._mem:
                raise ctypes.WinError(ctypes.get_last_error())
            bmi = BITMAPINFO()
            bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.bmiHeader.biWidth = self.width
            bmi.bmiHeader.biHeight = -self.height
            bmi.bmiHeader.biPlanes = 1
            bmi.bmiHeader.biBitCount = 32
            bmi.bmiHeader.biCompression = 0
            self._ppv = ctypes.c_void_p()
            self._hbmp = gdi32.CreateDIBSection(
                self._screen, ctypes.byref(bmi), 0, ctypes.byref(self._ppv), None, 0)
            if not self._hbmp or not self._ppv:
                raise OSError(f"CreateDIBSection failed: {ctypes.get_last_error()}")
            self._old_bitmap = gdi32.SelectObject(self._mem, self._hbmp)
            if not self._old_bitmap or self._old_bitmap == HGDI_ERROR:
                self._old_bitmap = None
                raise OSError(f"SelectObject failed: {ctypes.get_last_error()}")
            self._buf = (ctypes.c_ubyte * (self.width * self.height * 4)).from_address(self._ppv.value)
        except Exception:
            self.dismiss()
            raise

    @classmethod
    def _register(cls):
        if cls._registered:
            return

        def proc(hwnd, msg, wparam, lparam):
            try:
                if msg == WM_MOUSEACTIVATE:
                    return MA_NOACTIVATE
                if msg == WM_ERASEBKGND:
                    return 1
                inst = cls._instances.get(int(hwnd))
                if inst is not None and msg in (WM_LBUTTONUP, WM_RBUTTONUP, WM_CLOSE):
                    inst.dismiss()
                    return 0
            except Exception as exc:
                log(f"wndproc: {exc!r}")
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        cls._proc_ref = WNDPROC(proc)
        wc = WNDCLASSW()
        wc.lpfnWndProc = cls._proc_ref
        wc.hInstance = kernel32.GetModuleHandleW(None)
        if not wc.hInstance:
            raise OSError(f"GetModuleHandleW failed: {ctypes.get_last_error()}")
        wc.hCursor = user32.LoadCursorW(None, 32512)
        if not wc.hCursor:
            raise OSError(f"LoadCursorW failed: {ctypes.get_last_error()}")
        wc.lpszClassName = cls._class_name
        if not user32.RegisterClassW(ctypes.byref(wc)):
            err = ctypes.get_last_error()
            if err != 1410:  # ERROR_CLASS_ALREADY_EXISTS
                raise OSError(f"RegisterClassW failed: {err}")
        cls._registered = True

    def _paint(self, image, x, y):
        payload = to_premultiplied_bgra(image)
        ctypes.memmove(self._buf, payload, len(payload))
        size = SIZE(self.width, self.height)
        dst, src = POINT(x, y), POINT(0, 0)
        blend = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
        if not user32.UpdateLayeredWindow(self.hwnd, self._screen, ctypes.byref(dst),
                                         ctypes.byref(size), self._mem, ctypes.byref(src),
                                         0, ctypes.byref(blend), ULW_ALPHA):
            raise OSError(f"UpdateLayeredWindow failed: {ctypes.get_last_error()}")

    def show_at(self, x, y, animate=True, pump=None):
        frames = 7 if animate else 1
        for index in range(frames):
            if not self.hwnd:
                return
            t = (index + 1) / frames
            eased = 1 - (1 - t) ** 3
            if frames > 1 and t < 1:
                frame = self.card.copy()
                frame.putalpha(self.card.getchannel("A").point(lambda v, e=eased: int(v * e)))
            else:
                frame = self.card
            self._paint(frame, x, y + int((1 - eased) * 10))
            user32.ShowWindow(self.hwnd, SW_SHOWNA)
            if pump is not None and not pump():
                return
            if frames > 1:
                time.sleep(0.014)

    def move_to(self, x, y):
        if self.hwnd:
            self._paint(self.card, x, y)

    def dismiss(self):
        if not self.hwnd:
            return
        hwnd = self.hwnd
        if not user32.DestroyWindow(hwnd):
            raise OSError(f"DestroyWindow failed: {ctypes.get_last_error()}")
        self.hwnd = 0
        Popup._instances.pop(int(hwnd), None)
        if self._old_bitmap:
            restored = gdi32.SelectObject(self._mem, self._old_bitmap)
            if not restored or restored == HGDI_ERROR:
                log(f"restore bitmap failed: {ctypes.get_last_error()}")
            self._old_bitmap = None
        # Delete the DC first if restoration failed, so the bitmap is unselected.
        if self._mem:
            if not gdi32.DeleteDC(self._mem):
                log(f"DeleteDC failed: {ctypes.get_last_error()}")
            self._mem = None
        if self._hbmp:
            if not gdi32.DeleteObject(self._hbmp):
                log(f"DeleteObject failed: {ctypes.get_last_error()}")
            self._hbmp = None
        if self._screen:
            if not user32.ReleaseDC(None, self._screen):
                log(f"ReleaseDC failed: {ctypes.get_last_error()}")
            self._screen = None
        try:
            self.on_closed(self)
        except Exception as exc:
            log(f"on_closed: {exc!r}")


class Manager:
    MARGIN_X, MARGIN_Y, GAP, MAX_VISIBLE = 16, 16, 8, 4

    def __init__(self):
        self._active: list[Popup] = []
        self._owner = threading.get_ident()
        self._commands = queue.Queue()

    def _assert_owner(self):
        if threading.get_ident() != self._owner:
            raise RuntimeError("Windows must be managed on the UI owner thread")

    def _pump(self):
        self._assert_owner()
        message = wintypes.MSG()
        while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, PM_REMOVE):
            if message.message == WM_QUIT:
                return False
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))
        now = time.monotonic()
        for popup in list(self._active):
            if popup.expires_at is not None and now >= popup.expires_at:
                popup.dismiss()
        return True

    def _relayout(self):
        self._assert_owner()
        self._active = [p for p in self._active if p.hwnd]
        _l, _t, right, bottom = work_area()
        y = bottom - self.MARGIN_Y
        for popup in reversed(self._active):
            y -= popup.height
            popup.move_to(right - self.MARGIN_X - popup.width, y)
            y -= self.GAP

    def show(self, spec: dict) -> None:
        self._assert_owner()
        duration = int(spec.get("duration_ms", 6000))
        if spec.get("id") is not None:
            self.dismiss(spec["id"])
        while len(self._active) >= self.MAX_VISIBLE:
            self._active[0].dismiss()
        card = render(spec)
        popup = Popup(card, spec, on_click=self._clicked, on_closed=self._closed)
        self._active.append(popup)
        try:
            _l, _t, right, bottom = work_area()
            popup.show_at(right - self.MARGIN_X - popup.width,
                          bottom - self.MARGIN_Y - popup.height, animate=bool(spec.get("animate", True)),
                          pump=self._pump)
            self._relayout()
            if duration > 0:
                popup.expires_at = time.monotonic() + duration / 1000.0
        except Exception:
            popup.dismiss()
            raise

    def dismiss(self, popup_id):
        self._assert_owner()
        for popup in list(self._active):
            if str(popup.spec.get("id")) == str(popup_id):
                popup.dismiss()

    def _closed(self, popup):
        if popup in self._active:
            self._active.remove(popup)
        self._relayout()

    def _clicked(self, spec):
        hwnd = find_dsh_window()
        if hwnd:
            try:
                user32.ShowWindow(hwnd, SW_RESTORE)
                user32.SetForegroundWindow(hwnd)
            except Exception as exc:
                log(f"focus failed: {exc!r}")

    def dismiss_all(self):
        self._assert_owner()
        for popup in list(self._active):
            popup.dismiss()

    def _read_stdin(self):
        # This thread only reads text; all Win32 and manager operations stay on UI.
        try:
            for line in sys.stdin:
                self._commands.put(line)
        finally:
            self._commands.put(None)

    def _command(self, line):
        if not line.strip():
            return
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("command must be a JSON object")
            cmd = message.get("cmd")
            if cmd == "show":
                self.show(message)
            elif cmd == "dismiss":
                self.dismiss(message["id"])
            elif cmd == "dismiss-all":
                self.dismiss_all()
            elif cmd == "ping":
                response = {"cmd": "pong", "visible": len(self._active)}
                if "id" in message:
                    response["id"] = message["id"]
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
        except Exception as exc:
            log(f"command failed: {exc!r}")

    def run(self):
        self._assert_owner()
        threading.Thread(target=self._read_stdin, daemon=True).start()
        try:
            while self._pump():
                try:
                    line = self._commands.get(timeout=0.01)
                except queue.Empty:
                    continue
                if line is None:
                    break
                self._command(line)
        finally:
            self.dismiss_all()

    def run_until_empty(self, hold=None):
        self._assert_owner()
        deadline = time.monotonic() + hold if hold is not None else None
        try:
            while self._pump() and self._active:
                if deadline is not None and time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
        finally:
            self.dismiss_all()


def main() -> int:
    # 调试/自检用：--show-file <json> 显示一次后退出
    for index, arg in enumerate(sys.argv):
        if arg == "--show-file" and index + 1 < len(sys.argv):
            with open(sys.argv[index + 1], "r", encoding="utf-8-sig") as handle:
                spec = json.load(handle)
            manager = Manager()
            hold = os.environ.get("DSH_NOTIFY_HOLD")
            if hold is not None:
                spec = dict(spec, duration_ms=0)
            manager.show(spec)
            manager.run_until_empty(float(hold) if hold is not None else None)
            return 0

    Manager().run()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
