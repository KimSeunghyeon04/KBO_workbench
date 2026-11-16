const paths = {
  first: "M4 3v10M12 3 6 8l6 5",
  previous: "m10 3-6 5 6 5",
  play: "m5 3 7 5-7 5Z",
  pause: "M5 3v10M11 3v10",
  next: "m6 3 6 5-6 5",
  last: "M12 3v10M4 3l6 5-6 5",
} as const;

export function PlaybackIcon({ name }: { readonly name: keyof typeof paths }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={paths[name]}
        fill={name === "play" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
