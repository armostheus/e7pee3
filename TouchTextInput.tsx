// TouchTextInput.tsx
//
// Fallback for <TextInput> that uses TouchPressable + explicit .focus() to
// work around the RNW Fabric finger-touch bug where tapping a TextInput does
// not focus it. Unused in B6 - sits ready for B7 if pressabilityPointerPatch
// doesn't cover TextInput.

import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInput as TextInputType,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import TouchPressable from './TouchPressable';

export type TouchTextInputHandle = {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  isFocused: () => boolean;
};

export type TouchTextInputProps = TextInputProps & {
  containerStyle?: StyleProp<ViewStyle>;
};

const TouchTextInput = forwardRef<TouchTextInputHandle, TouchTextInputProps>(
  function TouchTextInput(props, ref) {
    const { containerStyle, style, editable, ...rest } = props;
    const innerRef = useRef<TextInputType | null>(null);

    useImperativeHandle(ref, () => ({
      focus: () => { innerRef.current?.focus(); },
      blur: () => { innerRef.current?.blur(); },
      clear: () => { innerRef.current?.clear(); },
      isFocused: () => innerRef.current?.isFocused() ?? false,
    }), []);

    return (
      <TouchPressable
        style={[styles.wrapper, containerStyle]}
        disabled={editable === false}
        onPress={() => {
          // .focus() on an already-focused TextInput is a no-op, so this is
          // safe for both finger taps (which is the broken-on-RNW path we are
          // fixing here) and mouse clicks (which already focus natively).
          try { innerRef.current?.focus(); } catch (_) { /* swallow */ }
        }}
      >
        <TextInput
          ref={innerRef as any}
          {...rest}
          editable={editable}
          style={[styles.input, style]}
        />
      </TouchPressable>
    );
  },
);

export default TouchTextInput;

const styles = StyleSheet.create({
  wrapper: {},
  input: {},
});
