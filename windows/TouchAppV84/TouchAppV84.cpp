// TouchAppV84.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "TouchAppV84.h"

#include "AutolinkedNativeModules.g.h"

#include "NativeModules.h"

#include <string>

#define DIAG_TAG L"V84"
#define DIAG_BUILD L"V84_B1"

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE instance, HINSTANCE, PSTR /* commandLine */, int showCmd) {
  winrt::init_apartment(winrt::apartment_type::single_threaded);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // DIAG: confirm fresh binary is running on the target.
  MessageBoxW(nullptr,
              L"RNW " DIAG_TAG L" " DIAG_BUILD L" Diag Build, cpp entered.",
              DIAG_TAG L" " DIAG_BUILD L" Diag",
              MB_OK | MB_TOPMOST);

  WCHAR appDirectory[MAX_PATH];
  GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
  PathCchRemoveFileSpec(appDirectory, MAX_PATH);

  auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};

  // Pull AppWindow early so we can use Title() as a diagnostic channel.
  auto appWindow{reactNativeWin32App.AppWindow()};
  appWindow.Title(DIAG_TAG L" " DIAG_BUILD L" D0 cpp ready");
  appWindow.Resize({1000, 1000});

  auto settings{reactNativeWin32App.ReactNativeHost().InstanceSettings()};
  RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
  settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

  // V84_B1: vanilla scheduling. Do NOT call QuirkSettings::SetUseRuntimeScheduler.
  // RNW 0.84 contains the upstream touch fixes (#16048/#16081/#16086/#16099/#16100)
  // so we want stock 0.84 default scheduling to test whether those fixes alone
  // resolve the issue. If V84_B1 still fails on finger touch, B2 can add the
  // QuirkSettings::SetUseRuntimeScheduler(settings, false) quirk used in V82_B6.

  // Hook events BEFORE Start so they fire during it.
  settings.InstanceCreated([appWindow](
      winrt::Windows::Foundation::IInspectable const&,
      winrt::Microsoft::ReactNative::InstanceCreatedEventArgs const&) {
    appWindow.Title(DIAG_TAG L" " DIAG_BUILD L" D2 instance created");
  });
  settings.InstanceLoaded([appWindow](
      winrt::Windows::Foundation::IInspectable const&,
      winrt::Microsoft::ReactNative::InstanceLoadedEventArgs const& args) {
    appWindow.Title(args.Failed() ? (DIAG_TAG L" " DIAG_BUILD L" D3 LOAD FAILED") : (DIAG_TAG L" " DIAG_BUILD L" D3 LOADED OK"));
  });

#if BUNDLE
  // Use a plain Windows absolute path (no URI scheme). fs::u8path inside
  // OInstance.cpp:JsBigStringFromPath mangles ms-appx:// because ":" is the
  // drive separator, which is why D3 LOAD FAILED with "file not found" on
  // ms-appx:///Bundle/. A plain path takes the GetFileFromPathAsync code path.
  settings.BundleRootPath(std::wstring(appDirectory).append(L"\\Bundle\\").c_str());
  settings.JavaScriptBundleFile(L"index.windows");
  settings.UseFastRefresh(false);
#else
  settings.JavaScriptBundleFile(L"index");
  settings.UseFastRefresh(true);
#endif
#if _DEBUG
  settings.UseDirectDebugger(true);
  settings.UseDeveloperSupport(true);
#else
  settings.UseDirectDebugger(false);
  settings.UseDeveloperSupport(true); // keep dev support on for diag
#endif

  appWindow.Title(DIAG_TAG L" " DIAG_BUILD L" D1 cfg done");

  auto viewOptions{reactNativeWin32App.ReactViewOptions()};
  viewOptions.ComponentName(L"TouchAppV84");

  appWindow.Title(DIAG_TAG L" " DIAG_BUILD L" D4 starting Start");

  try {
    reactNativeWin32App.Start();
  } catch (winrt::hresult_error const& e) {
    std::wstring msg = std::wstring(DIAG_TAG L" Start exception 0x")
                     + std::to_wstring(static_cast<uint32_t>(e.code()))
                     + L": " + std::wstring(e.message());
    MessageBoxW(nullptr, msg.c_str(), DIAG_TAG L" Start exception",
                MB_OK | MB_ICONERROR | MB_TOPMOST);
  } catch (std::exception const& e) {
    std::string msgA = std::string("Start exception (std): ") + e.what();
    MessageBoxA(nullptr, msgA.c_str(), "Start exception",
                MB_OK | MB_ICONERROR | MB_TOPMOST);
  } catch (...) {
    MessageBoxW(nullptr,
                DIAG_TAG L" Start exception (unknown)",
                DIAG_TAG L" Start exception",
                MB_OK | MB_ICONERROR | MB_TOPMOST);
  }
  return 0;
}
