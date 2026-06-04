# RNW Touch Fix Playbook

This document is a complete onboarding guide for the React Native Windows
zombie-touch fix. If you're a new engineer (or AI agent) joining this project,
read this top-to-bottom before doing anything.

---

## TL;DR

**The bug:** On RNW Fabric/Composition apps with touch input, after a user
touch-scrolls a `ScrollView`/`FlatList`, the `Pressable` they initially
touched stays visually stuck in its pressed state. Subsequent taps may also
mis-target or double-fire.

**The root cause:** WinAppSDK does NOT reliably fire `PointerCaptureLost`
when the OS hands a pointer over to an `InteractionTracker` for scrolling
(`VisualInteractionSource::TryRedirectForManipulation`). RN never learns the
touch ended, so a "zombie" `ActiveTouch` entry stays in
`CompositionEventHandler::m_activeTouches`. The Pressable JS-side never gets
an `onPressOut`/`onResponderTerminate`, so it stays pressed.

**The fix:** Subscribe to `InputPointerSource::PointerRoutedAway` (which
DOES fire reliably on the redirect codepath) and synthesize a touch-cancel
when it fires. This is upstream PR
[#16139](https://github.com/microsoft/react-native-windows/pull/16139).

**The catch that wasted us a day:** The native C++ code in RNW is shipped
as a **prebuilt NuGet binary** (`Microsoft.ReactNative.dll`). Editing
`node_modules/react-native-windows/Microsoft.ReactNative/Fabric/Composition/CompositionEventHandler.cpp`
**does nothing** — those files are not compiled by the app build. To
actually exercise PR #16139 (or any native patch), you must build a custom
DLL from source and override the NuGet cache.

**What's in this repo right now:**
- Working patched apps: `TouchAppV83/`, `TouchAppV84/`
- Prebuilt patched DLLs: `patched-rnw-binaries/0.83.0-x64/`,
  `patched-rnw-binaries/0.84.0-preview.11-x64/`
- Build recipe: [`BUILD-PATCHED-RNW.md`](BUILD-PATCHED-RNW.md)
- Source diff vs upstream: [`patched-rnw-binaries/touch-dbg-instrumentation.patch`](patched-rnw-binaries/touch-dbg-instrumentation.patch)

---

## Background — what each test bench is for

| App | RNW Version | Purpose |
|-----|-------------|---------|
| `TouchAppV80` | 0.80.6 | Reference: super broken, mouse works but no touch |
| `TouchAppV81` | 0.81.15 | Reference: still has stuck-pressed bug |
| `TouchAppV82` | 0.82.5 | Reference: even more broken |
| `TouchAppV83` | 0.83.0 (latest stable) | **Production target.** Patched DLL deployed. |
| `TouchAppV84` | 0.84.0-preview.11 (only preview that has #16100 + #16082) | First version where the fix worked end-to-end |

`V83` and `V84` are the only two that should run with the patched DLL.

---

## Architecture: the touch lifecycle

A complete tap goes through 6 layers. Understanding this is essential to
debug anything in this area.

### Layer 1: OS → Native C++ (`CompositionEventHandler`)

`InputPointerSource` events from WinAppSDK arrive at:

```
node_modules/react-native-windows/Microsoft.ReactNative/Fabric/Composition/CompositionEventHandler.cpp
```

Key methods:

| Method | When it fires |
|--------|--------------|
| `onPointerPressed` | Finger touches / mouse clicks |
| `onPointerMoved` | Finger drags / mouse moves |
| `onPointerReleased` | Finger lifts / mouse unclicks |
| `onPointerCaptureLost` | Another component / window steals the pointer |
| `onPointerRoutedAway` ⭐ | OS hands the pointer to another `InputPointerSource` (e.g. ScrollView's `InteractionTracker`). Added by PR #16139. |

`m_activeTouches` is a `std::map<PointerId, ActiveTouch>` tracking active
contacts. The bug is that vanilla RNW only cleans this map on `Released`
or `CaptureLost`, and **`CaptureLost` doesn't fire for scroll redirects**.

### Layer 2: C++ TouchEventEmitter

`CompositionEventHandler::DispatchTouchEvent()` calls
`emitter->onTouchStart` / `onTouchMove` / `onTouchEnd` / `onTouchCancel`.

These are defined in:
```
node_modules/react-native/ReactCommon/react/renderer/components/view/TouchEventEmitter.cpp
```

Each forwards to `dispatchEvent("touchStart", payload, ...)` which goes
into the Fabric event pipeline.

### Layer 3: Event type prefixing

`EventEmitter::dispatchEvent` (in
`node_modules/react-native/ReactCommon/react/renderer/core/EventEmitter.cpp`)
prepends `"top"` to event types. So `"touchEnd"` becomes `"topTouchEnd"`
in JS.

### Layer 4: React Renderer (Fabric) responder system

```
node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js
```

The responder system listens to `topTouchStart`/`topTouchEnd`/`topTouchCancel`
and converts them to:
- `onResponderGrant`
- `onResponderMove`
- `onResponderRelease` (from `topTouchEnd`)
- `onResponderTerminate` (from `topTouchCancel`)

These are dispatched to whichever component is currently the responder.

### Layer 5: Pressability state machine

```
node_modules/react-native/Libraries/Pressability/Pressability.js
```

This is what drives the visual pressed state:

```
NOT_RESPONDER
  → onResponderGrant → RESPONDER_GRANT signal
  → DELAY → RESPONDER_INACTIVE_PRESS_IN
  → after delayPressIn → RESPONDER_ACTIVE_PRESS_IN
     calls _activate() → onPressIn() → visual highlight

  → onResponderRelease → RESPONDER_RELEASE signal
     calls onPress() + _deactivate() → onPressOut() → visual unhighlight

  → onResponderTerminate → RESPONDER_TERMINATED signal
     calls _deactivate() → onPressOut() (NO onPress)
```

If `RESPONDER_TERMINATED` never fires, the row stays pressed forever.

### Layer 6: Pressable component

```
node_modules/react-native/Libraries/Components/Pressable/Pressable.js
```

Thin wrapper that passes `onPressIn`/`onPressOut`/`onPress` config to a
`Pressability` instance.

---

## How to verify the bug is present

If you're handed a fresh RNW app and want to confirm whether the bug is
there:

### Method 1: Visual verification (touch device required)

1. Build and deploy an MSIX of the app to an actual touch-screen Windows device.
2. Touch a `Pressable` row inside a `FlatList` → should highlight.
3. Without lifting, drag your finger up to scroll the list.
4. Lift your finger.
5. **Bug observed:** the row you initially touched stays highlighted indefinitely.

### Method 2: Inspect the prebuilt NuGet binary

Symbol presence indicates the fix is included:

```bash
PDB="$HOME/.nuget/packages/microsoft.reactnative/<VERSION>/runtimes/win10-x64/native/Microsoft.ReactNative.pdb"
echo "AllocateTouchIdentifier (PR #16082):"
grep -aoc "AllocateTouchIdentifier" "$PDB"
echo "IsPointerWithinInitialTree (PR #16100):"
grep -aoc "IsPointerWithinInitialTree" "$PDB"
echo "onPointerRoutedAway (PR #16139):"
grep -aoc "onPointerRoutedAway" "$PDB"
echo "Sanity (should be > 0):"
grep -aoc "CompositionEventHandler" "$PDB"
```

Status as of June 2026:

| Version | #16082 | #16100 | #16139 |
|---------|--------|--------|--------|
| 0.80.x  | ❌ | ❌ | ❌ |
| 0.81.x  | ❌ | ❌ | ❌ |
| 0.82.x  | ❌ | ❌ | ❌ |
| 0.83.0 (latest stable) | ❌ | ❌ | ❌ |
| 0.84.0-preview.11 | ✅ | ✅ | ❌ |
| 0.84.0-preview.12 | ✅ | ✅ | ✅ (source only — never published to npm/NuGet) |

### Method 3: DebugView log trace

After deploying a patched DLL with `TOUCH_DBG` instrumentation:
1. Run [DebugView](https://learn.microsoft.com/sysinternals/downloads/debugview)
   as Administrator.
2. Capture menu: enable `Capture Win32` and `Capture Global Win32`.
3. Touch-scroll the FlatList.
4. **You should see** `[CEH] onPointerRoutedAway pointerId=… activeTouches=…`
   when the OS hands the pointer to the InteractionTracker.
5. **You should NOT see** `onPointerCaptureLost` for that same pointerId on
   most hardware — confirming why the unpatched code never cleaned up.

---

## How to apply the fix to a new app

### Quick path: drop in a prebuilt DLL

If the app uses RNW 0.83.0 or 0.84.0-preview.11 and x64, the patched DLL
is already in `patched-rnw-binaries/`. Use it.

```bash
# For an app using react-native-windows@0.83.0:
DST="$HOME/.nuget/packages/microsoft.reactnative/0.83.0/runtimes/win10-x64/native"
cp "$DST/Microsoft.ReactNative.dll" "$DST/Microsoft.ReactNative.dll.bak"
cp patched-rnw-binaries/0.83.0-x64/Microsoft.ReactNative.dll "$DST/"
cp patched-rnw-binaries/0.83.0-x64/Microsoft.ReactNative.pdb "$DST/"

# Same pattern for 0.84.0-preview.11; substitute the version in the path.
```

Then clean and rebuild your app:

```bash
cd /path/to/YourApp
rm -rf windows/*/bin windows/*/obj
npx react-native run-windows --no-packager
```

Verify the deployed DLL has the timestamp from when you copied it:

```bash
ls -la windows/YourApp.Package/bin/x64/Debug/AppX/YourApp/Microsoft.ReactNative.dll
```

### SDK version override (only if your app pins 22621.0)

If your app's `.vcxproj` and `.wapproj` reference Windows SDK 10.0.22621.0
but you only have 10.0.26100.0 installed, override:

In `windows/<App>/<App>.vcxproj`:
```xml
<WindowsTargetPlatformVersion>10.0.26100.0</WindowsTargetPlatformVersion>
```

In `windows/<App>.Package/<App>.Package.wapproj`, inside the
`ReactNativeWindowsProps` PropertyGroup (BEFORE the `Microsoft.ReactNative.WindowsSdk.Default.props` import):
```xml
<WindowsTargetPlatformVersion>10.0.26100.0</WindowsTargetPlatformVersion>
<TargetPlatformVersion>10.0.26100.0</TargetPlatformVersion>
```

Both are needed — the `.vcxproj` uses `WindowsTargetPlatformVersion`,
the `.wapproj` uses `TargetPlatformVersion`.

### Slow path: rebuild the DLL from source

See [`BUILD-PATCHED-RNW.md`](BUILD-PATCHED-RNW.md). Required if:
- You need a different RNW version
- You need ARM64 instead of x64
- You want different debug instrumentation
- The committed prebuilt DLL is stale or corrupt

---

## How to verify the fix works after applying

### 1. Confirm DLL deployment

```bash
# After running the app build:
ls -la windows/<App>.Package/bin/x64/Debug/AppX/<App>/Microsoft.ReactNative.dll
# Timestamp should be your build/copy time, not the original NuGet timestamp.
```

### 2. DebugView smoke test

1. Run DebugView as admin with `Capture Win32` + `Capture Global Win32`.
2. Open the app.
3. Tap anywhere — you should see at least:
   ```
   [CEH] onPointerPressed pointerId=… type=… activeTouches=…
   [CEH] onPointerReleased pointerId=… activeTouches=1
   ```
4. Touch-scroll the FlatList — you should see:
   ```
   [CEH] onPointerRoutedAway pointerId=… activeTouches=1
   ```
   That's the smoking gun.

### 3. Visual test on touch hardware

Touch a row in the FlatList → start scrolling → lift finger.
The row that was initially touched should NOT stay highlighted.
Subsequent taps should target the correct row.

---

## When things go wrong: common pitfalls

### "I patched node_modules, why didn't anything change?"

You patched the wrong layer. The native `.cpp` files in `node_modules` are
**reference copies** — the actual code that runs is the prebuilt
`Microsoft.ReactNative.dll` from the NuGet cache. The JS files in
`node_modules` ARE used live, but the C++ files are not.

To verify what's actually in the running binary:
```bash
PDB=windows/<App>.Package/bin/x64/Debug/AppX/<App>/Microsoft.ReactNative.pdb
grep -aoc "onPointerRoutedAway" "$PDB"
# Should be > 0 if your patched DLL is deployed
```

### "DebugView shows no logs"

1. Are you running DebugView as Administrator? Required for capturing
   from packaged Windows apps.
2. Is `Capture > Capture Global Win32` checked? (Just `Capture Win32` is
   not enough for sandboxed apps.)
3. Is the deployed DLL actually our patched build?
   ```bash
   ls -la windows/<App>.Package/bin/x64/Debug/AppX/<App>/Microsoft.ReactNative.dll
   ```
   Timestamp should match your build/copy time.
4. Did you rebuild the app after copying the DLL into the NuGet cache?
   ```bash
   rm -rf windows/*/bin windows/*/obj
   npx react-native run-windows --no-packager
   ```

### "App crashes on launch with `PlatformConstants` TurboModule error"

The native binary doesn't match the JS bundle's expectations. Usually
caused by:
- The patched DLL was built against a different RN version than the one
  the JS bundle uses.
- The app's `node_modules` got reinstalled and the patched DLL didn't get
  copied back.

Fix: do a clean rebuild and re-copy the patched DLL.

### "Build error: Windows SDK 10.0.22621.0 not found"

Your machine has 10.0.26100.0 but the project hardcodes 22621.0. See "SDK
version override" above.

### "Build error: error MSB3774: Could not find SDK 'Microsoft.UniversalCRT.Debug, Version=10.0.22621.0'"

Same SDK issue but in the wapproj. The wapproj uses `TargetPlatformVersion`
(without `Windows` prefix). Set BOTH `WindowsTargetPlatformVersion` AND
`TargetPlatformVersion` in the wapproj's PropertyGroup.

### "Build error: Cannot open include file: 'react/components/rnwcore/EventEmitters.h'"

Codegen never ran. Run `yarn lage build --to react-native-windows` from
the RNW source root to generate the codegen output.

### "Build error: Cannot open source file: '\jsi\jsi.cpp'"

`$(JSI_SourcePath)` is empty. Pass it explicitly:
```bash
"/p:JSI_SourcePath=C:\path\to\rnw-source\node_modules\react-native\ReactCommon\jsi"
```

### "App still has the bug even though the patch should be there"

1. Verify the deployed DLL is yours (timestamp + PDB symbols, see above).
2. Verify `m_activeTouches` is the issue, not something else: in DebugView,
   touch-scroll the list. Confirm `onPointerRoutedAway` is logged. If it's
   NOT logged, the OS isn't routing the pointer away — your scroll might be
   too short to trigger `TryRedirectForManipulation`. Try a longer drag.
3. The visual stuck state could also be from JS-level patches we made
   earlier. Check if `node_modules/react-native/Libraries/Pressability/Pressability.js`
   has `[PRESS]` debug logs in it — those are leftover instrumentation
   from a previous experiment and may interfere if the patches aren't
   complete.

---

## Reverting

If you need to roll back to the unpatched DLL:

```bash
DST="$HOME/.nuget/packages/microsoft.reactnative/<VERSION>/runtimes/win10-x64/native"
mv "$DST/Microsoft.ReactNative.dll.bak" "$DST/Microsoft.ReactNative.dll"
mv "$DST/Microsoft.ReactNative.pdb.bak" "$DST/Microsoft.ReactNative.pdb"

cd /path/to/YourApp
rm -rf windows/*/bin windows/*/obj
npx react-native run-windows --no-packager
```

---

## Long-term plan

1. **Watch for upstream releases.** Check
   `npm view react-native-windows@0.84.0-preview.12` periodically. Once
   preview.12 ships to npm AND NuGet, you can drop our prebuilt DLLs and
   just `npm install react-native-windows@0.84.0-preview.12`. The
   `Microsoft.ReactNative` NuGet package gets published in lockstep with
   the npm package.

2. **Watch for a 0.83.x backport.** If Microsoft backports PR #16139
   to 0.83.x, replace our patched 0.83.0 DLL with the upstream one.

3. **Keep DebugView instrumentation.** Even after upstream lands, our
   `TOUCH_DBG` instrumentation is useful for diagnosing future
   touch issues. Reapply it on top of upstream when needed (see
   [`patched-rnw-binaries/touch-dbg-instrumentation.patch`](patched-rnw-binaries/touch-dbg-instrumentation.patch)).

4. **Apply to POS production app.** Once verified in this test bench,
   apply the same `patched-rnw-binaries/<version>-x64/Microsoft.ReactNative.dll`
   override to the actual POS app.

---

## Glossary

- **RNW** = react-native-windows
- **`m_activeTouches`** = `CompositionEventHandler`'s map of currently
  active touch points. Indexed by Windows pointer ID.
- **PointerId** = arbitrary integer assigned by Windows for each touch
  contact. Can be very large (e.g. 2233). Mouse is always 1.
- **Touch identifier** (in JS) = small integer [0–19] that JS expects.
  PR #16082 maps Windows PointerId → JS touch identifier via
  `AllocateTouchIdentifier()`.
- **InteractionTracker** = OS-level component WinAppSDK uses for inertial
  scrolling. Once the OS hands a pointer to it via
  `TryRedirectForManipulation`, the app stops getting `PointerMoved`/
  `PointerReleased` for that pointer.
- **InputPointerSource** = WinAppSDK abstraction over the input pipeline
  for an island. RNW subscribes to its events.
- **Fabric / Composition** = the new RN architecture on Windows; the only
  one that hits this bug. The old "Paper" architecture has different code.
- **Responder system** = RN's gesture arbitration. Touch events
  (`topTouchStart` etc.) trigger responder negotiation, which then fires
  `onResponderGrant`/`Release`/`Terminate`. Pressability listens to those.

---

## File index

```
POS-experiments/
├── BUILD-PATCHED-RNW.md         ← How to rebuild the DLL from source
├── PR-16139-manual-patch.md     ← Just the PR #16139 source diff (older doc)
├── RNW-TOUCH-FIX-PLAYBOOK.md    ← This file
├── patched-rnw-binaries/
│   ├── 0.83.0-x64/
│   │   ├── Microsoft.ReactNative.dll  (LFS, ~7MB)
│   │   └── Microsoft.ReactNative.pdb  (LFS, ~180MB)
│   ├── 0.84.0-preview.11-x64/
│   │   ├── Microsoft.ReactNative.dll  (LFS)
│   │   └── Microsoft.ReactNative.pdb  (LFS)
│   └── touch-dbg-instrumentation.patch  ← Source diff for the patches
├── TouchAppV83/                 ← Production target test bench (latest stable)
└── TouchAppV84/                 ← First version where the fix worked
```

---

## If you're an AI agent reading this for the first time

Your most useful commands at the start of a session:

```bash
# What state are the test apps in?
ls c:/Users/shubham.chakraborty/Desktop/SalesforceCodebase/POS/Vardan/POS-experiments/

# Are the patched binaries committed?
ls c:/Users/shubham.chakraborty/Desktop/SalesforceCodebase/POS/Vardan/POS-experiments/patched-rnw-binaries/

# Is the patched DLL currently in the V83 NuGet cache?
ls -la "$HOME/.nuget/packages/microsoft.reactnative/0.83.0/runtimes/win10-x64/native/Microsoft.ReactNative.dll"
# (Compare timestamp with patched-rnw-binaries/0.83.0-x64/Microsoft.ReactNative.dll)

# Does the running binary contain the fix?
grep -aoc "onPointerRoutedAway" "$HOME/.nuget/packages/microsoft.reactnative/0.83.0/runtimes/win10-x64/native/Microsoft.ReactNative.pdb"
# Should be > 0
```

When in doubt:
- **Do not patch `node_modules` C++ files** — they are not compiled.
- **The fix is in the DLL, not the source code in node_modules.**
- **Always verify with DebugView after any change.**
- **The two-document set is `BUILD-PATCHED-RNW.md` (mechanics) and this
  file (concepts + troubleshooting).** Read both.
