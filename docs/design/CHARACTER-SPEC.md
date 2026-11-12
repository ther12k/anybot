# Tavi — proposed AnyBot character

**Status:** Original design proposal for the AnyBot redesign. Tavi is a working character name; this work does not establish trademark or name availability. AnyBot remains the product name.

## Design idea

Tavi is a soft, asymmetric apricot seed with a single folded sprout, tiny hands and feet, and cocoa eyes. The compact silhouette can sit beside a run status, in a conversation header, or at the center of the welcome screen. Warm color adds personality to a desktop tool; the distinct sprout and broad body remain recognizable at small sizes. The character is an interface companion, separate from an agent persona or model provider.

The character has been drawn directly as scalable SVG. It is a live component with stable groups for face, eyes, arms, sprout, body, and effects. No raster sprite sheet, external image, network request, or animation library is required.

## Palette

| Role | Color |
| --- | --- |
| Primary terracotta | `#D86A4F` |
| Apricot body | `#F6B08F` |
| Body highlight | `#FBD9BC` |
| Body shadow | `#E98C70` |
| Eyes and primary ink | `#322D29` |
| Canvas cream | `#FAF8F5` |
| Thought/listening accent | `#697C65` |

## Mood mapping

| Mood | Visual behavior | Suggested authoritative UI label | Trigger |
| --- | --- | --- | --- |
| `idle` | Slow breathing and occasional blink | Ready when you are | No active run |
| `listening` | Attentive lean and subtle listening arcs | Reading your request | Input interaction or local request submission; not a microphone indicator |
| `thinking` | Looking upward, three pulsing dots | Planning the next step | Provider request in progress |
| `working` | Alternating hand taps and small sprout movement | Working · [current tool] | Tool execution reported by the real runtime |
| `approval` | Raised hand, attentive brows, otherwise still | Your approval is needed | A specific action is awaiting a user decision |
| `success` | Happy eyes and one brief celebration | Task completed | Completion reported by the runtime, not merely received text |
| `error` | Concerned eyebrows and quiet mouth | Something needs attention | A recoverable failure with visible retry or explanation |
| `sleep` | Closed eyes and slow breathing | Paused | User explicitly pauses or idle companion mode |
| `wave` | One brief wave, then a still resting pose | Hello, I'm Tavi | Welcome screen or character preview |
| `offline` | Muted body color, lowered sprout | Provider unavailable | Connection unavailable; not a privacy guarantee |

Use `listening` as an expressive label only when its product text explains what is happening. AnyBot's reviewed feature set does not establish microphone capture; the arcs must never imply the microphone is active. Likewise, `offline` does not mean local inference is installed, working, or private.

## Motion rules

- Respect `prefers-reduced-motion: reduce`: all CSS animations stop, and each mood remains recognizable as a static pose.
- Approval and error poses do not loop or flash. The decision and recovery controls remain visually dominant.
- Success uses one short movement; do not continually celebrate while the user reads a result.
- Keep the mascot at approximately 28–40 px beside transcript status, 64–100 px in compact welcome panels, and 120–160 px for onboarding or character previews.
- At 24 px the eye pair and sprout carry recognition. Avoid presenting small thought dots as the only state cue.
- `wave` plays a single 1.4-second greeting and settles at rest. With reduced motion, it shows a still raised hand. The arm stays to the right of the facial features; the body and face remain still throughout the greeting.

## Accessibility and truthfulness

The host application must supply visible text for every actionable state. The character never replaces status text, an error message, a progress label, or an approval card. For decorative placement use `decorative={true}` (the default). For a standalone illustration use `decorative={false}` and a contextual `label`.

Do not derive mood from optimistic UI alone. The actual run state is authoritative. A friendly pose must not suggest permissions, successful execution, approval, offline guarantees, or security properties that the runtime has not confirmed.

## Browser integration

```html
<script src="character.js"></script>
<div id="buddy" aria-hidden="true"></div>
<script>
  buddy.innerHTML = AnyBotCharacter.svg('idle', 120, 'welcome-tavi');
  // Change mood without rebuilding the SVG tree:
  buddy.querySelector('svg').dataset.mood = 'approval';
</script>
```

`AnyBotCharacter.svg(mood, size, id)` returns a self-contained SVG string. `mood` is validated against the ten supported states; unsupported values become `idle`. `size` is clamped to 16–1024 px. Pass a unique `id` for each instance, or omit it to use the renderer's counter. Strings used in SVG IDs are sanitized. The browser renderer is decorative by default (`aria-hidden=true`) and does not expose a raw HTML parameter.

CSS is embedded in each browser SVG to simplify a zero-dependency mockup. For production, prefer the React component and the shared CSS file to avoid repeating the same stylesheet.

## React integration

```tsx
import { AnyBotCharacter, type TaviMood } from './AnyBotCharacter';

const mood: TaviMood = 'approval';

<AnyBotCharacter mood={mood} size={36} />
<span>Your approval is needed</span>

<AnyBotCharacter
  mood="wave"
  size={160}
  decorative={false}
  label="Tavi, your AnyBot companion, waving hello"
/>
```

`AnyBotCharacter.tsx` targets React 18 and later, uses `useId` to isolate gradients, and imports `character.css`. It has no animation dependency and uses actual JSX nodes rather than `dangerouslySetInnerHTML`. Place status updates in an appropriate host live region; do not repeatedly announce decorative animation.

## Files

- `character.js` — browser renderer, ten moods, embedded CSS.
- `AnyBotCharacter.tsx` — reusable React component with typed moods.
- `character.css` — shared CSS for React integration and motion preferences.
- `mascot-tavi.svg` — static, standalone idle illustration with no animation.
- `tavi-preview.png` — native SVG-rendered visual preview, not a browser screenshot.
- `tavi-character-sheet.svg` and `.png` — static ten-state overview; animated behavior is available in the live renderer.

## Validation

The browser script passes `node --check`. The standalone SVG was parsed and rendered with the native SVG renderer in Sharp; the visual was inspected at 640 px. All ten mood outputs parse as XML; ID uniqueness, unknown-state fallback, and reduced-motion CSS were checked. Mood transforms were visually checked in a nested SVG contact sheet and corrected to explicit SVG-space matrices. Final application integration and keyboard interactions are owned by the mockup host.

The React component passed a strict TypeScript no-emit compile against React 18 in the host workspace. Live moods were inspected in the interactive browser prototype. Native image rendering separately verifies static geometry. Production event wiring remains an integration task.
