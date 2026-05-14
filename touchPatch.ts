// touchPatch.ts
//
// Workaround for react-native-windows issue #14119:
//   "PanResponder / Responder don't appear to work on New Architecture"
//
// Root cause (identified Dec 2025 in that issue): RN's native side stamps touch
// events with Date.now(), which has 1ms precision. Two consecutive touch frames
// can therefore share an identical timeStamp, so PanResponder._updateGestureStateOnMove
// sees a zero-duration delta and concludes no movement occurred.
//
// This module monkey-patches PanResponder._updateGestureStateOnMove so that the
// touchHistory it receives is rewritten with monotonically increasing timestamps
// derived from performance.now(). The fix is idempotent and a no-op on platforms
// where the original timestamps are already monotonic.
//
// MUST be imported BEFORE anything else in index.js so the patch is installed
// before any component subscribes to PanResponder behavior.

import { PanResponder } from 'react-native';

// Some runtimes do not have performance.now; fall back to Date.now in that case.
const _perf: { now(): number } =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance
    : { now: () => Date.now() };

let _lastStamp = 0;
function _monotonicTimestamp(): number {
  let t = Math.floor(_perf.now() * 100); // sub-millisecond precision
  if (t <= _lastStamp) t = _lastStamp + 1;
  _lastStamp = t;
  return t;
}

export function rewriteTouchHistory(touchHistory: any): void {
  if (!touchHistory) return;
  const t = _monotonicTimestamp();
  const prev = touchHistory.mostRecentTimeStamp;
  touchHistory.mostRecentTimeStamp = t;
  const bank = touchHistory.touchBank;
  if (bank && Array.isArray(bank)) {
    for (const r of bank) {
      if (!r) continue;
      r.previousTimeStamp = prev != null ? prev : t;
      r.currentTimeStamp = t;
    }
  }
}

// ---- Install: patch PanResponder._updateGestureStateOnMove ------------------

const _PR = PanResponder as any;
let _installed = false;
let _panMoveCalls = 0;

if (typeof _PR._updateGestureStateOnMove === 'function' && !_PR.__touchPatchInstalled) {
  const _orig = _PR._updateGestureStateOnMove;
  _PR._updateGestureStateOnMove = function (gestureState: any, touchHistory: any) {
    rewriteTouchHistory(touchHistory);
    _panMoveCalls += 1;
    return _orig.call(this, gestureState, touchHistory);
  };
  _PR.__touchPatchInstalled = true;
  _installed = true;
}

export const touchPatch = {
  get installed(): boolean {
    return _installed || _PR.__touchPatchInstalled === true;
  },
  get panMoveCalls(): number {
    return _panMoveCalls;
  },
  rewriteTouchHistory,
};
