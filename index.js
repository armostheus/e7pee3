/**
 * @format
 */

// Apply RNW touch event patches BEFORE anything else loads RN modules.
// pressabilityPointerPatch MUST come first - it monkey-patches Pressability
// at prototype-level and needs to install before any <Pressable> renders.
import './pressabilityPointerPatch';
import './touchPatch';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
