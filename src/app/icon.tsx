type Name = 'wardrobe' | 'plus' | 'lock' | 'arrow' | 'camera' | 'photo' | 'refresh' | 'chevron' | 'close' | 'check' | 'user';
const paths: Record<Name, string> = {
  wardrobe: 'M5 21V4h14v17M12 4v17M3 21h18M9 11v3m6-3v3',
  plus: 'M12 5v14M5 12h14',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
  arrow: 'M19 12H5m6-6-6 6 6 6',
  camera: 'M4 7h4l2-3h4l2 3h4v13H4zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  photo: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M14 8h.01',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  chevron: 'm6 9 6 6 6-6',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
};
export function Icon({ name, className = '' }: { name: Name; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function WardrobeIllustration() {
  return (
    <svg className="wardrobe-illustration" viewBox="0 0 440 390" aria-hidden="true">
      <ellipse cx="220" cy="354" rx="160" ry="11" fill="#DDD8CD" />
      <rect x="81" y="39" width="278" height="310" rx="5" fill="#E8E4D9" />
      <path d="M105 337V60h230v277M220 60v277" fill="none" stroke="#BDB9AB" strokeWidth="3" />
      <path d="M96 337v18m248-18v18M118 94h92M233 94h89" stroke="#59665F" strokeWidth="4" strokeLinecap="round" />
      <path d="m159 91 3-6c4-7 15-2 10 5l-6 5-35 20h70l-35-20" fill="none" stroke="#A45E45" strokeWidth="2.6" strokeLinejoin="round" />
      <path d="m140 109-27 19-14 48 27 9 11-25-1 98h62l-1-98 11 25 27-9-14-48-27-19-18 10-18-10Z" fill="#6D8172" />
      <path d="m153 109 14 12 15-12m-16 13v132" fill="none" stroke="#4E6457" strokeWidth="2" />
      <path d="M149 153h-9v18h15m22-18h10v18h-14" fill="none" stroke="#9FAE9F" strokeWidth="2" />
      <path d="m260 91 3-6c4-7 15-2 10 5l-6 5-30 20h60l-30-20" fill="none" stroke="#A45E45" strokeWidth="2.6" strokeLinejoin="round" />
      <path d="m242 115 20-7 20 7 17 18-11 27-9-10 1 81h-42l1-81-9 10-11-27Z" fill="#D3B5A0" />
      <path d="M251 115q11 14 22 0M243 225h31" stroke="#B6917E" strokeWidth="2" fill="none" />
      <path d="M233 270h89M119 298h90" stroke="#BDB9AB" strokeWidth="3" />
      <rect x="244" y="283" width="62" height="39" rx="3" fill="#F5F1E7" />
      <path d="M255 295h40M255 302h40" stroke="#D0C8B8" strokeWidth="2" />
      <path d="M138 314q-7-13 6-18l21 5 8 17h-35Zm35 4 24-2q4 9-4 9h-54v-7" fill="#A68067" />
      <path d="M54 348v-63m0 35q-24-1-25-21 24 1 25 21m0-20q24-3 25-23-24 4-25 23" fill="none" stroke="#718472" strokeWidth="4" strokeLinecap="round" />
      <path d="M37 330h35l-5 23H42Z" fill="#C9957E" />
      <path d="M378 101v105m-11-99h22m-15 4v86m8-86v86" stroke="#CBC3B4" strokeWidth="3" />
    </svg>
  );
}
