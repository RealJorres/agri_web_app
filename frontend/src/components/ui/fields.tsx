import clsx from 'clsx'
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

const control =
  'block w-full rounded-md border bg-white px-3 py-2 text-sm text-ink placeholder:text-slate-500 ' +
  'disabled:bg-slate-100 aria-[invalid=true]:border-red-700'

interface FieldProps {
  label: string
  hint?: ReactNode
  error?: string | undefined
  required?: boolean
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
  className?: string
}

/** Label + control + hint/error, wired for screen readers (aria-describedby, aria-invalid). */
export function Field({ label, hint, error, required, children, className }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className={clsx('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required ? (
          <span className="text-red-700" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}

type Common = { label: string; hint?: ReactNode; error?: string | undefined; className?: string }

export function TextInput({
  label,
  hint,
  error,
  className,
  required,
  ref,
  ...props
}: Common & InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          ref={ref}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          aria-required={required}
          className={clsx(control, 'border-slate-300')}
          {...props}
        />
      )}
    </Field>
  )
}

export function SelectInput({
  label,
  hint,
  error,
  className,
  required,
  children,
  ref,
  ...props
}: Common & SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          ref={ref}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          aria-required={required}
          className={clsx(control, 'border-slate-300')}
          {...props}
        >
          {children}
        </select>
      )}
    </Field>
  )
}

export function TextArea({
  label,
  hint,
  error,
  className,
  required,
  ref,
  ...props
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          ref={ref}
          rows={3}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          className={clsx(control, 'border-slate-300')}
          {...props}
        />
      )}
    </Field>
  )
}

export function Checkbox({
  label,
  error,
  ref,
  ...props
}: { label: ReactNode; error?: string | undefined } & InputHTMLAttributes<HTMLInputElement> & {
    ref?: Ref<HTMLInputElement>
  }) {
  const id = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <input
          id={id}
          ref={ref}
          type="checkbox"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className="mt-0.5 h-4 w-4 rounded border-slate-400 accent-brand-700"
          {...props}
        />
        <label htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
