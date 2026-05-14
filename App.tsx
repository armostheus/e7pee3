/**
 * Touch repro app - identical surface across RNW versions.
 * Only RNW_VERSION and THEME_COLOR change between TouchAppV80 / V81 / V82.
 *
 * B5 instrumentation: wraps Section 1 in a diagnostic View that captures
 * responder / touch / pointer events at every layer. Counts are surfaced in
 * Section 7 diagnostics so we can see exactly which events fire for finger
 * vs mouse on each RNW version.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clipboard,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableHighlight,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { touchPatch, rewriteTouchHistory } from './touchPatch';
import { pressabilityPointerPatch } from './pressabilityPointerPatch';

// =====================================================================
// PER-APP CONSTANTS (swap these in each project)
// =====================================================================
const RNW_VERSION = '0.84';
const THEME_COLOR = '#9933FF'; // purple
// =====================================================================

const GH: any = null;

const fabricEnabled = !!(global as any).nativeFabricUIManager;
const rnVersion = `${Platform.constants?.reactNativeVersion?.major ?? '?'}.${
  Platform.constants?.reactNativeVersion?.minor ?? '?'
}.${Platform.constants?.reactNativeVersion?.patch ?? '?'}`;

function ts() {
  return new Date().toISOString().slice(11, 23);
}

// Counter buckets for the diagnostic wrapper around Section 1.
type Counters = {
  resGrant: number;
  resMove: number;
  resRelease: number;
  resTerminate: number;
  touchStart: number;
  touchMove: number;
  touchEnd: number;
  touchCancel: number;
  ptrDown: number;
  ptrUp: number;
  ptrMove: number;
  ptrCancel: number;
};

const zeroCounters: Counters = {
  resGrant: 0,
  resMove: 0,
  resRelease: 0,
  resTerminate: 0,
  touchStart: 0,
  touchMove: 0,
  touchEnd: 0,
  touchCancel: 0,
  ptrDown: 0,
  ptrUp: 0,
  ptrMove: 0,
  ptrCancel: 0,
};

export default function App() {
  const [pressableTaps, setPressableTaps] = useState(0);
  const [pressableIn, setPressableIn] = useState(0);
  const [pressableOut, setPressableOut] = useState(0);
  const [touchableOpacityTaps, setTouchableOpacityTaps] = useState(0);
  const [touchableOpacityIn, setTouchableOpacityIn] = useState(0);
  const [touchableOpacityOut, setTouchableOpacityOut] = useState(0);
  const [touchableHighlightTaps, setTouchableHighlightTaps] = useState(0);
  const [touchableHighlightIn, setTouchableHighlightIn] = useState(0);
  const [touchableHighlightOut, setTouchableHighlightOut] = useState(0);
  const [longPressCount, setLongPressCount] = useState(0);
  const [textValue, setTextValue] = useState('');
  const [textFocused, setTextFocused] = useState(false);
  const [flatListTaps, setFlatListTaps] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [lastGesture, setLastGesture] = useState<string>('none');
  const [panDelta, setPanDelta] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [log, setLog] = useState<string[]>([]);

  // Counters are kept in a ref to avoid a render storm during finger drags.
  // We bump `tick` on rare-but-meaningful events (grant/release/start/end/down/up)
  // to force a re-render that picks up the new counter values from the ref.
  const counters = useRef<Counters>({ ...zeroCounters });
  const [tick, setTick] = useState(0);
  const forceRefresh = () => setTick(t => (t + 1) % 1_000_000_000);

  // B6: 1Hz heartbeat so the Section 7 diagnostics panel reflects live
  // pressabilityPointerPatch.stats counters without requiring user interaction.
  useEffect(() => {
    const id = setInterval(() => setTick(t => (t + 1) % 1_000_000_000), 1000);
    return () => clearInterval(id);
  }, []);

  const push = (line: string) =>
    setLog(prev => [`${ts()}  ${line}`, ...prev].slice(0, 120));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setLastGesture('PanResponder onGrant');
        push('PanResponder onGrant');
      },
      onPanResponderMove: (e, g) => {
        // Layer 2 of the touch patch: ensure the touchHistory timestamps in
        // THIS event are monotonic even if the global PanResponder static
        // method patch didn't fire (some forks call private fields directly).
        rewriteTouchHistory(e.nativeEvent && (e as any).touchHistory);
        setPanDelta({ x: Math.round(g.dx), y: Math.round(g.dy) });
      },
      onPanResponderRelease: (_e, g) => {
        setLastGesture(`PanResponder release dx=${Math.round(g.dx)} dy=${Math.round(g.dy)}`);
        push(`PanResponder release dx=${Math.round(g.dx)} dy=${Math.round(g.dy)}`);
      },
    }),
  ).current;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setScrollY(Math.round(e.nativeEvent.contentOffset.y));
  };

  const flatListData = useMemo(
    () => Array.from({ length: 50 }, (_, i) => ({ id: String(i), label: `Row ${i + 1}` })),
    [],
  );

  // ---- Helpers to label the input source on Pressable events ----------------
  function ptype(e: GestureResponderEvent): string {
    const ne: any = e.nativeEvent;
    return ne?.pointerType ?? '?';
  }

  // ---- Section 1 diagnostic wrapper handlers --------------------------------
  // These are attached to the View that wraps Pressable + TouchableOpacity +
  // TouchableHighlight. They fire in addition to the children's own onPress.
  const section1Handlers = {
    // Responder system
    onStartShouldSetResponder: () => false, // do not steal responder
    onResponderGrant: (_e: any) => {
      counters.current.resGrant += 1;
      push('S1 res:Grant');
      forceRefresh();
    },
    onResponderMove: (_e: any) => {
      counters.current.resMove += 1;
    },
    onResponderRelease: (_e: any) => {
      counters.current.resRelease += 1;
      push('S1 res:Release');
      forceRefresh();
    },
    onResponderTerminate: (_e: any) => {
      counters.current.resTerminate += 1;
      push('S1 res:Terminate');
      forceRefresh();
    },
    // Touch events
    onTouchStart: () => {
      counters.current.touchStart += 1;
      push('S1 touch:Start');
      forceRefresh();
    },
    onTouchMove: () => {
      counters.current.touchMove += 1;
    },
    onTouchEnd: () => {
      counters.current.touchEnd += 1;
      push('S1 touch:End');
      push('────────────────────────');
      forceRefresh();
    },
    onTouchCancel: () => {
      counters.current.touchCancel += 1;
      push('S1 touch:Cancel');
      forceRefresh();
    },
    // Pointer events (RN 0.71+)
    onPointerDown: (e: any) => {
      counters.current.ptrDown += 1;
      push(`S1 ptr:Down type=${e?.nativeEvent?.pointerType ?? '?'}`);
      forceRefresh();
    },
    onPointerUp: (e: any) => {
      counters.current.ptrUp += 1;
      push(`S1 ptr:Up type=${e?.nativeEvent?.pointerType ?? '?'}`);
      forceRefresh();
    },
    onPointerMove: () => {
      counters.current.ptrMove += 1;
    },
    onPointerCancel: () => {
      counters.current.ptrCancel += 1;
      push('S1 ptr:Cancel');
      forceRefresh();
    },
  } as any;

  const c = counters.current;

  const diagnostics = useMemo(() => {
    return [
      `RNW_VERSION (banner): ${RNW_VERSION}`,
      `Platform.OS: ${Platform.OS}`,
      `Platform.Version: ${String(Platform.Version)}`,
      `RN runtime version: ${rnVersion}`,
      `Fabric (nativeFabricUIManager): ${fabricEnabled}`,
      `touchPatch installed: ${touchPatch.installed} | panMoveCalls: ${touchPatch.panMoveCalls}`,
      `Pressability patch installed: ${String(pressabilityPointerPatch.installed)} (target=${pressabilityPointerPatch.target ?? 'none'})`,
      `Pressability grants: ${pressabilityPointerPatch.stats.grants}`,
      `Pressability releases: ${pressabilityPointerPatch.stats.releases}`,
      `Pressability moves: ${pressabilityPointerPatch.stats.moves} | terminates: ${pressabilityPointerPatch.stats.terminates}`,
      ``,
      `--- Section 1 wrapper counters (finger AND mouse) ---`,
      `responder grant=${c.resGrant} move=${c.resMove} release=${c.resRelease} terminate=${c.resTerminate}`,
      `touch     start=${c.touchStart} move=${c.touchMove} end=${c.touchEnd} cancel=${c.touchCancel}`,
      `pointer   down=${c.ptrDown}  move=${c.ptrMove}  up=${c.ptrUp}  cancel=${c.ptrCancel}`,
      ``,
      `--- Section 1 button onPress* counters ---`,
      `Pressable          in=${pressableIn} out=${pressableOut} press=${pressableTaps}`,
      `TouchableOpacity   in=${touchableOpacityIn} out=${touchableOpacityOut} press=${touchableOpacityTaps}`,
      `TouchableHighlight in=${touchableHighlightIn} out=${touchableHighlightOut} press=${touchableHighlightTaps}`,
      `LongPress count: ${longPressCount}`,
      ``,
      `FlatList row taps: ${flatListTaps}`,
      `ScrollView offsetY: ${scrollY}`,
      `TextInput focused: ${textFocused}`,
      `TextInput value: ${JSON.stringify(textValue)}`,
      `Last gesture: ${lastGesture}`,
      `Pan delta: dx=${panDelta.x} dy=${panDelta.y}`,
    ].join('\n');
  }, [
    tick,
    pressableTaps,
    pressableIn,
    pressableOut,
    touchableOpacityTaps,
    touchableOpacityIn,
    touchableOpacityOut,
    touchableHighlightTaps,
    touchableHighlightIn,
    touchableHighlightOut,
    longPressCount,
    flatListTaps,
    scrollY,
    textFocused,
    textValue,
    lastGesture,
    panDelta,
    c.resGrant,
    c.resMove,
    c.resRelease,
    c.resTerminate,
    c.touchStart,
    c.touchMove,
    c.touchEnd,
    c.touchCancel,
    c.ptrDown,
    c.ptrUp,
    c.ptrMove,
    c.ptrCancel,
  ]);

  const diagnosticsAndLog = `${diagnostics}\n\n--- EVENT LOG (newest first) ---\n${log.join('\n')}`;

  return (
    <View style={styles.root}>
      {/* Left panel: main components (60%) */}
      <ScrollView
        style={styles.leftPanel}
        contentContainerStyle={styles.scrollContent}
        onScroll={onScroll}
        scrollEventThrottle={16}>
        {/* Banner */}
        <View style={[styles.banner, { backgroundColor: THEME_COLOR }]}>
          <Text style={styles.bannerTitle}>Touch RNW {RNW_VERSION}</Text>
          <Text style={styles.bannerSub}>
            RN {rnVersion} | Fabric={String(fabricEnabled)} | OS={Platform.OS} | touchPatch={String(touchPatch.installed)} | pressPatch={String(pressabilityPointerPatch.installed)}
          </Text>
        </View>

        {/* Section 1: Buttons (wrapped in diagnostic View) */}
        <Section index={1} title="Pressable / TouchableOpacity / TouchableHighlight">
          <View {...section1Handlers} style={styles.diagWrapper}>
            <View style={styles.row}>
              <Pressable
                style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
                onPressIn={(e) => {
                  setPressableIn(c2 => c2 + 1);
                  push(`Pressable onPressIn pt=${ptype(e)}`);
                }}
                onPressOut={() => {
                  setPressableOut(c2 => c2 + 1);
                  push('Pressable onPressOut');
                }}
                onPress={() => {
                  setPressableTaps(c2 => c2 + 1);
                  push('Pressable onPress');
                }}
                onLongPress={() => {
                  setLongPressCount(c2 => c2 + 1);
                  push('Pressable onLongPress');
                }}>
                <Text style={styles.btnText}>Pressable ({pressableTaps})</Text>
              </Pressable>

              <TouchableOpacity
                style={styles.btn}
                onPressIn={() => {
                  setTouchableOpacityIn(c2 => c2 + 1);
                  push('TouchableOpacity onPressIn');
                }}
                onPressOut={() => {
                  setTouchableOpacityOut(c2 => c2 + 1);
                  push('TouchableOpacity onPressOut');
                }}
                onPress={() => {
                  setTouchableOpacityTaps(c2 => c2 + 1);
                  push('TouchableOpacity onPress');
                }}>
                <Text style={styles.btnText}>TouchableOpacity ({touchableOpacityTaps})</Text>
              </TouchableOpacity>

              <TouchableHighlight
                style={styles.btn}
                underlayColor="#999"
                onPressIn={() => {
                  setTouchableHighlightIn(c2 => c2 + 1);
                  push('TouchableHighlight onPressIn');
                }}
                onPressOut={() => {
                  setTouchableHighlightOut(c2 => c2 + 1);
                  push('TouchableHighlight onPressOut');
                }}
                onPress={() => {
                  setTouchableHighlightTaps(c2 => c2 + 1);
                  push('TouchableHighlight onPress');
                }}>
                <Text style={styles.btnText}>TouchableHighlight ({touchableHighlightTaps})</Text>
              </TouchableHighlight>
            </View>
            <Text style={styles.hint}>LongPress count: {longPressCount}</Text>
          </View>
        </Section>

        {/* Section 2: TextInput */}
        <Section index={2} title="TextInput (focus / typing)">
          <TextInput
            style={[styles.input, textFocused && styles.inputFocused]}
            placeholder="Type here..."
            value={textValue}
            onFocus={() => {
              setTextFocused(true);
              push('TextInput onFocus');
            }}
            onBlur={() => {
              setTextFocused(false);
              push('TextInput onBlur');
            }}
            onChangeText={t => {
              setTextValue(t);
              push(`TextInput onChangeText len=${t.length}`);
            }}
          />
          <Text style={styles.hint}>focused={String(textFocused)} | value={JSON.stringify(textValue)}</Text>
        </Section>

        {/* Section 3: FlatList of pressable rows */}
        <Section index={3} title="FlatList - 50 pressable rows">
          <View style={{ height: 200, borderWidth: 1, borderColor: '#ccc' }}>
            <FlatList
              data={flatListData}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [styles.flatRow, pressed && { backgroundColor: '#cce' }]}
                  onPress={() => {
                    setFlatListTaps(c2 => c2 + 1);
                    push(`FlatList tap ${item.label}`);
                    push('────────────────────────');
                  }}>
                  <Text>{item.label}</Text>
                </Pressable>
              )}
            />
          </View>
          <Text style={styles.hint}>FlatList row taps: {flatListTaps}</Text>
        </Section>

        {/* Section 4: PanResponder pan area */}
        <Section index={4} title="PanResponder pan / drag area">
          <View
            {...panResponder.panHandlers}
            style={styles.panArea}>
            <Text style={styles.panLabel}>
              Drag here. Last: {lastGesture}{'\n'}dx={panDelta.x}, dy={panDelta.y}
            </Text>
          </View>
        </Section>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Right panel: event log + diagnostics (40%) */}
      <View style={styles.rightPanel}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.sectionTitle}>Event Log ({log.length})</Text>
          <Pressable
            style={{ backgroundColor: '#1976D2', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 }}
            onPress={() => {
              Clipboard.setString(log.join('\n'));
              push('--- COPIED ---');
            }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>Copy Logs</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.logScroll}>
          {log.length === 0 ? (
            <Text style={styles.hint}>No events yet - tap something.</Text>
          ) : (
            log.map((l, i) => (
              <Text key={i} style={styles.logLine}>
                {l}
              </Text>
            ))
          )}
        </ScrollView>
        <Text style={[styles.sectionTitle, { marginTop: 8 }]}>Diagnostics</Text>
        <TextInput
          style={styles.diagBox}
          multiline
          editable={false}
          selectTextOnFocus
          value={diagnosticsAndLog}
        />
      </View>
    </View>
  );
}

function Section(props: { index: number; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {props.index}. {props.title}
      </Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#f4f4f4' },
  leftPanel: { width: '60%' },
  rightPanel: {
    width: '40%',
    borderLeftWidth: 1,
    borderLeftColor: '#ccc',
    backgroundColor: '#fafafa',
    padding: 8,
  },
  scrollContent: { padding: 12 },
  logScroll: { flex: 1, marginBottom: 4 },
  banner: { padding: 16, borderRadius: 8, marginBottom: 12 },
  bannerTitle: { color: '#fff', fontSize: 22, fontWeight: '700' },
  bannerSub: { color: '#fff', marginTop: 4, fontSize: 12 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  sectionTitle: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  diagWrapper: {
    borderWidth: 1,
    borderColor: '#a0c8ff',
    borderRadius: 4,
    padding: 6,
    backgroundColor: '#f4f8ff',
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: {
    backgroundColor: '#1976D2',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  btnPressed: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '600' },
  hint: { color: '#666', fontSize: 12, marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 36,
  },
  inputFocused: { borderColor: '#1976D2' },
  flatRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  panArea: {
    minHeight: 100,
    backgroundColor: '#eef',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  panLabel: { textAlign: 'center', color: '#333' },
  logLine: { fontFamily: 'Consolas', fontSize: 11, color: '#222' },
  diagBox: {
    flex: 1,
    fontFamily: 'Consolas',
    fontSize: 10,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 4,
    padding: 6,
    backgroundColor: '#fff',
    color: '#222',
    textAlignVertical: 'top',
  },
});
