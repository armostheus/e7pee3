# Patched RNW Binaries

Prebuilt `Microsoft.ReactNative.dll` and `.pdb` for `react-native-windows`
with the touch zombie fix (PR #16139) and `[CEH]` debug instrumentation
applied on top of the upstream source.

## Contents

```
0.83.0-x64/                            ← For apps using react-native-windows@0.83.0
  Microsoft.ReactNative.dll            (~7MB)
  Microsoft.ReactNative.pdb            (NOT COMMITTED — gitignored, ~180MB. Build from source if needed.)

0.84.0-preview.11-x64/                 ← For apps using react-native-windows@0.84.0-preview.11
  Microsoft.ReactNative.dll            (~7MB)
  Microsoft.ReactNative.pdb            (NOT COMMITTED — gitignored, ~180MB. Build from source if needed.)

v0.83-touch-fix-full.patch             ← Source diff vs upstream v0.83.0
touch-dbg-instrumentation.patch        ← Source diff vs upstream v0.84.0-preview.11
```

**Note on PDBs:** the PDB files are 180MB each and not committed to this
repo (Salesforce GHE has no Git LFS). If you need PDBs for symbolicated
debugging, rebuild from source per [`../BUILD-PATCHED-RNW.md`](../BUILD-PATCHED-RNW.md)
or copy from the personal repo at github.com/armostheus/e7pee3 (which
does support LFS).

## How to use

See [`../RNW-TOUCH-FIX-PLAYBOOK.md`](../RNW-TOUCH-FIX-PLAYBOOK.md) and
[`../BUILD-PATCHED-RNW.md`](../BUILD-PATCHED-RNW.md).

Quick version: copy the `.dll` and `.pdb` for your version into
`~/.nuget/packages/microsoft.reactnative/<version>/runtimes/win10-x64/native/`,
then clean+rebuild your app.

## What's in the patches

Both patched DLLs contain:

- **PR [#16082](https://github.com/microsoft/react-native-windows/pull/16082)** — `AllocateTouchIdentifier()` to map Windows pointer IDs to JS-safe small ints
- **PR [#16100](https://github.com/microsoft/react-native-windows/pull/16100)** — Scoped `DispatchTouchEvent` per pointer + `IsPointerWithinInitialTree` + `onClick` for primary button
- **PR [#16139](https://github.com/microsoft/react-native-windows/pull/16139)** — `PointerRoutedAway` subscription that fixes the zombie-touch bug after scroll
- **`TOUCH_DBG`** macro that emits `[CEH]`-prefixed lines via `OutputDebugStringW`, capturable with [DebugView](https://learn.microsoft.com/sysinternals/downloads/debugview)

The 0.84 variant has all three PRs from upstream + just adds debug
instrumentation. The 0.83 variant has the upstream PRs backported via
wholesale file replacement of `CompositionEventHandler.cpp/.h` from
preview.12 source, with one v0.83-specific compatibility fix
(`ReactTaggedView::view()` is non-const in v0.83.0).

## Verifying a patched DLL is what you think it is

```bash
PDB="0.83.0-x64/Microsoft.ReactNative.pdb"
echo "Should be > 0:"
grep -aoc "onPointerRoutedAway" "$PDB"
grep -aoc "AllocateTouchIdentifier" "$PDB"
grep -aoc "IsPointerWithinInitialTree" "$PDB"
```

Vanilla upstream 0.83.0 binary returns 0 for all three — patched returns
nonzero counts.

## When to regenerate these binaries

- A new RNW version ships that we want to patch
- A new fix gets backported from upstream and we want to consolidate
- The committed binaries got corrupted

Recipe is in [`../BUILD-PATCHED-RNW.md`](../BUILD-PATCHED-RNW.md).
