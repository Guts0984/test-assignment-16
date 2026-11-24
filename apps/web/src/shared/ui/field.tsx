import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react';

/** A labelled field with its error shown right under it (forms show errors at the fields). */
export const Field = ({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) => {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy: error === undefined ? undefined : errId, invalid: error !== undefined })}
      {hint !== undefined && error === undefined && (
        <span className="text-xs text-[var(--muted)]">{hint}</span>
      )}
      {error !== undefined && (
        <span id={errId} role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </span>
      )}
    </div>
  );
};

const input =
  'min-h-11 rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm aria-[invalid=true]:border-[var(--danger)]';

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(({ invalid, className = '', ...p }, ref) => (
  <input ref={ref} aria-invalid={invalid === true} className={`${input} ${className}`} {...p} />
));
TextInput.displayName = 'TextInput';

export const SelectInput = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(({ invalid, className = '', ...p }, ref) => (
  <select ref={ref} aria-invalid={invalid === true} className={`${input} ${className}`} {...p} />
));
SelectInput.displayName = 'SelectInput';

export const CheckboxInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>((p, ref) => (
  <input ref={ref} type="checkbox" className="size-5" {...p} />
));
CheckboxInput.displayName = 'CheckboxInput';
