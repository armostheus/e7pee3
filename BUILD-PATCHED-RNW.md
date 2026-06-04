# Building a Patched `Microsoft.ReactNative.dll`

This document explains how to rebuild `Microsoft.ReactNative.dll` from the
`react-native-windows` source so it includes:

- Upstream PR [#16139](https://github.com/microsoft/react-native-windows/pull/16139) (`PointerRoutedAway` zombie-touch fix) — released in v0.84.0-preview.12 source but **not** in any published NuGet package as of June 2026.
- Custom `TOUCH_DBG` instrumentation that emits `[CEH] ...` lines via `OutputDebugStringW`, capturable with [DebugView](https://learn.microsoft.com/sysinternals/downloads/debugview).

## Why this is necessary

`react-native-windows` ships its native code as a **prebuilt NuGet package
(`Microsoft.ReactNative`)**. Editing the C++ files inside
`node_modules/react-native-windows/Microsoft.ReactNative/Fabric/...` does
**nothing** — those files are not compiled by the app. The app links against
the prebuilt DLL inside `~/.nuget/packages/microsoft.reactnative/<version>/runtimes/win10-x64/native/`.

So to actually change native behavior we need to:

1. Build a custom `Microsoft.ReactNative.dll` from RNW source.
2. Drop it into the NuGet cache, replacing the prebuilt DLL.

## Prerequisites

- Visual Studio 2022 with the **Desktop development with C++** workload, including:
  - MSVC v143 toolchain
  - C++/WinRT
  - Windows 11 SDK 10.0.26100.0 (or 10.0.22621.0)
- Node.js 22.x and Yarn (`npm install -g yarn`)
- Git (with `core.longpaths=true`; some RNW paths exceed 260 chars)
- ~10 GB free disk space

## Step-by-step build

### 1. Clone RNW at the desired tag

We used `react-native-windows_v0.84.0-preview.12` (the source tag that
contains PR #16139 + all earlier preview.11 fixes). For a different
target version, substitute the tag.

```bash
cd /tmp
git clone --depth 1 \
  --branch react-native-windows_v0.84.0-preview.12 \
  https://github.com/microsoft/react-native-windows.git rnw-source

cd rnw-source
git config core.longpaths true
git -c core.longpaths=true restore --source=HEAD :/
```

### 2. Apply the touch-debug instrumentation patch

Apply [`patched-rnw-binaries/touch-dbg-instrumentation.patch`](patched-rnw-binaries/touch-dbg-instrumentation.patch)
to `vnext/Microsoft.ReactNative/Fabric/Composition/CompositionEventHandler.cpp`:

```bash
patch -p1 < /path/to/touch-dbg-instrumentation.patch
```

The patch adds:

- A `TOUCH_DBG(fmt, ...)` macro near the top of the file that prepends `[CEH]`
  and routes through `OutputDebugStringW`.
- One-line `TOUCH_DBG` calls inside `onPointerPressed`, `onPointerReleased`,
  `onPointerCaptureLost`, and `onPointerRoutedAway`.

### 3. Install JS dependencies (skip postinstall)

```bash
cd /tmp/rnw-source
yarn install --ignore-scripts
```

The full postinstall fails on a fresh clone (it tries to do many monorepo
things). Skipping it is fine — we only need a few build artifacts.

### 4. Build the JS-side `react-native-windows` package (runs codegen)

```bash
cd /tmp/rnw-source
yarn lage build --to react-native-windows
```

This builds workspace packages in dependency order, including
`@react-native-windows/codegen`, then runs codegen which produces:

```
vnext/codegen/react/components/rnwcore/EventEmitters.h     (and friends)
```

Without this step, the C++ build fails with:

```
fatal error C1083: Cannot open include file: 'react/components/rnwcore/EventEmitters.h'
```

### 5. NuGet restore for the C++ solution

```bash
cd /tmp/rnw-source/vnext
"$MSBUILD" Microsoft.ReactNative.NewArch.sln /t:Restore \
  /p:Configuration=Release /p:Platform=x64 \
  /p:WindowsTargetPlatformVersion=10.0.26100.0 /m
```

`$MSBUILD` is at e.g. `C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\amd64\MSBuild.exe`.

This pulls Boost, fmt, and other native deps from nuget.org.

### 6. Build `Microsoft.ReactNative.dll`

```bash
cd /tmp/rnw-source/vnext
"$MSBUILD" Microsoft.ReactNative/Microsoft.ReactNative.vcxproj \
  /p:Configuration=Release /p:Platform=x64 \
  /p:WindowsTargetPlatformVersion=10.0.26100.0 \
  "/p:ReactNativeDir=C:\path\to\rnw-source\node_modules\react-native\\" \
  "/p:JSI_SourcePath=C:\path\to\rnw-source\node_modules\react-native\ReactCommon\jsi" \
  /m /v:minimal
```

Why these properties:

- `WindowsTargetPlatformVersion=10.0.26100.0` — RNW source defaults to
  10.0.22621.0; override it to whatever Windows SDK you have installed.
- `ReactNativeDir` — auto-detection by walking up to find `node_modules\react-native\package.json`
  fails when the source is checked out in a temp path; setting it explicitly avoids `\jsi\jsi.cpp` errors.
- `JSI_SourcePath` — same reason; otherwise `Microsoft.ReactNative.Cxx.vcxitems`
  references `$(JSI_SourcePath)\jsi\jsi.cpp` with an empty prefix.

Build takes 5–10 minutes depending on the machine. The output appears at:

```
vnext/target/x64/Release/Microsoft.ReactNative/Microsoft.ReactNative.dll
vnext/target/x64/Release/Microsoft.ReactNative/Microsoft.ReactNative.pdb
```

### 7. Override the NuGet cache binary

Replace the prebuilt DLL in the NuGet cache for the version your app
references. For an app that uses `react-native-windows@0.84.0-preview.11`:

```bash
cp ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/Microsoft.ReactNative.dll \
   ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/Microsoft.ReactNative.dll.bak

cp /tmp/rnw-source/vnext/target/x64/Release/Microsoft.ReactNative/Microsoft.ReactNative.dll \
   ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/Microsoft.ReactNative.dll

# Optional: replace the PDB too so debugging works
cp ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/Microsoft.ReactNative.pdb \
   ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/Microsoft.ReactNative.pdb.bak

cp /tmp/rnw-source/vnext/target/x64/Release/Microsoft.ReactNative/Microsoft.ReactNative.pdb \
   ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/Microsoft.ReactNative.pdb
```

A prebuilt DLL+PDB is committed to the repo at:

```
patched-rnw-binaries/0.84.0-preview.11-x64/
```

(stored via Git LFS due to the 181MB PDB).

Skipping the build and using the committed binaries is fine if you're
on the matching version.

### 8. Clean and rebuild your app

The app build caches files from the NuGet package — wipe its build outputs
so it picks up the replaced DLL:

```bash
cd /path/to/YourTouchApp
rm -rf windows/*/bin windows/*/obj
npx react-native run-windows --no-packager
```

Verify the deployed DLL has the right timestamp:

```bash
ls -la windows/YourApp.Package/bin/x64/Debug/AppX/YourApp/Microsoft.ReactNative.dll
```

Should be the timestamp from when you copied it into the NuGet cache.

## Verifying the patch is live

1. Start the app.
2. Run **DebugView** as Administrator with `Capture > Capture Win32` and
   `Capture > Capture Global Win32` both checked.
3. Tap or click anywhere on the app surface.
4. You should see lines like:

   ```
   [CEH] onPointerPressed pointerId=1 type=2 activeTouches=0
   [CEH] onPointerReleased pointerId=1 activeTouches=1
   ```

5. Touch-scroll a `FlatList` and you should see:

   ```
   [CEH] onPointerRoutedAway pointerId=2233 activeTouches=1
   ```

   That second line is the smoking gun for PR #16139: it's the event RN didn't
   handle in vanilla preview.11, which left a "zombie" touch in `m_activeTouches`
   and stuck Pressables in their pressed state.

## Reverting

To go back to the unpatched DLL:

```bash
cd ~/.nuget/packages/microsoft.reactnative/0.84.0-preview.11/runtimes/win10-x64/native/
mv Microsoft.ReactNative.dll.bak Microsoft.ReactNative.dll
mv Microsoft.ReactNative.pdb.bak Microsoft.ReactNative.pdb
```

Then clean+rebuild your app.

## Long-term plan

- Watch [npmjs.com/package/react-native-windows](https://www.npmjs.com/package/react-native-windows)
  for `0.84.0-preview.12` to be published. The GitHub tag exists since 2026-05-16
  but the npm + NuGet packages were never published. When they land, the
  upstream binary will already contain PR #16139 and this whole document
  becomes unnecessary (except for the `TOUCH_DBG` debug instrumentation).
- Same goes for `0.83.x` if a backport is ever published — or apply the same
  recipe against the v0.83.0 tag.

## Related upstream issues / PRs

- Issue [#16047](https://github.com/microsoft/react-native-windows/issues/16047) — Pressables stuck pressed after ScrollView touch-scroll.
- PR [#16082](https://github.com/microsoft/react-native-windows/pull/16082) — `AllocateTouchIdentifier()` (in v0.84.0-preview.11+).
- PR [#16100](https://github.com/microsoft/react-native-windows/pull/16100) — `IsPointerWithinInitialTree` + scoped `DispatchTouchEvent` (in v0.84.0-preview.11+).
- PR [#16139](https://github.com/microsoft/react-native-windows/pull/16139) — `PointerRoutedAway` (in v0.84.0-preview.12 source, **not in any published NuGet**).
