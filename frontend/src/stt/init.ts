// Side-effect-only imports that register every shipped STT adapter into
// the central registry at app startup. Must be imported once (and once
// only) from main.tsx BEFORE any code touches createRecognizer / listAdapters.
//
// Static imports (as opposed to dynamic import()) guarantee the adapter
// modules execute synchronously while this file loads — so by the time
// any consumer calls listAdapters(), every registerAdapter() side effect
// has already run. The previous dynamic-import bootstrap was racy: the
// adapter modules were still mid-load when getAdapter('wstream') was
// asked for one.

import './WebSpeechAdapter';
import './WstreamAdapter';
import './TransformersJsAdapter';
