import Link from "next/link"
import type { ReactNode } from "react"

type Props = {
  label?: string
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
}

export default function PageHeader({ label, title, children, actions }: Props) {
  return (
    <header className="mb-8 flex flex-col gap-4 md:mb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {label ? (
            <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 font-display text-[12px] font-bold text-[var(--accent)]">
              {label}
            </span>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2 sm:gap-3">{actions}</div> : null}
      </div>
      {title ? (
        <div className="font-display text-2xl font-extrabold tracking-tight leading-snug text-[var(--ink)] sm:text-3xl">
          {title}
        </div>
      ) : null}
      {children}
    </header>
  )
}

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-full border border-[var(--line)] bg-[var(--paper-raised)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--ink-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      {children}
    </Link>
  )
}
