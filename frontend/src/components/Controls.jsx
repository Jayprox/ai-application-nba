// Small shared controls: pill groups, tabs, selects. All keyboard/screen-reader friendly.

/** A row of toggle pills; one value selected. options = [[value, label], ...] */
export function Pills({ label, value, options, onChange, size = 'md' }) {
  const pad = size === 'sm' ? 'h-9 px-3 text-sm' : 'h-10 px-4 text-[15px]';
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([v, text]) => {
        const on = v === value;
        return (
          <button key={String(v)} type="button" aria-pressed={on} onClick={() => onChange(v)}
            className={`${pad} cursor-pointer rounded-full border font-medium ${on ? 'border-accent bg-accent text-on-accent' : 'border-field bg-card text-ink hover:border-muted'}`}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** Underlined tabs (scope switcher). */
export function Tabs({ label, value, options, onChange }) {
  return (
    <div role="tablist" aria-label={label} className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      {options.map(([v, text]) => {
        const on = v === value;
        return (
          <button key={v} type="button" role="tab" aria-selected={on} onClick={() => onChange(v)}
            className={`-mb-px shrink-0 cursor-pointer border-b-[3px] px-4 py-2.5 text-[15px] font-semibold ${on ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function Select({ id, label, value, onChange, children, className = '' }) {
  return (
    <label htmlFor={id} className={`flex flex-col gap-1.5 text-[13px] font-semibold ${className}`}>
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-lg border border-field bg-card px-2.5 text-[15px] font-normal">
        {children}
      </select>
    </label>
  );
}

export const PageTitle = ({ children, eyebrow }) => (
  <div className="flex flex-col gap-1">
    {eyebrow && <div className="eyebrow">{eyebrow}</div>}
    <h1 className="m-0 font-display text-[34px] font-bold leading-tight sm:text-[44px]">{children}</h1>
  </div>
);
