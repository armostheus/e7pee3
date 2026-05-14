// TouchPressable.tsx
//
// Pure-pointer-event fallback for <Pressable>. Drop-in compatible with the
// subset of Pressable's API used by the touch repro app. Built for the case
// where pressabilityPointerPatch.ts does not fully solve the RNW Fabric
// finger-touch bug - in that scenario, B7 swaps `Pressable` -> `TouchPressable`
// in App.tsx.
//
// Uses only the W3C pointer events (onPointerDown / onPointerMove /
// onPointerUp / onPointerCancel / onPointerLeave) which are confirmed to fire
// reliably on RNW Composition for finger AND mouse AND pen.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type HitSlop = number | { top?: number; right?: number; bottom?: number; left?: number };

export type TouchPressableProps = {
  onPress?: (e: GestureResponderEvent) => void;
  onPressIn?: (e: GestureResponderEvent) => void;
  onPressOut?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  onLayout?: (e: any) => void;
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
  disabled?: boolean;
  hitSlop?: HitSlop;
  pressRetentionOffset?: number;
  longPressDelay?: number;
  accessibilityRole?: any;
  accessibilityLabel?: string;
  testID?: string;
  nativeID?: string;
};

const DEFAULT_LONG_PRESS_DELAY = 500;
const DEFAULT_TAP_SLOP = 10; // pixels - max drift to still count as a tap

function _slopBox(hitSlop: HitSlop | undefined): { t: number; r: number; b: number; l: number } {
  if (hitSlop == null) return { t: 0, r: 0, b: 0, l: 0 };
  if (typeof hitSlop === 'number') return { t: hitSlop, r: hitSlop, b: hitSlop, l: hitSlop };
  return {
    t: hitSlop.top ?? 0,
    r: hitSlop.right ?? 0,
    b: hitSlop.bottom ?? 0,
    l: hitSlop.left ?? 0,
  };
}

function _wrapAsResponderEvent(e: any): GestureResponderEvent {
  // The pointer event is already a SyntheticEvent. We just type-cast it for
  // the public callback signature. Pressability-style consumers only read
  // .nativeEvent / .target / .currentTarget / .timeStamp.
  return e as GestureResponderEvent;
}

export default function TouchPressable(props: TouchPressableProps): React.ReactElement {
  const {
    onPress,
    onPressIn,
    onPressOut,
    onLongPress,
    onLayout,
    style,
    children,
    disabled,
    hitSlop,
    pressRetentionOffset,
    longPressDelay = DEFAULT_LONG_PRESS_DELAY,
    accessibilityRole,
    accessibilityLabel,
    testID,
    nativeID,
  } = props;

  const [pressed, setPressed] = useState(false);

  // Refs (do not trigger re-render).
  const downRef = useRef<{
    active: boolean;
    pointerId: number | undefined;
    x: number;
    y: number;
    longPressFired: boolean;
  }>({ active: false, pointerId: undefined, x: 0, y: 0, longPressFired: false });
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tapSlop = useMemo<number>(() => {
    if (typeof pressRetentionOffset === 'number') return Math.max(pressRetentionOffset, DEFAULT_TAP_SLOP);
    return DEFAULT_TAP_SLOP;
  }, [pressRetentionOffset]);

  // Cleanup any pending long-press timer on unmount.
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current != null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const _xy = (e: any): { x: number; y: number } => {
    const ne = (e && e.nativeEvent) || {};
    return {
      x: ne.pageX != null ? ne.pageX : (ne.clientX != null ? ne.clientX : 0),
      y: ne.pageY != null ? ne.pageY : (ne.clientY != null ? ne.clientY : 0),
    };
  };

  const _isPrimaryButton = (e: any): boolean => {
    const b = e?.nativeEvent?.button;
    return b == null || b === 0;
  };

  const handleDown = useCallback((e: any) => {
    if (disabled) return;
    if (!_isPrimaryButton(e)) return;

    const ne = e?.nativeEvent || {};
    const { x, y } = _xy(e);
    downRef.current = {
      active: true,
      pointerId: ne.pointerId,
      x, y,
      longPressFired: false,
    };
    setPressed(true);
    if (onPressIn) {
      try { onPressIn(_wrapAsResponderEvent(e)); } catch (_) { /* swallow */ }
    }

    if (onLongPress) {
      cancelLongPress();
      longPressTimerRef.current = setTimeout(() => {
        if (downRef.current.active && !downRef.current.longPressFired) {
          downRef.current.longPressFired = true;
          try { onLongPress(_wrapAsResponderEvent(e)); } catch (_) { /* swallow */ }
        }
      }, longPressDelay);
    }
  }, [disabled, onPressIn, onLongPress, longPressDelay, cancelLongPress]);

  const handleMove = useCallback((e: any) => {
    if (!downRef.current.active) return;
    const { x, y } = _xy(e);
    const dx = x - downRef.current.x;
    const dy = y - downRef.current.y;
    if (Math.abs(dx) > tapSlop || Math.abs(dy) > tapSlop) {
      // Drifted out of slop - cancel the long-press timer; treat further events
      // as if we'd left the pressable. We keep pressed=true visually until the
      // user lifts; that matches Pressable's "press out" semantics.
      cancelLongPress();
    }
  }, [tapSlop, cancelLongPress]);

  const handleUp = useCallback((e: any) => {
    if (!downRef.current.active) return;
    const wasActive = downRef.current.active;
    const wasLongPress = downRef.current.longPressFired;
    const { x, y } = _xy(e);
    const dx = x - downRef.current.x;
    const dy = y - downRef.current.y;
    const insideSlop = Math.abs(dx) <= tapSlop && Math.abs(dy) <= tapSlop;

    downRef.current.active = false;
    downRef.current.pointerId = undefined;
    cancelLongPress();
    setPressed(false);

    if (onPressOut) {
      try { onPressOut(_wrapAsResponderEvent(e)); } catch (_) { /* swallow */ }
    }
    if (wasActive && insideSlop && !wasLongPress && onPress && !disabled) {
      try { onPress(_wrapAsResponderEvent(e)); } catch (_) { /* swallow */ }
    }
  }, [tapSlop, onPress, onPressOut, disabled, cancelLongPress]);

  const handleCancel = useCallback((e: any) => {
    if (!downRef.current.active) return;
    downRef.current.active = false;
    downRef.current.pointerId = undefined;
    cancelLongPress();
    setPressed(false);
    if (onPressOut) {
      try { onPressOut(_wrapAsResponderEvent(e)); } catch (_) { /* swallow */ }
    }
  }, [onPressOut, cancelLongPress]);

  const handleLeave = useCallback((e: any) => {
    // Only cancel if the pointer leaves while down AND has drifted past slop.
    // If still within slop we keep the press alive so Pressable-style
    // "leave then re-enter" works.
    if (!downRef.current.active) return;
    const { x, y } = _xy(e);
    const dx = x - downRef.current.x;
    const dy = y - downRef.current.y;
    if (Math.abs(dx) > tapSlop || Math.abs(dy) > tapSlop) {
      handleCancel(e);
    }
  }, [tapSlop, handleCancel]);

  // Resolve style and children, which may be functions of pressed state.
  const resolvedStyle = typeof style === 'function' ? style({ pressed }) : style;
  const resolvedChildren =
    typeof children === 'function' ? (children as any)({ pressed }) : children;

  // Inflate hit area via padding-style hitSlop. RN's <View> supports a
  // `hitSlop` prop natively so we forward it.
  const sb = _slopBox(hitSlop);
  const hitSlopProp = (sb.t || sb.r || sb.b || sb.l)
    ? { top: sb.t, right: sb.r, bottom: sb.b, left: sb.l }
    : undefined;

  return (
    <View
      style={[styles.root, resolvedStyle, disabled && styles.disabled]}
      onLayout={onLayout}
      hitSlop={hitSlopProp as any}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      nativeID={nativeID}
      // @ts-ignore - W3C pointer events are valid View props in RN >= 0.71
      onPointerDown={handleDown}
      // @ts-ignore
      onPointerMove={handleMove}
      // @ts-ignore
      onPointerUp={handleUp}
      // @ts-ignore
      onPointerCancel={handleCancel}
      // @ts-ignore
      onPointerLeave={handleLeave}
    >
      {resolvedChildren}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {},
  disabled: { opacity: 0.5 },
});
