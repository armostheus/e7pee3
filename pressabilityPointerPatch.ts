// pressabilityPointerPatch.ts
//
// PRIMARY FIX for RNW Fabric/New-Arch finger-touch bug (B6).
//
// Symptoms on RNW Fabric (mouse fine, finger broken):
//   - <Pressable>, <TouchableOpacity>, <TouchableHighlight> never fire onPress
//   - FlatList row Pressables never fire onPress
//   - TextInput tap-to-focus does not work
//
// Root cause: all of these route through `Pressability` (see
// react-native/Libraries/Pressability/Pressability.js). Pressability builds
// its event-handler bag in `_createEventHandlers()` and exposes it via the
// memoised `getEventHandlers()`. The bag installs RN responder-system
// handlers (onStartShouldSetResponder, onResponderGrant, onResponderMove,
// onResponderRelease, onResponderTerminate, ...). On RNW Composition/Fabric
// the responder pipeline does not deliver `onResponderGrant` /
// `onResponderRelease` for finger input - it only delivers them for mouse.
// (See microsoft/react-native-windows#14119 and #14798.)
//
// What works on RNW Composition: the W3C pointer events
//   onPointerDown / onPointerMove / onPointerUp / onPointerCancel
// fire reliably with `nativeEvent.pointerType` of "mouse" | "touch" | "pen".
//
// Fix (this file): at JS startup on Windows, monkey-patch
// `Pressability.prototype.getEventHandlers` so the bag it returns:
//   (a) returns `false` from `onStartShouldSetResponder` (kill the broken path)
//   (b) adds onPointerDown/Move/Up/Cancel handlers that wrap the W3C
//       PointerEvent into a synthetic GestureResponderEvent and CALL THE
//       ORIGINAL closures (onResponderGrant/onResponderMove/...). Those
//       closures are arrow-bound to the Pressability instance and drive its
//       state machine, so onPress fires correctly on every tap.
//
// MUST be imported BEFORE any RN-using module that might construct a
// Pressability (i.e. before App.tsx / before <Pressable> renders).

import { Platform } from 'react-native';

// --- shared global stats (visible from App.tsx diagnostics panel) -----------

type Stats = {
  grants: number;
  moves: number;
  releases: number;
  terminates: number;
};

const _stats: Stats = { grants: 0, moves: 0, releases: 0, terminates: 0 };

let _installed = false;
let _patchTarget: 'getEventHandlers' | '_createEventHandlers' | null = null;
let _warned = false;

function _warnOnce(msg: string): void {
  if (_warned) return;
  _warned = true;
  // eslint-disable-next-line no-console
  console.warn('[pressabilityPointerPatch] ' + msg);
}

// --- synthetic GestureResponderEvent --------------------------------------
//
// Pressability needs (at minimum):
//   - event.persist() : no-op (RN pooled events are gone, but legacy code calls it)
//   - event.currentTarget : host instance for `_responderID` and `.measure()`
//   - event.nativeEvent.timestamp : checked by PressabilityPerformanceEventEmitter
//   - event.nativeEvent.pageX / pageY : used by getTouchFromPressEvent fallback
//     when touches[] and changedTouches[] are empty
//
// Returning empty touches/changedTouches arrays makes the helper fall through
// to nativeEvent for the page coordinates - which is exactly what we want.

function _buildSynthetic(e: any): any {
  const ne = (e && e.nativeEvent) || {};
  const pid = ne.pointerId != null ? ne.pointerId : 0;
  const pageX = ne.pageX != null ? ne.pageX : (ne.clientX != null ? ne.clientX : 0);
  const pageY = ne.pageY != null ? ne.pageY : (ne.clientY != null ? ne.clientY : 0);
  const locX = ne.locationX != null ? ne.locationX : (ne.offsetX != null ? ne.offsetX : pageX);
  const locY = ne.locationY != null ? ne.locationY : (ne.offsetY != null ? ne.offsetY : pageY);
  const ts = ne.timestamp != null ? ne.timestamp : (e && e.timeStamp != null ? e.timeStamp : Date.now());
  return {
    persist: _noop,
    preventDefault: _noop,
    stopPropagation: _noop,
    target: e ? e.target : undefined,
    currentTarget: e ? e.currentTarget : undefined,
    timeStamp: ts,
    nativeEvent: {
      identifier: pid,
      pointerId: pid,
      pointerType: ne.pointerType,
      target: e ? e.target : undefined,
      locationX: locX,
      locationY: locY,
      pageX: pageX,
      pageY: pageY,
      timestamp: ts,
      touches: [],
      changedTouches: [],
    },
  };
}

function _noop(): void {
  /* intentionally empty */
}

// --- wrap one Pressability handler bag ------------------------------------

function _wrapHandlerBag(orig: any): any {
  // Per-instance closure state. Each wrapped bag is created once per
  // Pressability instance via the memoised getEventHandlers, so these locals
  // act as that instance's pointer-tracking state.
  let _down = false;
  let _pointerId: number | undefined;
  let _downX = 0;
  let _downY = 0;

  // Preserve any pre-existing pointer handlers the original bag installed
  // (e.g. onPointerEnter / onPointerLeave when hover-via-W3C feature flag is on).
  const origDown = orig.onPointerDown;
  const origMove = orig.onPointerMove;
  const origUp = orig.onPointerUp;
  const origCancel = orig.onPointerCancel;

  const wrapped: any = { ...orig };
  wrapped.__rnwPointerWrapped = true;

  // (a) kill the broken responder path
  wrapped.onStartShouldSetResponder = function (): boolean {
    return false;
  };

  // (b) drive the Pressability state machine off pointer events instead
  wrapped.onPointerDown = function (e: any): void {
    try {
      const ne = (e && e.nativeEvent) || {};
      // Ignore secondary buttons (mouse right/middle). undefined = touch/pen.
      if (ne.button != null && ne.button !== 0) {
        if (typeof origDown === 'function') {
          try { origDown(e); } catch (_) { /* swallow */ }
        }
        return;
      }
      _down = true;
      _pointerId = ne.pointerId;
      _downX = ne.pageX != null ? ne.pageX : (ne.clientX != null ? ne.clientX : 0);
      _downY = ne.pageY != null ? ne.pageY : (ne.clientY != null ? ne.clientY : 0);
      const syn = _buildSynthetic(e);
      if (typeof orig.onResponderGrant === 'function') {
        orig.onResponderGrant(syn);
        _stats.grants++;
      }
    } catch (err) {
      _warnOnce('onPointerDown wrapper threw: ' + ((err as any) && (err as any).message));
    }
    if (typeof origDown === 'function') {
      try { origDown(e); } catch (_) { /* swallow */ }
    }
  };

  wrapped.onPointerMove = function (e: any): void {
    try {
      if (_down) {
        const syn = _buildSynthetic(e);
        if (typeof orig.onResponderMove === 'function') {
          orig.onResponderMove(syn);
          _stats.moves++;
        }
      }
    } catch (err) {
      _warnOnce('onPointerMove wrapper threw: ' + ((err as any) && (err as any).message));
    }
    if (typeof origMove === 'function') {
      try { origMove(e); } catch (_) { /* swallow */ }
    }
  };

  wrapped.onPointerUp = function (e: any): void {
    try {
      if (_down) {
        _down = false;
        _pointerId = undefined;
        const syn = _buildSynthetic(e);
        if (typeof orig.onResponderRelease === 'function') {
          orig.onResponderRelease(syn);
          _stats.releases++;
        }
      }
    } catch (err) {
      _warnOnce('onPointerUp wrapper threw: ' + ((err as any) && (err as any).message));
    }
    if (typeof origUp === 'function') {
      try { origUp(e); } catch (_) { /* swallow */ }
    }
  };

  wrapped.onPointerCancel = function (e: any): void {
    try {
      if (_down) {
        _down = false;
        _pointerId = undefined;
        const syn = _buildSynthetic(e);
        if (typeof orig.onResponderTerminate === 'function') {
          orig.onResponderTerminate(syn);
          _stats.terminates++;
        }
      }
    } catch (err) {
      _warnOnce('onPointerCancel wrapper threw: ' + ((err as any) && (err as any).message));
    }
    if (typeof origCancel === 'function') {
      try { origCancel(e); } catch (_) { /* swallow */ }
    }
  };

  // Reference unused locals so TS doesn't strip them.
  void _pointerId; void _downX; void _downY;

  return wrapped;
}

// --- install ---------------------------------------------------------------

function _install(): void {
  if (Platform.OS !== 'windows') {
    return;
  }
  try {
    // Lazy-require so non-windows platforms don't pull this in at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: any = require('react-native/Libraries/Pressability/Pressability');
    const Pressability: any = mod && mod.default ? mod.default : mod;
    if (!Pressability || !Pressability.prototype) {
      _warnOnce('Pressability class not found at expected path');
      return;
    }
    const proto: any = Pressability.prototype;

    if (proto.__rnwPointerPatchInstalled === true) {
      _installed = true;
      return;
    }

    if (typeof proto.getEventHandlers === 'function') {
      const origGet = proto.getEventHandlers;
      proto.getEventHandlers = function (this: any) {
        const orig = origGet.call(this);
        if (!orig || orig.__rnwPointerWrapped === true) {
          return orig;
        }
        const wrapped = _wrapHandlerBag(orig);
        // Pressability.getEventHandlers() memoises into this._eventHandlers
        // (see Pressability.js). Overwrite that memo so the next call returns
        // the wrapped bag directly through the same code path.
        try { this._eventHandlers = wrapped; } catch (_) { /* swallow */ }
        return wrapped;
      };
      proto.__rnwPointerPatchInstalled = true;
      _installed = true;
      _patchTarget = 'getEventHandlers';
    } else if (typeof proto._createEventHandlers === 'function') {
      // Fallback for hypothetical RN versions that drop getEventHandlers.
      const origCreate = proto._createEventHandlers;
      proto._createEventHandlers = function (this: any) {
        const orig = origCreate.call(this);
        if (!orig || orig.__rnwPointerWrapped === true) {
          return orig;
        }
        return _wrapHandlerBag(orig);
      };
      proto.__rnwPointerPatchInstalled = true;
      _installed = true;
      _patchTarget = '_createEventHandlers';
    } else {
      _warnOnce('neither getEventHandlers nor _createEventHandlers found on Pressability.prototype');
    }
  } catch (err) {
    _warnOnce('install failed: ' + ((err as any) && (err as any).message));
  }
}

_install();

export const pressabilityPointerPatch = {
  get installed(): boolean {
    return _installed;
  },
  get target(): string | null {
    return _patchTarget;
  },
  get stats(): Stats {
    return _stats;
  },
};
