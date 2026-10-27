'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid, Inbox, ClipboardCheck, Target, Map, Send, Plug, Users, LogOut, ListChecks, type LucideIcon } from 'lucide-react'

type NavItem = { href: string; label: string; icon: LucideIcon }

const NAV: { heading: string | null; items: NavItem[] }[] = [
  {
    heading: null,
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutGrid },
      { href: '/leads',     label: 'Leads',    icon: Inbox },
      { href: '/approvals', label: 'Approvals', icon: ClipboardCheck },
    ],
  },
  {
    heading: 'Configure',
    items: [
      { href: '/ideal-customer', label: 'Ideal customer',     icon: Target },
      { href: '/reps',           label: 'Reps & territories', icon: Map },
      { href: '/outreach',       label: 'Outreach',           icon: Send },
      { href: '/settings',       label: 'Connections',        icon: Plug },
      { href: '/team',           label: 'Team',               icon: Users },
    ],
  },
]

type Props = { workspaceName: string; email: string | null; role: 'admin' | 'member'; setupPending?: boolean }

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'W'
}

export function SidebarNav({ workspaceName, email, role, setupPending = false }: Props) {
  const pathname = usePathname()

  return (
    <aside
      className="fixed left-0 top-0 h-screen w-60 z-40 flex flex-col border-r"
      style={{ background: 'var(--apple-bg-sidebar)', borderColor: 'var(--apple-separator)' }}
    >
      {/* Workspace */}
      <div className="h-14 px-4 flex items-center gap-2.5 border-b" style={{ borderColor: 'var(--apple-separator)' }}>
        <div
          className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
          style={{ background: 'var(--ink)' }}
          aria-hidden="true"
        >
          {initials(workspaceName)}
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-tight truncate" style={{ color: 'var(--apple-text-primary)' }}>
            {workspaceName}
          </div>
          <div className="text-[11px] leading-tight" style={{ color: 'var(--apple-text-tertiary)' }}>GTM Autopilot</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-5 overflow-y-auto" aria-label="Main">
        {setupPending && (
          <Link href="/setup"
            className="flex items-center gap-2.5 h-9 px-2.5 rounded-[6px] text-[13px] font-medium border bg-white hover:bg-[color:var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--apple-text-primary)' }}>
            <ListChecks className="w-4 h-4 flex-shrink-0" strokeWidth={2} aria-hidden="true" />
            Finish setup
          </Link>
        )}
        {NAV.map(group => (
          <div key={group.heading ?? 'main'} className="space-y-px">
            {group.heading && <div className="label-caps px-2.5 pb-1.5">{group.heading}</div>}
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + '/')
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'flex items-center gap-2.5 h-8 px-2.5 rounded-[6px] text-[13px] transition-colors duration-100',
                    active
                      ? 'bg-white font-medium text-[color:var(--apple-text-primary)] shadow-[0_0_0_1px_var(--apple-separator),0_1px_2px_rgba(24,24,27,0.05)]'
                      : 'text-[color:var(--apple-text-secondary)] hover:bg-[#F1F1EF] hover:text-[color:var(--apple-text-primary)]',
                  ].join(' ')}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" strokeWidth={active ? 2 : 1.75} aria-hidden="true"
                    style={{ color: active ? 'var(--apple-text-primary)' : 'var(--apple-text-tertiary)' }} />
                  {label}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Account */}
      <div className="px-4 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--apple-separator)' }}>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] truncate" style={{ color: 'var(--apple-text-primary)' }}>{email}</div>
          <div className="text-[11px]" style={{ color: 'var(--apple-text-tertiary)' }}>{role === 'admin' ? 'Admin' : 'Member'}</div>
        </div>
        <form action="/auth/signout" method="post">
          <button type="submit" title="Sign out"
            className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] hover:bg-[#F1F1EF]"
            style={{ color: 'var(--apple-text-tertiary)' }}>
            <LogOut className="w-4 h-4" aria-hidden="true" />
            <span className="sr-only">Sign out</span>
          </button>
        </form>
      </div>
    </aside>
  )
}
