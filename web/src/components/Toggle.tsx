interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}

export function Toggle({ checked, onChange, label, hint }: Props) {
  return (
    <div className="toggle-field">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="toggle-label">{label}</span>
      </label>
      {hint && <div className="toggle-hint">{hint}</div>}
    </div>
  );
}
