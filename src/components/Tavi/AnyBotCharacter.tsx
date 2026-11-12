import React, { useId } from 'react';
import './character.css';

export const TAVI_MOODS = ['idle', 'listening', 'thinking', 'working', 'approval', 'success', 'error', 'sleep', 'wave', 'offline'] as const;
export type TaviMood = typeof TAVI_MOODS[number];
export type AnyBotCharacterProps = {
  mood?: TaviMood;
  size?: number;
  /** Default true. Place visible product status outside the character. */
  decorative?: boolean;
  /** Required context should be expressed here when decorative is false. */
  label?: string;
  className?: string;
};

export function AnyBotCharacter({ mood = 'idle', size = 120, decorative = true, label, className = '' }: AnyBotCharacterProps) {
  const uid = 'tavi-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const safeSize = Number.isFinite(size) ? Math.max(16, Math.min(1024, size)) : 120;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={`anybot-tavi ${className}`}
      data-mood={mood}
      width={safeSize}
      height={safeSize}
      viewBox="0 0 160 160"
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : (label || `Tavi: ${mood}`)}
      focusable="false"
    >
<defs>
 <linearGradient id={`${uid}-body`} x1=".15" y1="0" x2=".9" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stopColor="#FBD9BC"/><stop offset=".5" stopColor="#F6B08F"/><stop offset="1" stopColor="#E98C70"/></linearGradient>
 <linearGradient id={`${uid}-limb`} x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="#F6B08F"/><stop offset="1" stopColor="#D86A4F"/></linearGradient>
 <linearGradient id={`${uid}-leaf`} x1="0" y1="1" x2="1" y2="0" gradientUnits="objectBoundingBox"><stop stopColor="#D86A4F"/><stop offset="1" stopColor="#F3A183"/></linearGradient>
</defs>
<ellipse cx="82" cy="146" rx="37" ry="5" fill="#322D29" opacity=".08"/>
<g className="tavi-body">
 <g className="tavi-feet" fill="#D8795B"><path d="M53 126C49 132 48 140 53 143C58 146 67 144 69 139L71 129Z"/><path d="M94 128L96 139C98 145 109 146 113 142C117 139 111 130 107 126Z"/></g>
 <g className="tavi-left-arm"><path d="M40 81C31 82 20 95 21 103C22 109 28 111 33 107L46 94" fill={`url(#${uid}-limb)`} stroke="#D77C5E" strokeWidth="1.2"/><path d="M26 99L30 101" stroke="#CE7358" strokeWidth="1.6" strokeLinecap="round"/></g>
 <g className="tavi-right-arm"><path d="M119 81C129 82 141 91 141 100C142 107 136 111 130 106L116 94" fill={`url(#${uid}-limb)`} stroke="#D77C5E" strokeWidth="1.2"/><path d="M133 99L137 97" stroke="#CE7358" strokeWidth="1.6" strokeLinecap="round"/></g>
 <g className="tavi-leaf"><path d="M94 46C87 30 100 15 124 16C122 36 109 48 94 46Z" fill={`url(#${uid}-leaf)`} stroke="#D8795B" strokeWidth="1.1"/><path d="M98 41C103 33 111 26 119 21" fill="none" stroke="#FBC5A8" strokeWidth="1.8" strokeLinecap="round"/><path d="M96 43C98 35 96 32 94 30" fill="none" stroke="#C9684C" strokeWidth="1.2" opacity=".55"/></g>
 <path d="M48 44C32 54 29 76 33 101C37 127 57 140 84 138C113 136 131 119 132 93C133 70 120 49 105 44C96 41 89 46 82 42C70 35 58 37 48 44Z" fill={`url(#${uid}-body)`} stroke="#DE9274" strokeWidth="1.2"/>
 <path d="M43 65C46 51 57 44 70 44" fill="none" stroke="#FFF3E8" strokeWidth="4" strokeLinecap="round" opacity=".65"/>
 <path d="M45 119C55 130 66 133 80 132" fill="none" stroke="#FBD7C0" strokeWidth="2" strokeLinecap="round" opacity=".36"/>
 <ellipse cx="48" cy="98" rx="8" ry="4.3" fill="#E9816E" opacity=".34"/>
 <ellipse cx="110" cy="95" rx="8" ry="4.3" fill="#E9816E" opacity=".34"/>
 <g className="tavi-eyes">
  <g className="tavi-eyes-open" fill="#322D29"><ellipse cx="63" cy="84" rx="6.7" ry="9.4"/><ellipse cx="96" cy="82" rx="6.7" ry="9.4"/><ellipse cx="65" cy="80.5" rx="1.7" ry="2.2" fill="#FFF4E9" opacity=".9"/><ellipse cx="98" cy="78.5" rx="1.7" ry="2.2" fill="#FFF4E9" opacity=".9"/></g>
  <g className="tavi-eyes-sleep" fill="none" stroke="#322D29" strokeWidth="3.5" strokeLinecap="round"><path d="M56 86Q63 91 70 85"/><path d="M89 84Q96 89 103 83"/></g>
  <g className="tavi-eyes-happy" fill="none" stroke="#322D29" strokeWidth="3.5" strokeLinecap="round"><path d="M56 86Q63 75 70 85"/><path d="M89 84Q96 73 103 83"/></g>
 </g>
 <g className="tavi-brows" fill="none" stroke="#754532" strokeWidth="2.5" strokeLinecap="round"><path d="M57 69L66 66"/><path d="M94 64L103 67"/></g>
 <path className="tavi-mouth" d="M72 102Q82 110 91 100" fill="none" stroke="#713F2F" strokeWidth="3.1" strokeLinecap="round"/>
 <path className="tavi-mouth-worried" d="M76 104Q82 101 88 103" fill="none" stroke="#713F2F" strokeWidth="3" strokeLinecap="round"/>
 <circle className="tavi-sleep-dot" cx="89" cy="106" r="3" fill="#FCE8D5" stroke="#D58C70" strokeWidth="1"/>
</g>
<g className="tavi-thoughts" fill="#697C65"><circle cx="26" cy="48" r="3"/><circle cx="22" cy="37" r="4"/><circle cx="24" cy="22" r="5"/></g>
<g className="tavi-listening-ring" fill="none" stroke="#697C65" strokeWidth="2.4" strokeLinecap="round"><path d="M18 66Q12 77 16 89"/><path d="M10 61Q2 77 8 94"/></g>
<g className="tavi-sparkles" fill="#D86A4F"><path d="M26 29L28 36L35 38L28 40L26 47L24 40L17 38L24 36Z"/><path d="M142 47L144 53L150 55L144 57L142 63L140 57L134 55L140 53Z"/><circle cx="137" cy="26" r="2.5" fill="#697C65"/></g>
    </svg>
  );
}
export default AnyBotCharacter;
